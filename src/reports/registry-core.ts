// Report-registry CORE — the app-agnostic half of the registry (#99 Slice A: registry inversion, the
// prework that makes the engine liftable into @fcr/core/reports). This holds the registry TYPES and the
// generic gating/lookup helpers that are pure over a catalog + the shared RBAC can(); the app-specific
// reportable-object CATALOG (the truck/trailer definitions + REPORT_OBJECTS) stays in ./registry.
//
// Nothing here imports an app module: can() comes from @fcr/core/rbac (already shared), Principal from
// @fcr/core/contracts, and the field/client types from ./definition (itself app-agnostic). The catalog is
// passed IN (getObjectDef/objectsForViewer take it as a parameter) rather than imported, mirroring how the
// runner takes an injected db: Queryable — so this file lifts into @fcr/core/reports unchanged in Slice B.
//
// GATING (both through the shared can()):
//   • OBJECT gate (`capability`) — may this principal report on the object at all (v1 admin-only).
//   • FIELD gate — each `sensitive` field is offered only when can('view', <objectKey>, {section, field})
//     allows. Because toClientObject drops a denied field, the validator + runner + CSV never surface it.

import { can } from "../rbac/index.js";
import type { Principal } from "../contracts/index.js";
import type { ClientReportObject, FieldType, ReportFieldMeta } from "./definition.js";

/** Server-only wiring common to every reportable field (the source of the SQL is added by the union below). */
type RegistryFieldWiring = ReportFieldMeta & {
  /** UI + gating grouping (e.g. "identity" | "pickup" | "delivery" | "financials"). */
  section: string;
  /** Sensitive (financial/internal) — offered only when the per-field can('view', <obj>,
   *  {section, field}) check holds for the principal. */
  sensitive?: boolean;
  /** For a `date` field whose underlying column/expr is `timestamptz` (not a plain `date`): the runner
   *  truncates it to the America/Chicago calendar date for day-granular filtering/grouping/rendering,
   *  so an evening-local record isn't bucketed a day late. Omit for real `date` values (no-op). */
  dateTz?: boolean;
};

/**
 * One reportable field (client metadata + server wiring). EXACTLY ONE of `path` (a real column) or `expr`
 * (a computed SQL expression) — enforced at compile time by the discriminated union, so a catalog author
 * can't leave both or neither. `colRef`/`fieldExpr` also throw at runtime as defence-in-depth.
 */
export type RegistryField = RegistryFieldWiring &
  (
    | {
        /**
         * SQL column path, at most ONE relation hop. Own column ⇒ the bare column name (the runner qualifies
         * it with the object's table alias, e.g. "status" → truck.status). One-hop ⇒ "<joinAlias>.<column>"
         * (e.g. "customer.sf_name"). Split on a single "." — no deeper paths (matches the one-join-hop runner).
         */
        path: string;
        expr?: never;
      }
    | {
        /**
         * A COMPUTED field: a raw SQL expression used wherever a `path` field would use its column — SELECT,
         * WHERE, ORDER BY, GROUP BY, aggregates (the runner routes every field→SQL through one chokepoint).
         * Write a BARE expression (the engine parenthesizes it once for safe composition), e.g.
         * "timezone('America/Chicago', now())::date - trailer.status_date". A `date`-typed computed field is
         * still run through the calendar-date normalization (set `dateTz` if the expr yields a timestamptz),
         * so it buckets/renders in the same timezone as plain date columns.
         *
         * ⚠ TRUSTED SQL, registry-authored ONLY — the SAME trust boundary the engine already grants `baseWhere`
         * and `join.sql`. Emitted verbatim (parenthesized), NOT run through the identifier floor, so it MUST be
         * written by the registry (code), NEVER assembled from user input. The user's report definition only
         * ever names a field KEY, validated against the offered set; the key resolves to this expr here.
         */
        expr: string;
        path?: never;
      }
  );

export type RegistryObject = {
  key: string;
  label: string;
  description?: string;
  /** Base table, schema-qualified. Aliased in SQL as the object key (so own paths qualify cleanly). */
  table: string;
  /**
   * Optional single relation hop. `alias` is what one-hop field paths reference; `sql` is the exact
   * LEFT JOIN clause the runner appends verbatim (fixed, no user input). One hop only.
   * ⚠ RULE: the join's far side must be MANY-TO-ONE (its ON-key UNIQUE) or a LEFT JOIN duplicates base
   * rows and inflates count/sum, AND the ON clause MUST carry the same soft-delete/test-row exclusion as
   * baseWhere (`AND <alias>.deleted_at IS NULL AND <alias>.is_test = false`) — in the ON, not a WHERE, to
   * keep LEFT JOIN semantics — so a deleted/test dimension row can't leak into or mis-bucket a report.
   */
  join?: { alias: string; sql: string };
  /**
   * MANDATORY base filter AND'd into every query for this object, regardless of viewer/definition — a
   * fixed SQL boolean fragment with NO parameters. Always excludes soft-deleted + test fixtures.
   */
  baseWhere: string;
  /** Base gate — may this principal report on this object at all. */
  capability: (p: Principal) => boolean;
  /**
   * Own scalar column to AND-filter by the viewer when they lack whole-object scope (row-level scope).
   * null ⇒ shared data every permitted role sees in full (v1: admins are all-scope, so null here).
   */
  ownerField?: string | null;
  /**
   * Row-scope widening: a principal that passes this sees EVERY row even when `ownerField` is set
   * (never widens columns — sensitive fields stay gated). When `ownerField` is set, ABSENT ⇒ every
   * viewer is pinned to their own rows (default-deny floor). Irrelevant when `ownerField` is null (the
   * v1 truck case: nothing is owner-pinned). Forward hook for per-owner objects.
   */
  seesAllCapability?: (p: Principal) => boolean;
  /** Record hyperlink for tabular rows: `path` is the id column, `href(id)` builds the detail URL. */
  link?: { path: string; href: (id: string) => string };
  /**
   * Optional runtime gate for `link`. When present, the runner emits row hrefs ONLY when this returns
   * true — checked PER RUN (runReport is per-request), so a cutover flag toggle is honored without a
   * rebuild. Absent ⇒ the link is always active.
   */
  linkEnabled?: () => boolean;
  fields: RegistryField[];
};

// ── Gating predicates ──────────────────────────────────────────────────────────────────────────────

/** The same admin derivation auth.ts uses for isAdmin: a coarse ('*','admin','all') grant. v1 report
 *  access is admin-only, so this is both the object gate and (for now) the sensitive-field gate. */
export const isAdmin = (p: Principal): boolean => can(p, "admin", "*").allowed;

/** Whether one sensitive field is offered to this principal — the per-field RBAC gate.
 *  can() DEFAULT-DENYs, so a field is offered only when a grant covers it: admin's wildcard (section/
 *  field NULL) covers every field (inert for admins), a can('view', <obj>, {section, field}) grant
 *  authorizes exactly this field, and a matching deny (DENY-WINS) hides it. */
function sensitiveFieldAllowed(obj: RegistryObject, field: RegistryField, principal: Principal): boolean {
  return can(principal, "view", obj.key, { section: field.section, field: field.key }).allowed;
}

/**
 * The client-safe, permission-FILTERED view of one object for a principal: strips server-only wiring
 * (path/sensitive) and DROPS sensitive fields the principal may not see. Because the validator checks a
 * definition against exactly this field set, a field not returned here can never be selected, filtered,
 * grouped, summarized, or sorted — the field-level security floor.
 */
export function toClientObject(obj: RegistryObject, principal: Principal): ClientReportObject {
  const fields: ReportFieldMeta[] = obj.fields
    .filter((fld) => !fld.sensitive || sensitiveFieldAllowed(obj, fld, principal))
    .map((fld) => ({
      key: fld.key,
      label: fld.label,
      type: fld.type,
      filterable: fld.filterable,
      groupable: fld.groupable,
      summable: fld.summable,
      ...(fld.enumValues ? { enumValues: fld.enumValues } : {}),
    }));
  return { key: obj.key, label: obj.label, description: obj.description, fields };
}

/** Every object in `catalog` this principal may report on, as client-safe filtered metadata (builder UI). */
export function objectsForViewer(catalog: RegistryObject[], principal: Principal): ClientReportObject[] {
  return catalog.filter((obj) => obj.capability(principal)).map((obj) => toClientObject(obj, principal));
}

/** The full server-side object def for the runner, looked up in `catalog`. Undefined for an unknown key. */
export function getObjectDef(catalog: RegistryObject[], key: string): RegistryObject | undefined {
  return catalog.find((obj) => obj.key === key);
}
