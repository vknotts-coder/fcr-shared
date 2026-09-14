// Field-builder helpers for the reportable-object catalog (lifted from fcr-dispatch's registry.ts, #107
// Slice 1). Terse, consistent constructors for RegistryField rows. Pure — types only, no server/DB import;
// safe in any bundle. The object CATALOGS (truck.ts / trailer.ts) use these to declare their field tables.

import { type FieldType, isNumericType } from "../reports/definition.js";
import type { RegistryField } from "../reports/registry-core.js";

export const f = (
  type: FieldType,
  key: string,
  label: string,
  section: string,
  opts: { path?: string; filterable?: boolean; groupable?: boolean; summable?: boolean; sensitive?: boolean; enumValues?: string[] } = {},
): RegistryField => ({
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

export const str = (key: string, label: string, section: string, path?: string) => f("string", key, label, section, { path, summable: false });
export const dateF = (key: string, label: string, section: string, path?: string) => f("date", key, label, section, { path, summable: false });
// A `date` field backed by a `timestamptz` column (America/Chicago local-date semantics in the runner).
export const dateTzF = (key: string, label: string, section: string, path?: string): RegistryField => ({ ...dateF(key, label, section, path), dateTz: true });
export const numF = (key: string, label: string, section: string, path?: string) => f("number", key, label, section, { path });
export const money = (key: string, label: string, section: string, sensitive = true, path?: string) => f("money", key, label, section, { path, sensitive, groupable: false });

// A COMPUTED field — maps to a registry-authored SQL `expr` instead of a column (see RegistryField.expr;
// requires @fcr/core reports ≥ v0.7.0). `expr` is TRUSTED registry SQL, never user input; qualify columns
// with the object's table alias (its key) or a join alias. Derived metrics default to NOT groupable /
// NOT summable (a day-count sum is meaningless); override per case.
export const computed = (
  type: FieldType,
  key: string,
  label: string,
  section: string,
  expr: string,
  opts: { filterable?: boolean; groupable?: boolean; summable?: boolean; sensitive?: boolean } = {},
): RegistryField => ({
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
