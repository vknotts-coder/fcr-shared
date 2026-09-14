// Field-builder helpers for the reportable-object catalog (lifted from fcr-dispatch's registry.ts, #107
// Slice 1). Terse, consistent constructors for RegistryField rows. Pure — types only, no server/DB import;
// safe in any bundle. The object CATALOGS (truck.ts / trailer.ts) use these to declare their field tables.
import { isNumericType } from "../reports/definition.js";
export const f = (type, key, label, section, opts = {}) => ({
    key,
    label,
    type,
    section,
    path: opts.path ?? key,
    filterable: opts.filterable ?? true,
    // isNumericType is the shared single-source-of-truth (definition.ts); reused here so a future numeric
    // FieldType can't desync this catalog's summable/groupable defaults from the runner/framework grids.
    groupable: opts.groupable ?? !isNumericType(type),
    summable: opts.summable ?? isNumericType(type),
    sensitive: opts.sensitive,
    enumValues: opts.enumValues,
});
export const str = (key, label, section, path) => f("string", key, label, section, { path, summable: false });
export const dateF = (key, label, section, path) => f("date", key, label, section, { path, summable: false });
// A `date` field backed by a `timestamptz` column (America/Chicago local-date semantics in the runner).
export const dateTzF = (key, label, section, path) => ({ ...dateF(key, label, section, path), dateTz: true });
export const numF = (key, label, section, path) => f("number", key, label, section, { path });
export const money = (key, label, section, sensitive = true, path) => f("money", key, label, section, { path, sensitive, groupable: false });
// A boolean field (OPERATORS_BY_TYPE boolean: eq / isNull / notNull). Groupable (true/false buckets), not summable.
export const bool = (key, label, section, path) => f("boolean", key, label, section, { path, summable: false });
// The central-tz (America/Chicago) calendar TODAY as a SQL date — the basis for every now()-relative computed
// field (day-counts, turn-times), so a tz-basis change is ONE edit. Matches the record page's dayDiff so
// counts don't drift a day in the evening (UTC).
export const tzToday = "timezone('America/Chicago', now())::date";
// An SF turn-time duration: `IF(ISBLANK(end), TODAY()-start, end-start)` → elapsed-so-far when the end date is
// missing, else the completed span. Args are qualified column refs (e.g. "trailer.delivery_date"). Postgres
// `date - date` = whole days and `date - NULL` = NULL, so a null start yields NULL, exactly like SF.
// OPEN-INCLUSIVE (blends in-progress rows into any aggregate), so a field built from this is display-only —
// leave it NOT summable (the catalog default for computed fields).
export const sfDuration = (endCol, startCol) => `COALESCE(${endCol}, ${tzToday}) - ${startCol}`;
// A COMPUTED field — maps to a registry-authored SQL `expr` instead of a column (see RegistryField.expr;
// requires @fcr/core reports ≥ v0.7.0). `expr` is TRUSTED registry SQL, never user input; qualify columns
// with the object's table alias (its key) or a join alias. Derived metrics default to NOT groupable /
// NOT summable (a day-count sum is meaningless); override per case.
export const computed = (type, key, label, section, expr, opts = {}) => ({
    key,
    label,
    type,
    section,
    expr,
    filterable: opts.filterable ?? true,
    groupable: opts.groupable ?? false,
    summable: opts.summable ?? false,
    sensitive: opts.sensitive,
});
