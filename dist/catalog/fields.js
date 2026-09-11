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
