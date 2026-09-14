// Report-builder runner (#43 Slice 1). Turns a validated ReportDefinition into a PARAMETERIZED SQL
// query and a render/CSV-ready result. Ported from the SC Shop runner, re-implemented for FCR's raw-SQL
// stack (@neondatabase/serverless `pool()`, no ORM).
//
// SECURITY — the load-bearing invariant (the injection floor, with definition.ts + registry.ts):
//   • A field IDENTIFIER only ever comes from the registry. The user's definition references field KEYS;
//     each key is validated against the viewer's permission-filtered field set (validateDefinition) and
//     then resolved here to a fixed registry `path`. No user-supplied string is ever concatenated into
//     the SQL as an identifier — only registry-authored paths are.
//   • Every user VALUE is a bound parameter ($1, $2, …). Nothing user-supplied reaches the SQL text.
//   • runReport ALWAYS applies, server-side and independent of the definition: (0) the object's baseWhere
//     (soft-delete + test-row exclusion), (1) the object capability gate against the REAL viewer, and
//     (2) owner-scope (when ownerField is set and the viewer isn't all-scope). A crafted definition can
//     neither widen the row set nor reach a field the viewer wasn't offered.
//
// Summaries are computed with an EXACT, UNCAPPED DB-side GROUP BY (a grouped query plus a separate
// grand-total query), so every count/sum/avg/min/max is correct regardless of row count — there is no
// summary row cap and no silent under-count. Only the TABULAR path caps rows (LIMIT REPORT_ROW_CAP + 1,
// flagged `truncated`). Aggregating over the LEFT JOIN is safe because each registry join is many-to-one
// (UNIQUE far-side key) and carries the base object's soft-delete/test-row exclusion in its ON clause.

import type { Queryable } from "../rbac/index.js";
import type { Principal } from "../contracts/index.js";
import { getObjectDef, toClientObject, type RegistryField, type RegistryObject } from "./registry-core.js";
import {
  validateDefinition,
  parseFilterLogic,
  summaryKey,
  isNumericType,
  REPORT_ROW_CAP,
  type FieldType,
  type ReportDefinition,
  type ReportFilter,
  type ReportSort,
  type DateBucket,
  type LogicNode,
} from "./definition.js";

export type ReportColumn = { key: string; label: string; type: FieldType; numeric: boolean };
export type CellValue = string | number | boolean | null;

export type TabularResult = {
  mode: "tabular";
  object: string;
  columns: ReportColumn[];
  rows: Record<string, CellValue>[];
  hrefs: (string | null)[];
  rowCount: number;
  truncated: boolean;
};

export type SummaryCell = number | null;
export type SummaryRow = { groupValue: string; values: Record<string, SummaryCell> };
export type SummaryResult = {
  mode: "summary";
  object: string;
  group: { key: string; label: string; bucket?: DateBucket };
  columns: ReportColumn[];
  rows: SummaryRow[];
  total: Record<string, SummaryCell>;
  rowCount: number;
  truncated: boolean;
};

export type ReportResult = TabularResult | SummaryResult;
export type RunOutcome = { ok: true; result: ReportResult } | { ok: false; errors: string[] };

const GROUP_NONE = "(none)";
const TIME_ZONE = "America/Chicago";

// ── SQL identifier construction (registry paths ONLY — never user input) ─────────────────────────

/** A safe SQL identifier from a registry-authored path segment. Registry paths are code, but we still
 *  hard-assert the shape (letters/digits/underscore) so a future malformed registry entry can never
 *  produce arbitrary SQL — the identifier floor is defence-in-depth, not a substitute for the registry. */
function ident(seg: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(seg)) throw new Error(`unsafe identifier: ${seg}`);
  return `"${seg}"`;
}

/** Column reference for a field's path. Own column ("status") → `"<base>"."status"`; one hop
 *  ("customer.sf_name") → `"customer"."sf_name"`. Split on a single "." (registry guarantees ≤ one hop). */
function colRef(obj: RegistryObject, field: RegistryField): string {
  if (!field.path) throw new Error(`field ${field.key} has neither path nor expr`); // registry bug (defence-in-depth)
  const parts = field.path.split(".");
  if (parts.length === 1) return `${ident(obj.key)}.${ident(parts[0]!)}`;
  return `${ident(parts[0]!)}.${ident(parts[1]!)}`;
}

/** The expression used for a `date` field, in both SELECT and WHERE/GROUP. A real `date` column is a
 *  no-op `::date`; a timestamptz-backed field (dateTz) is truncated to the America/Chicago calendar date
 *  so evening-local records aren't bucketed a day late. Returns 'yyyy-mm-dd' from Postgres. */
function dateExpr(ref: string, field: RegistryField): string {
  return field.dateTz ? `((${ref}) AT TIME ZONE '${TIME_ZONE}')::date` : `(${ref})::date`;
}

/** The SQL expression to SELECT / filter / group / aggregate a field by — the ONE field→SQL chokepoint.
 *  A computed field emits its registry-authored `expr` (parenthesized, trusted SQL — see RegistryField.expr);
 *  a plain field resolves to its column. EITHER WAY a `date` field then gets the same calendar-date
 *  normalization (`::date`, plus the America/Chicago conversion when `dateTz`), so a computed date field
 *  buckets and renders in the SAME timezone as every plain date column in the report — the grouping path
 *  (to_char) can rely on a normalized date regardless of source. (A `number` computed field like a
 *  day-count skips this and stays the bare expr.) */
function fieldExpr(obj: RegistryObject, field: RegistryField): string {
  const ref = field.expr ? `(${field.expr})` : colRef(obj, field);
  return field.type === "date" ? dateExpr(ref, field) : ref;
}

// ── Value coercion ───────────────────────────────────────────────────────────────────────────────

/** Render a raw DB cell to its typed value. @neondatabase/serverless returns numeric + date columns as
 *  strings, so number/money → Number, date → the 'yyyy-mm-dd' string as-is. */
function coerceCell(value: unknown, type: FieldType): CellValue {
  if (value == null) return null;
  if (type === "money" || type === "number") return Number(value);
  if (type === "boolean") return typeof value === "boolean" ? value : value === "true" || value === "t";
  return String(value);
}

/** Coerce a filter's raw string input to the JS type bound as a parameter for the field's type. */
function coerceParam(raw: string, type: FieldType): string | number | boolean {
  if (type === "money" || type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  return raw; // string / enum / date (bound then cast ::date in SQL)
}

// ── WHERE construction (parameterized) ───────────────────────────────────────────────────────────

/** A parameter accumulator: push a value, get back its `$n` placeholder. */
class Params {
  readonly values: unknown[] = [];
  push(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** One filter → a parameterized SQL boolean, or null if it produces nothing. The field's `expr` is a
 *  registry-authored identifier; every value goes through `p.push` as a bound parameter. */
function filterLeaf(obj: RegistryObject, meta: RegistryField, fil: ReportFilter, p: Params): string | null {
  const expr = fieldExpr(obj, meta);
  if (fil.op === "isNull") return `${expr} IS NULL`;
  if (fil.op === "notNull") return `${expr} IS NOT NULL`;
  if (fil.op === "in") {
    const list = Array.isArray(fil.value) ? fil.value : [];
    if (list.length === 0) return null;
    return `${expr} = ANY(${p.push(list)})`;
  }
  if (fil.value == null || Array.isArray(fil.value)) return null; // guarded by the validator

  if (meta.type === "date") {
    const ph = `${p.push(fil.value)}::date`;
    switch (fil.op) {
      case "eq": return `${expr} = ${ph}`;
      case "gt": return `${expr} > ${ph}`;
      case "gte": return `${expr} >= ${ph}`;
      case "lt": return `${expr} < ${ph}`;
      case "lte": return `${expr} <= ${ph}`;
      default: return null;
    }
  }

  const v = coerceParam(fil.value, meta.type);
  switch (fil.op) {
    case "eq": return `${expr} = ${p.push(v)}`;
    case "neq": return `${expr} <> ${p.push(v)}`;
    // Case-insensitive substring WITHOUT LIKE, so `%`/`_` in the value are literal, not wildcards, and
    // the value stays a bound parameter (never concatenated into the SQL).
    case "contains": return `position(lower(${p.push(v)}) in lower(${expr})) > 0`;
    case "gt": return `${expr} > ${p.push(v)}`;
    case "gte": return `${expr} >= ${p.push(v)}`;
    case "lt": return `${expr} < ${p.push(v)}`;
    case "lte": return `${expr} <= ${p.push(v)}`;
    default: return null;
  }
}

/** Fold a parsed filter-logic AST into a parameterized SQL boolean over the per-index filter clauses. A
 *  missing clause (a filter that produced nothing) becomes TRUE — neutral in the tree. */
function logicToSql(node: LogicNode, clauses: (string | null)[]): string {
  if (node.op === "num") return clauses[node.n - 1] ?? "TRUE";
  if (node.op === "not") return `(NOT ${logicToSql(node.child, clauses)})`;
  const op = node.op === "and" ? "AND" : "OR";
  return `(${logicToSql(node.left, clauses)} ${op} ${logicToSql(node.right, clauses)})`;
}

/** The 1-indexed filter positions a parsed filter-logic tree actually references. buildWhere binds a param
 *  ONLY for a filter that appears in the emitted SQL — an unreferenced filter (one the logic string omits)
 *  would otherwise push an orphan param, leaving `params` longer than the `$n` placeholders in the query,
 *  which Postgres rejects at bind time ("bind message supplies N parameters…"). A filter referenced twice
 *  (e.g. "1 AND 1") is still built once, so its single param matches its single `$n`. */
function collectRefs(node: LogicNode, out: Set<number> = new Set<number>()): Set<number> {
  if (node.op === "num") out.add(node.n);
  else if (node.op === "not") collectRefs(node.child, out);
  else {
    collectRefs(node.left, out);
    collectRefs(node.right, out);
  }
  return out;
}

export type WhereSql = { sql: string; params: unknown[] };

/**
 * The full WHERE: mandatory server-side scope (baseWhere + owner-scope) AND'd with the definition's
 * filters. Scope is applied here regardless of the definition — the security floor, not user-controllable.
 * The combined user-filter subtree is one AND element, so a user OR can never widen past the scope.
 */
export function buildWhere(
  obj: RegistryObject,
  def: ReportDefinition,
  fieldsByKey: Map<string, RegistryField>,
  principal: Principal,
): WhereSql {
  const p = new Params();
  const and: string[] = [];

  // (0) Object base filter — always applied (soft-delete + test-row exclusion). Trusted registry SQL.
  if (obj.baseWhere) and.push(`(${obj.baseWhere})`);

  // (1) Owner scope — when an object declares ownerField, a viewer sees only their own rows UNLESS a
  // seesAllCapability widens them. Default-deny: absent seesAllCapability ⇒ pinned (safer floor). v1
  // truck has no ownerField, so this whole block is skipped.
  const seesAll = obj.seesAllCapability ? obj.seesAllCapability(principal) : false;
  if (obj.ownerField && !seesAll) {
    and.push(`${ident(obj.key)}.${ident(obj.ownerField)} = ${p.push(principal.accountId)}`);
  }

  // (2) The definition's filters, combined by the (validated) filter logic. Build a leaf — and its bound
  // params — ONLY for a filter the combining logic actually references, so an omitted filter never pushes
  // an orphan param (params longer than the `$n` placeholders → Postgres rejects the bind). Pass the
  // AST-referenced set for an explicit filterLogic; omit it (⇒ build every filter) when the filters are
  // simply AND'd. Push order is filter-order either way, so a leaf's `$n` always matches its slot in `p`.
  const buildClauses = (referenced?: Set<number>): (string | null)[] =>
    def.filters.map((fil, i) => {
      if (referenced && !referenced.has(i + 1)) return null;
      const meta = fieldsByKey.get(fil.field);
      return meta ? filterLeaf(obj, meta, fil, p) : null;
    });

  const logic = def.filterLogic?.trim();
  let userWhere: string | null = null;

  if (logic && def.filters.length) {
    const parsed = parseFilterLogic(logic, def.filters.length);
    if (parsed.ok) userWhere = logicToSql(parsed.ast, buildClauses(collectRefs(parsed.ast)));
    // Unparseable filterLogic: apply no user filter (the validator rejects this before a run reaches here).
  } else {
    const present = buildClauses().filter((c): c is string => !!c);
    userWhere = present.length === 0 ? null : present.length === 1 ? present[0]! : `(${present.join(" AND ")})`;
  }
  if (userWhere) and.push(`(${userWhere})`);

  return { sql: and.length ? and.join(" AND ") : "TRUE", params: p.values };
}

// ── Query assembly ───────────────────────────────────────────────────────────────────────────────

function fromClause(obj: RegistryObject): string {
  return `${obj.table} ${ident(obj.key)}${obj.join ? ` ${obj.join.sql}` : ""}`;
}

/** Whether row hrefs are emitted for this object: the object declares a `link` AND (if it declares a
 *  `linkEnabled` runtime gate) that gate is currently true. Checked per run so a cutover flag is honored
 *  without a rebuild, and used for BOTH the SELECT (the `__id` column) and the result hrefs so they can't
 *  disagree. (Trailer's link is gated on RECORDS_TRAILER_LIVE; truck's is always active.) */
function linkActive(obj: RegistryObject): boolean {
  return !!obj.link && (obj.linkEnabled ? obj.linkEnabled() : true);
}

/** SELECT-list expr for a field, aliased by its key. */
function selectItem(obj: RegistryObject, field: RegistryField): string {
  return `${fieldExpr(obj, field)} AS ${ident(field.key)}`;
}

export type BuiltQuery = { sql: string; params: unknown[] };

/** Assemble the tabular SELECT (columns + the link id) with the +1 truncation probe. Exposed for tests. */
export function buildTabularQuery(
  obj: RegistryObject,
  def: ReportDefinition,
  fieldsByKey: Map<string, RegistryField>,
  principal: Principal,
): BuiltQuery {
  const cols = def.columns.map((k) => fieldsByKey.get(k)).filter((f): f is RegistryField => !!f);
  const items = cols.map((f) => selectItem(obj, f));
  if (linkActive(obj)) items.push(`${ident(obj.key)}.${ident(obj.link!.path)} AS ${ident("__id")}`);

  const where = buildWhere(obj, def, fieldsByKey, principal);

  let orderBy = "";
  if (def.sort) {
    const meta = fieldsByKey.get(def.sort.field);
    if (meta) orderBy = ` ORDER BY ${fieldExpr(obj, meta)} ${def.sort.dir === "desc" ? "DESC" : "ASC"}`;
  }

  const sql =
    `SELECT ${items.join(", ")} FROM ${fromClause(obj)} WHERE ${where.sql}${orderBy} LIMIT ${REPORT_ROW_CAP + 1}`;
  return { sql, params: where.params };
}

/** The SQL expression a summary groups by: a non-date field's column, or a date field bucketed to
 *  day / month / year in the field's zone ('yyyy-mm-dd' / 'yyyy-mm' / 'yyyy' text). */
function groupExpr(obj: RegistryObject, groupMeta: RegistryField, bucket: DateBucket | undefined): string {
  if (groupMeta.type !== "date") return fieldExpr(obj, groupMeta); // column OR a computed field's expr
  const d = fieldExpr(obj, groupMeta); // (...)::date
  if (bucket === "year") return `to_char(${d}, 'YYYY')`;
  if (bucket === "month") return `to_char(${d}, 'YYYY-MM')`;
  return `to_char(${d}, 'YYYY-MM-DD')`;
}

/** Double-quote a summaryKey (it contains a ':') for use as a SQL column alias. Components are validated
 *  (agg enum + registry field key), so this is safe; the replace() is belt-and-braces. */
function aggAlias(key: string): string {
  return `"${key.replace(/"/g, "")}"`;
}

/** The aggregate SELECT items for a summary — count(*) / sum|avg|min|max(col) — each an INDEPENDENT SQL
 *  aggregate aliased by its summaryKey. (sum and avg over the same field no longer share an accumulator:
 *  Postgres computes each separately, so a def with both is exact, not double-counted.) */
function aggSelectList(obj: RegistryObject, def: ReportDefinition, fieldsByKey: Map<string, RegistryField>): string[] {
  return def.summaries.map((s) => {
    const alias = aggAlias(summaryKey(s));
    if (s.agg === "count") return `count(*) AS ${alias}`;
    const meta = fieldsByKey.get(s.field)!; // numeric field (validator guarantees summable); column or computed expr
    return `${s.agg}(${fieldExpr(obj, meta)}) AS ${alias}`;
  });
}

/**
 * Exact, UNCAPPED summary via a real DB-side GROUP BY (replaces the earlier JS-aggregation-over-a-capped
 * window, which silently under-counted once a scoped set exceeded the row cap). Groups + aggregates are
 * computed in Postgres, so the result is correct regardless of cardinality. Exposed for tests.
 */
export function buildSummaryQuery(
  obj: RegistryObject,
  def: ReportDefinition,
  fieldsByKey: Map<string, RegistryField>,
  principal: Principal,
  where: WhereSql = buildWhere(obj, def, fieldsByKey, principal),
): BuiltQuery {
  const aggs = aggSelectList(obj, def, fieldsByKey);
  const groupMeta = def.groupBy ? fieldsByKey.get(def.groupBy.field) : undefined;
  const gexpr = groupMeta ? groupExpr(obj, groupMeta, def.groupBy?.bucket) : "NULL";
  // No SQL ORDER BY: buildSummaryResult always re-sorts the groups in JS (sortSummaryRows), so a DB-side
  // order would just be discarded (and could disagree, localeCompare vs SQL collation). GROUP BY only.
  const sql = `SELECT ${gexpr} AS grp, ${aggs.join(", ")} FROM ${fromClause(obj)} WHERE ${where.sql} GROUP BY 1`;
  return { sql, params: where.params };
}

/** The grand-total aggregate row (same WHERE, no GROUP BY) — one exact row over the whole scoped set.
 *  Computed by its own query so the total avg is exact (not derivable from per-group avgs). Pass the
 *  shared `where` so the scoped WHERE is built once per run, not once per query. */
export function buildSummaryTotalQuery(
  obj: RegistryObject,
  def: ReportDefinition,
  fieldsByKey: Map<string, RegistryField>,
  principal: Principal,
  where: WhereSql = buildWhere(obj, def, fieldsByKey, principal),
): BuiltQuery {
  const aggs = aggSelectList(obj, def, fieldsByKey);
  const sql = `SELECT ${aggs.join(", ")} FROM ${fromClause(obj)} WHERE ${where.sql}`;
  return { sql, params: where.params };
}

// ── Validation + run ─────────────────────────────────────────────────────────────────────────────

export type ValidatedReport = { ok: true; obj: RegistryObject; def: ReportDefinition } | { ok: false; errors: string[] };

/**
 * Resolve + gate + validate a definition for a viewer WITHOUT running a query. Gates the object against
 * the REAL viewer and validates the definition against the viewer's permission-filtered field set (the
 * field-level floor). Shared by runReport and the save action so identical authorization runs whether a
 * report is run or merely saved.
 */
export function validateReport(raw: unknown, principal: Principal, catalog: RegistryObject[]): ValidatedReport {
  const rawKey = typeof raw === "object" && raw !== null ? (raw as { object?: unknown }).object : undefined;
  if (typeof rawKey !== "string") return { ok: false, errors: ["missing object"] };
  const obj = getObjectDef(catalog, rawKey);
  if (!obj || !obj.capability(principal)) return { ok: false, errors: ["object not available"] };
  const validated = validateDefinition(raw, toClientObject(obj, principal));
  if (!validated.ok) return { ok: false, errors: validated.errors };
  return { ok: true, obj, def: validated.def };
}

/** Validate + run a report for a viewer. Never trusts the definition for scoping. `db` is the injected
 *  query surface (any @fcr/core `Queryable` — the app passes its `pool()`) and `catalog` is the app's
 *  reportable-object registry (the app passes its `REPORT_OBJECTS`). Keeping BOTH the DB handle and the
 *  catalog parameters, not imports, is what makes this engine app-agnostic and lift-ready into
 *  @fcr/core/reports — it imports no app module. */
export async function runReport(raw: unknown, principal: Principal, db: Queryable, catalog: RegistryObject[]): Promise<RunOutcome> {
  const validated = validateReport(raw, principal, catalog);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const { obj, def } = validated;
  const fieldsByKey = new Map(obj.fields.map((f) => [f.key, f]));

  try {
    if (def.summaries.length > 0) {
      const where = buildWhere(obj, def, fieldsByKey, principal); // build the scoped WHERE once, share it
      const gq = buildSummaryQuery(obj, def, fieldsByKey, principal, where);
      const tq = buildSummaryTotalQuery(obj, def, fieldsByKey, principal, where);
      const [grouped, total] = await Promise.all([
        db.query<Record<string, unknown>>(gq.sql, gq.params),
        db.query<Record<string, unknown>>(tq.sql, tq.params),
      ]);
      return { ok: true, result: buildSummaryResult(obj, def, fieldsByKey, grouped.rows, total.rows[0]) };
    }
    const q = buildTabularQuery(obj, def, fieldsByKey, principal);
    const { rows } = await db.query<Record<string, unknown>>(q.sql, q.params);
    const truncated = rows.length > REPORT_ROW_CAP;
    return { ok: true, result: buildTabular(obj, def, fieldsByKey, truncated ? rows.slice(0, REPORT_ROW_CAP) : rows, truncated) };
  } catch (err) {
    // Log the DB error server-side only and return a FIXED generic message — a raw Postgres error can echo
    // table/column/constraint names or the offending literal, an info-disclosure hook once non-admin /
    // owner-scoped viewers can run reports.
    console.error("[reports] runReport query error:", err);
    return { ok: false, errors: ["the report could not run"] };
  }
}

// ── Result shaping ───────────────────────────────────────────────────────────────────────────────

function buildTabular(
  obj: RegistryObject,
  def: ReportDefinition,
  fieldsByKey: Map<string, RegistryField>,
  rows: Record<string, unknown>[],
  truncated: boolean,
): TabularResult {
  const columns: ReportColumn[] = def.columns
    .map((k) => fieldsByKey.get(k))
    .filter((f): f is RegistryField => !!f)
    .map((f) => ({ key: f.key, label: f.label, type: f.type, numeric: isNumericType(f.type) }));

  const out: Record<string, CellValue>[] = [];
  const hrefs: (string | null)[] = [];
  const linked = linkActive(obj); // per-run; matches the `__id` SELECT gate in buildTabularQuery
  for (const row of rows) {
    const rec: Record<string, CellValue> = {};
    for (const c of columns) rec[c.key] = coerceCell(row[c.key], c.type);
    out.push(rec);
    if (linked) {
      const idVal = row["__id"];
      hrefs.push(idVal != null ? obj.link!.href(String(idVal)) : null);
    } else {
      hrefs.push(null);
    }
  }
  return { mode: "tabular", object: obj.key, columns, rows: out, hrefs, rowCount: out.length, truncated };
}

function summaryLabel(agg: string, fieldLabel: string | undefined): string {
  if (agg === "count") return "Count";
  const verb = agg === "sum" ? "Sum of" : agg === "avg" ? "Avg of" : agg === "min" ? "Min of" : "Max of";
  return `${verb} ${fieldLabel ?? ""}`.trim();
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function summaryColumns(def: ReportDefinition, fieldsByKey: Map<string, RegistryField>): ReportColumn[] {
  return def.summaries.map((s) => {
    const meta = s.agg === "count" ? undefined : fieldsByKey.get(s.field);
    const type: FieldType = s.agg !== "count" && meta?.type === "money" ? "money" : "number";
    return { key: summaryKey(s), label: summaryLabel(s.agg, meta?.label), type, numeric: true };
  });
}

export function sortSummaryRows(
  rows: SummaryRow[],
  columns: ReportColumn[],
  sort: ReportSort | null | undefined,
  groupKey?: string,
): SummaryRow[] {
  const dir = sort?.dir === "desc" ? -1 : 1;
  // Sort by the group column (validateDefinition accepts group-field as a summary sort). The group key
  // is NOT among `columns` (those are the aggregates), so this must be handled before the aggregate case
  // — otherwise it fell through to an always-ascending default, discarding sort.dir.
  if (sort && groupKey && sort.field === groupKey) {
    return [...rows].sort((a, b) => a.groupValue.localeCompare(b.groupValue) * dir);
  }
  if (sort && columns.some((c) => c.key === sort.field)) {
    const key = sort.field;
    return [...rows].sort((a, b) => ((a.values[key] ?? 0) - (b.values[key] ?? 0)) * dir);
  }
  return [...rows].sort((a, b) => a.groupValue.localeCompare(b.groupValue));
}

/** Read a DB aggregate row (a GROUP BY row or the grand-total row) into summaryKey → value. sum over no
 *  rows is 0; avg/min/max with no contributing value is null ("—"), never a fabricated 0. Numeric columns
 *  come back from @neondatabase/serverless as strings, so Number() them. */
function readAgg(row: Record<string, unknown>, def: ReportDefinition): Record<string, SummaryCell> {
  const v: Record<string, SummaryCell> = {};
  for (const s of def.summaries) {
    const key = summaryKey(s);
    const raw = row[key];
    if (s.agg === "count") v[key] = raw == null ? 0 : Number(raw);
    else if (s.agg === "sum") v[key] = raw == null ? 0 : round2(Number(raw));
    else if (s.agg === "avg") v[key] = raw == null ? null : round2(Number(raw));
    else v[key] = raw == null ? null : Number(raw); // min / max
  }
  return v;
}

/** Shape the DB-side GROUP BY output (grouped rows + the grand-total row) into a SummaryResult. Exact and
 *  uncapped — every total is computed by Postgres, so `truncated` is always false. */
function buildSummaryResult(
  obj: RegistryObject,
  def: ReportDefinition,
  fieldsByKey: Map<string, RegistryField>,
  groupedRows: Record<string, unknown>[],
  totalRow: Record<string, unknown> | undefined,
): SummaryResult {
  const groupMeta = def.groupBy ? fieldsByKey.get(def.groupBy.field) : undefined;
  const bucket = def.groupBy?.bucket;
  const columns = summaryColumns(def, fieldsByKey);

  const rows: SummaryRow[] = groupedRows.map((r) => {
    const g = r["grp"];
    const groupValue = g == null || g === "" ? GROUP_NONE : String(g);
    return { groupValue, values: readAgg(r, def) };
  });

  return {
    mode: "summary",
    object: obj.key,
    group: { key: groupMeta?.key ?? "", label: groupMeta?.label ?? "", ...(bucket ? { bucket } : {}) },
    columns,
    rows: sortSummaryRows(rows, columns, def.sort, groupMeta?.key),
    total: totalRow ? readAgg(totalRow, def) : {},
    rowCount: rows.length,
    truncated: false,
  };
}
