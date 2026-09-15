// Report-builder definition types + validation (#43 Report Builder, Slice 0). PURE module — types +
// hand-rolled validation only, ZERO runtime deps (no zod, no prisma, no session) — so it is safe in
// BOTH the client builder bundle and the server runner, and drops into any of the 13 FCR apps
// unchanged (the portability requirement). A ReportDefinition is validated against a ClientReportObject
// (the viewer's permission-filtered field metadata, produced server-side by the registry) on every
// WRITE and every RUN, so a crafted definition can never reference a field the viewer wasn't offered.
//
// Ported from the SC Shop report builder; the only change is the outer shape check — scshop used a zod
// schema, this hand-rolls the same strict shape validation so the module stays dependency-free.
/** The single source of truth for "is this a numeric column" — right-aligned + numeric-sorted in the
 *  grid, summable in aggregates. Both the definition-driven runner and the canned-report framework consume
 *  this so a future numeric type can't be added to one grid and forgotten in the other. */
const NUMERIC_TYPES = new Set(["number", "money"]);
export function isNumericType(type) {
    return NUMERIC_TYPES.has(type);
}
// Single source of truth for the operator vocabulary: the FilterOperator union AND the runtime
// membership Set (FILTER_OPERATORS, below) both derive from this one list, so adding an operator can't
// silently desync them. (OPERATORS_BY_TYPE separately declares which of these are legal per field type.)
export const ALL_OPERATORS = ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "isNull", "notNull", "in"];
/** Which operators are legal for each field type. The builder offers only these; the validator
 *  rejects anything else. `isNull`/`notNull` take no value; `in` takes a list; the rest take one. */
export const OPERATORS_BY_TYPE = {
    string: ["eq", "neq", "contains", "isNull", "notNull"],
    number: ["eq", "neq", "gt", "gte", "lt", "lte", "isNull", "notNull"],
    money: ["eq", "neq", "gt", "gte", "lt", "lte", "isNull", "notNull"],
    date: ["eq", "gt", "gte", "lt", "lte", "isNull", "notNull"],
    boolean: ["eq", "isNull", "notNull"],
    // `in` ("is any of") is intentionally omitted: the builder has no multi-select value editor yet, so
    // an `in` filter could never be built or run (it would fail validation). Re-add it here the moment a
    // multi-select control lands in FilterValue.
    enum: ["eq", "neq", "isNull", "notNull"],
};
export const VALUELESS_OPERATORS = new Set(["isNull", "notNull"]);
const MAX_FILTER_LOGIC = 200;
function tokenizeLogic(s) {
    return s.replace(/\(/g, " ( ").replace(/\)/g, " ) ").trim().split(/\s+/).filter(Boolean);
}
/**
 * Parse "1 AND (2 OR 3)" into an AST, validating: only AND/OR/NOT/parens/filter-numbers, balanced
 * parens, and every number in 1..count. Pure — used by the validator (reject bad logic) and the runner
 * (build the WHERE tree). Recursive descent: OR is lowest precedence, then AND, then NOT/parens/number.
 */
export function parseFilterLogic(logic, count) {
    const toks = tokenizeLogic(logic);
    if (toks.length === 0)
        return { ok: false, error: "empty filter logic" };
    let i = 0;
    const peek = () => toks[i];
    const up = (t) => (t == null ? t : t.toUpperCase());
    const fail = (m) => {
        throw new Error(m);
    };
    const parseExpr = () => {
        let left = parseTerm();
        while (up(peek()) === "OR") {
            i++;
            left = { op: "or", left, right: parseTerm() };
        }
        return left;
    };
    const parseTerm = () => {
        let left = parseFactor();
        while (up(peek()) === "AND") {
            i++;
            left = { op: "and", left, right: parseFactor() };
        }
        return left;
    };
    const parseFactor = () => {
        const t = peek();
        if (t === undefined)
            return fail("unexpected end of filter logic");
        if (up(t) === "NOT") {
            i++;
            return { op: "not", child: parseFactor() };
        }
        if (t === "(") {
            i++;
            const e = parseExpr();
            if (peek() !== ")")
                return fail("missing )");
            i++;
            return e;
        }
        if (up(t) === "AND" || up(t) === "OR" || t === ")")
            return fail(`unexpected '${t}' in filter logic`);
        if (/^\d+$/.test(t)) {
            const n = parseInt(t, 10);
            if (n < 1 || n > count)
                return fail(`filter ${n} is out of range (1-${count})`);
            i++;
            return { op: "num", n };
        }
        return fail(`unexpected token '${t}' in filter logic`);
    };
    try {
        const ast = parseExpr();
        if (i < toks.length)
            return { ok: false, error: `unexpected '${toks[i]}' in filter logic` };
        return { ok: true, ast };
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "invalid filter logic" };
    }
}
// The row cap the runner applies (shared so the UI can message it). Summaries are computed over this
// capped window; a report exceeding it is flagged `truncated` rather than silently under-counting.
export const REPORT_ROW_CAP = 5000;
// The row cap the CSV EXPORT path applies — much higher than the on-screen grid cap, so a shared file is
// the full extract rather than the first 5000 rows. It is a backstop, not a UI limit: every real fcr_core
// object is small (the largest, trucks, is ~4k rows), so this never bites live data; it only bounds a
// runaway generic query, and if it ever IS hit the `truncated` flag + the CSV's trailing NOTE still fire.
export const EXPORT_ROW_CAP = 100_000;
// Definition-size caps: a definition is authenticated-user input that's both run AND persisted, so bound
// each array so nobody can POST a 50k-column/filter definition → a giant WHERE/SELECT + bloated stored
// JSON. Generous vs. any real report.
export const MAX_COLUMNS = 60;
export const MAX_FILTERS = 40;
export const MAX_SUMMARIES = 20;
// ── Shape validation (hand-rolled; replaces scshop's zod schema, same strict semantics) ──────────
// Runtime membership check for shape validation — derived from the one ALL_OPERATORS list above, so it
// can never drift from the FilterOperator union.
const FILTER_OPERATORS = new Set(ALL_OPERATORS);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
/** Reject any key on `o` outside `allowed` (the strict-schema behaviour: unknown keys don't get
 *  silently carried into the stored JSON). */
function rejectUnknownKeys(o, allowed, where, errors) {
    for (const k of Object.keys(o)) {
        if (!allowed.includes(k))
            errors.push(`${where}: unexpected key '${k}'`);
    }
}
/**
 * Strict shape parse of a raw (client- or DB-sourced) value into a RawDefinition, mirroring scshop's
 * zod schema: types enforced, unknown keys rejected, arrays size-capped, `filters`/`summaries` default
 * to []. Returns typed data or a list of shape errors. Never throws.
 */
function parseRawDefinition(raw) {
    const errors = [];
    if (!isObject(raw))
        return { ok: false, errors: ["definition must be an object"] };
    rejectUnknownKeys(raw, ["object", "columns", "filters", "filterLogic", "groupBy", "summaries", "sort"], "definition", errors);
    if (!isNonEmptyString(raw.object))
        errors.push("object: required non-empty string");
    const columns = [];
    if (raw.columns === undefined) {
        errors.push("columns: required");
    }
    else if (!Array.isArray(raw.columns)) {
        errors.push("columns: must be an array");
    }
    else if (raw.columns.length > MAX_COLUMNS) {
        errors.push(`columns: at most ${MAX_COLUMNS}`);
    }
    else {
        raw.columns.forEach((c, idx) => {
            if (!isNonEmptyString(c))
                errors.push(`columns[${idx}]: must be a non-empty string`);
            else
                columns.push(c);
        });
    }
    const filters = [];
    if (raw.filters !== undefined) {
        if (!Array.isArray(raw.filters)) {
            errors.push("filters: must be an array");
        }
        else if (raw.filters.length > MAX_FILTERS) {
            errors.push(`filters: at most ${MAX_FILTERS}`);
        }
        else {
            raw.filters.forEach((f, idx) => {
                if (!isObject(f)) {
                    errors.push(`filters[${idx}]: must be an object`);
                    return;
                }
                rejectUnknownKeys(f, ["field", "op", "value"], `filters[${idx}]`, errors);
                if (!isNonEmptyString(f.field))
                    errors.push(`filters[${idx}].field: required non-empty string`);
                if (typeof f.op !== "string" || !FILTER_OPERATORS.has(f.op))
                    errors.push(`filters[${idx}].op: invalid operator`);
                const v = f.value;
                const valueOk = v === undefined ||
                    v === null ||
                    typeof v === "string" ||
                    (Array.isArray(v) && v.every((x) => typeof x === "string"));
                if (!valueOk)
                    errors.push(`filters[${idx}].value: must be a string, string[], or null`);
                if (isNonEmptyString(f.field) && typeof f.op === "string" && FILTER_OPERATORS.has(f.op) && valueOk) {
                    filters.push({ field: f.field, op: f.op, value: v });
                }
            });
        }
    }
    let filterLogic;
    if (raw.filterLogic !== undefined && raw.filterLogic !== null) {
        if (typeof raw.filterLogic !== "string")
            errors.push("filterLogic: must be a string");
        else if (raw.filterLogic.length > MAX_FILTER_LOGIC)
            errors.push(`filterLogic: at most ${MAX_FILTER_LOGIC} chars`);
        else
            filterLogic = raw.filterLogic;
    }
    else {
        filterLogic = raw.filterLogic;
    }
    let groupBy;
    if (raw.groupBy !== undefined && raw.groupBy !== null) {
        if (!isObject(raw.groupBy)) {
            errors.push("groupBy: must be an object");
        }
        else {
            rejectUnknownKeys(raw.groupBy, ["field", "bucket"], "groupBy", errors);
            if (!isNonEmptyString(raw.groupBy.field))
                errors.push("groupBy.field: required non-empty string");
            const bucket = raw.groupBy.bucket;
            if (bucket !== undefined && !(bucket === "day" || bucket === "month" || bucket === "year")) {
                errors.push("groupBy.bucket: must be day|month|year");
            }
            if (isNonEmptyString(raw.groupBy.field)) {
                groupBy = { field: raw.groupBy.field, bucket: bucket };
            }
        }
    }
    else {
        groupBy = raw.groupBy;
    }
    const summaries = [];
    if (raw.summaries !== undefined) {
        if (!Array.isArray(raw.summaries)) {
            errors.push("summaries: must be an array");
        }
        else if (raw.summaries.length > MAX_SUMMARIES) {
            errors.push(`summaries: at most ${MAX_SUMMARIES}`);
        }
        else {
            raw.summaries.forEach((s, idx) => {
                if (!isObject(s)) {
                    errors.push(`summaries[${idx}]: must be an object`);
                    return;
                }
                rejectUnknownKeys(s, ["field", "agg"], `summaries[${idx}]`, errors);
                const aggOk = s.agg === "sum" || s.agg === "avg" || s.agg === "count" || s.agg === "min" || s.agg === "max";
                if (!isNonEmptyString(s.field))
                    errors.push(`summaries[${idx}].field: required non-empty string`);
                if (!aggOk)
                    errors.push(`summaries[${idx}].agg: must be sum|avg|count|min|max`);
                if (isNonEmptyString(s.field) && aggOk)
                    summaries.push({ field: s.field, agg: s.agg });
            });
        }
    }
    let sort;
    if (raw.sort !== undefined && raw.sort !== null) {
        if (!isObject(raw.sort)) {
            errors.push("sort: must be an object");
        }
        else {
            rejectUnknownKeys(raw.sort, ["field", "dir"], "sort", errors);
            const dirOk = raw.sort.dir === "asc" || raw.sort.dir === "desc";
            if (!isNonEmptyString(raw.sort.field))
                errors.push("sort.field: required non-empty string");
            if (!dirOk)
                errors.push("sort.dir: must be asc|desc");
            if (isNonEmptyString(raw.sort.field) && dirOk)
                sort = { field: raw.sort.field, dir: raw.sort.dir };
        }
    }
    else {
        sort = raw.sort;
    }
    if (errors.length)
        return { ok: false, errors };
    return {
        ok: true,
        data: {
            object: raw.object,
            columns,
            filters,
            filterLogic,
            groupBy,
            summaries,
            sort,
        },
    };
}
/**
 * Validate a raw (client- or DB-sourced) definition against the viewer's ClientReportObject. The
 * object's `fields` are ALREADY permission-filtered for this viewer by the registry, so validating field
 * references against it is the field-level security floor: a viewer can never select, filter, group,
 * summarize, or sort by a field they weren't offered. Returns a clean typed definition or a list of
 * human-readable errors (surfaced in the builder). Never throws on bad input.
 */
export function validateDefinition(raw, obj) {
    const parsed = parseRawDefinition(raw);
    if (!parsed.ok) {
        return { ok: false, errors: parsed.errors };
    }
    const d = parsed.data;
    const errors = [];
    if (d.object !== obj.key)
        errors.push(`object mismatch: ${d.object} != ${obj.key}`);
    const byKey = new Map(obj.fields.map((f) => [f.key, f]));
    const field = (key) => byKey.get(key);
    const isSummary = d.summaries.length > 0;
    // Columns: required in tabular mode; each must exist. (In summary mode columns are ignored — the
    // result is group + aggregates — but we still reject unknown keys so stored defs stay coherent.)
    if (!isSummary && d.columns.length === 0) {
        errors.push("select at least one column");
    }
    for (const c of d.columns) {
        if (!field(c))
            errors.push(`unknown column: ${c}`);
    }
    // Filters: field exists + filterable; operator legal for the field's type; value presence matches
    // the operator (valueless ops take none; `in` takes a non-empty list; others take a scalar).
    for (const f of d.filters) {
        const meta = field(f.field);
        if (!meta) {
            errors.push(`unknown filter field: ${f.field}`);
            continue;
        }
        if (!meta.filterable)
            errors.push(`field not filterable: ${f.field}`);
        if (!OPERATORS_BY_TYPE[meta.type].includes(f.op)) {
            errors.push(`operator ${f.op} not allowed on ${f.field} (${meta.type})`);
        }
        if (VALUELESS_OPERATORS.has(f.op)) {
            // no value expected — ignore any provided
        }
        else if (f.op === "in") {
            // INERT in v1: OPERATORS_BY_TYPE lists no `in` for any field type, so the operator-legality check
            // above has already recorded an error for any `in` filter — this branch still runs, but cannot
            // change the pass/fail outcome. Kept as a forward hook — it activates when `in` is re-added to
            // OPERATORS_BY_TYPE (which needs a multi-select value control). The `in` arm of the enum-value
            // check below is inert for the same reason.
            if (!Array.isArray(f.value) || f.value.length === 0)
                errors.push(`filter ${f.field}: 'in' needs a non-empty list`);
        }
        else {
            if (f.value == null || Array.isArray(f.value) || String(f.value).trim() === "") {
                errors.push(`filter ${f.field}: '${f.op}' needs a value`);
            }
            else if (meta.type === "date" && typeof f.value === "string" && Number.isNaN(new Date(f.value).getTime())) {
                // Reject an unparseable date HERE — otherwise the runner's date range throws a RangeError while
                // building the WHERE (before the query try/catch), surfacing as a 500 instead of a clean error.
                errors.push(`filter ${f.field}: '${f.value}' is not a valid date`);
            }
            else if ((meta.type === "number" || meta.type === "money") && typeof f.value === "string" && !Number.isFinite(Number(f.value))) {
                // Reject a non-FINITE value HERE — else coerceParam binds NaN or ±Infinity. Postgres sorts NaN and
                // Infinity above all finite numerics, so `> Infinity` returns nothing and `< Infinity` returns
                // everything: a misleading result that looks like a successful report. Number.isFinite rejects
                // NaN, Infinity, -Infinity and "1e999" alike while accepting every real numeric string. Symmetric
                // with the date guard above.
                errors.push(`filter ${f.field}: '${f.value}' is not a number`);
            }
            else if (meta.type === "boolean" && typeof f.value === "string" && f.value !== "true" && f.value !== "false") {
                // Reject anything but the exact 'true'/'false' HERE — else coerceParam (raw === "true") silently
                // coerces 'True'/'1'/'t'/a typo to JS false, binds it as a real boolean, and returns the wrong
                // (false) rows with no SQL error and a passing validation. Symmetric with the date/number guards.
                errors.push(`filter ${f.field}: '${f.value}' is not a boolean (expected 'true' or 'false')`);
            }
        }
        // Enum values must be within the offered set (defense in depth — the picker only shows these).
        if (meta.type === "enum" && meta.enumValues) {
            const vals = f.op === "in" ? (Array.isArray(f.value) ? f.value : []) : f.value != null && !Array.isArray(f.value) ? [f.value] : [];
            for (const v of vals)
                if (!meta.enumValues.includes(v))
                    errors.push(`filter ${f.field}: '${v}' is not a valid value`);
        }
    }
    // Filter logic (Salesforce-style): must parse, only reference in-range filters. Blank ⇒ all-AND.
    const logic = (d.filterLogic ?? "").trim();
    if (logic) {
        if (d.filters.length === 0)
            errors.push("filter logic set but there are no filters");
        else {
            const parsedLogic = parseFilterLogic(logic, d.filters.length);
            if (!parsedLogic.ok)
                errors.push(`filter logic: ${parsedLogic.error}`);
        }
    }
    // Group-by: field exists + groupable; bucket only on date fields.
    if (d.groupBy) {
        const meta = field(d.groupBy.field);
        if (!meta)
            errors.push(`unknown group-by field: ${d.groupBy.field}`);
        else {
            if (!meta.groupable)
                errors.push(`field not groupable: ${d.groupBy.field}`);
            if (d.groupBy.bucket && meta.type !== "date")
                errors.push(`bucket only applies to date fields, not ${d.groupBy.field}`);
        }
    }
    // Summaries: require a group-by (a summary report groups then aggregates). `count` needs no field;
    // sum/avg/min/max all require a summable (numeric/money) field — min/max over a non-numeric column
    // isn't meaningful here and would let a caller fabricate a 0 for an all-null group.
    if (isSummary && !d.groupBy)
        errors.push("a summary report needs a group-by");
    for (const s of d.summaries) {
        if (s.agg === "count")
            continue; // counts rows per group; field ignored
        const meta = field(s.field);
        if (!meta) {
            errors.push(`unknown summary field: ${s.field}`);
            continue;
        }
        if (!meta.summable)
            errors.push(`${s.agg} needs a numeric field: ${s.field}`);
    }
    // Sort: field exists. In tabular it must be a selected column; in summary it may be the group or a
    // summary key (validated loosely — the runner sorts what it has).
    if (d.sort) {
        const meta = field(d.sort.field);
        const isSummaryKey = isSummary && (d.sort.field === d.groupBy?.field || d.summaries.some((s) => summaryKey(s) === d.sort.field));
        if (isSummary) {
            // In summary mode the grouped result has ONLY the group column + the aggregate columns — a plain
            // registry field has no column there, so the runner would silently ignore the sort and fall back to
            // group-ascending. Require the sort to name the group field or a summary (mirrors the tabular branch,
            // which requires a SELECTED column).
            if (!isSummaryKey)
                errors.push(`summary sort field must be the group-by field or a summary: ${d.sort.field}`);
        }
        else {
            if (!meta)
                errors.push(`unknown sort field: ${d.sort.field}`);
            else if (!d.columns.includes(d.sort.field))
                errors.push(`sort field must be a selected column: ${d.sort.field}`);
        }
    }
    if (errors.length)
        return { ok: false, errors };
    return {
        ok: true,
        def: {
            object: d.object,
            columns: [...new Set(d.columns)], // dedupe — a column selected twice is one column
            filters: d.filters,
            filterLogic: logic || null,
            groupBy: d.groupBy ?? null,
            summaries: dedupeBy(d.summaries, summaryKey), // dedupe — two identical aggregates collapse to one column
            sort: d.sort ?? null,
        },
    };
}
/** Stable key a summary column is addressed by in the result + sort (e.g. "sum:amount", "count"). */
export function summaryKey(s) {
    return s.agg === "count" ? "count" : `${s.agg}:${s.field}`;
}
/** Keep the first item for each key() — order-preserving dedupe. */
function dedupeBy(items, key) {
    const seen = new Set();
    return items.filter((it) => {
        const k = key(it);
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
}
