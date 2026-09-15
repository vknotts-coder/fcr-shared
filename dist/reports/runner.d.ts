import type { Queryable } from "../rbac/index.js";
import type { Principal } from "../contracts/index.js";
import { type RegistryField, type RegistryObject } from "./registry-core.js";
import { type FieldType, type ReportDefinition, type ReportSort, type DateBucket } from "./definition.js";
export type ReportColumn = {
    key: string;
    label: string;
    type: FieldType;
    numeric: boolean;
};
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
export type SummaryRow = {
    groupValue: string;
    values: Record<string, SummaryCell>;
};
export type SummaryResult = {
    mode: "summary";
    object: string;
    group: {
        key: string;
        label: string;
        bucket?: DateBucket;
    };
    columns: ReportColumn[];
    rows: SummaryRow[];
    total: Record<string, SummaryCell>;
    rowCount: number;
    truncated: boolean;
};
export type ReportResult = TabularResult | SummaryResult;
export type RunOutcome = {
    ok: true;
    result: ReportResult;
} | {
    ok: false;
    errors: string[];
};
export type WhereSql = {
    sql: string;
    params: unknown[];
};
/**
 * The full WHERE: mandatory server-side scope (baseWhere + owner-scope) AND'd with the definition's
 * filters. Scope is applied here regardless of the definition — the security floor, not user-controllable.
 * The combined user-filter subtree is one AND element, so a user OR can never widen past the scope.
 */
export declare function buildWhere(obj: RegistryObject, def: ReportDefinition, fieldsByKey: Map<string, RegistryField>, principal: Principal): WhereSql;
export type BuiltQuery = {
    sql: string;
    params: unknown[];
};
/** Assemble the tabular SELECT (columns + the link id) with the +1 truncation probe. Exposed for tests.
 *  `rowCap` is the LIMIT the runner enforces — the on-screen grid passes REPORT_ROW_CAP (the default), the
 *  CSV export path passes EXPORT_ROW_CAP; the `+ 1` probe detects "there are more" for either. */
export declare function buildTabularQuery(obj: RegistryObject, def: ReportDefinition, fieldsByKey: Map<string, RegistryField>, principal: Principal, rowCap?: number): BuiltQuery;
/**
 * Exact, UNCAPPED summary via a real DB-side GROUP BY (replaces the earlier JS-aggregation-over-a-capped
 * window, which silently under-counted once a scoped set exceeded the row cap). Groups + aggregates are
 * computed in Postgres, so the result is correct regardless of cardinality. Exposed for tests.
 */
export declare function buildSummaryQuery(obj: RegistryObject, def: ReportDefinition, fieldsByKey: Map<string, RegistryField>, principal: Principal, where?: WhereSql): BuiltQuery;
/** The grand-total aggregate row (same WHERE, no GROUP BY) — one exact row over the whole scoped set.
 *  Computed by its own query so the total avg is exact (not derivable from per-group avgs). Pass the
 *  shared `where` so the scoped WHERE is built once per run, not once per query. */
export declare function buildSummaryTotalQuery(obj: RegistryObject, def: ReportDefinition, fieldsByKey: Map<string, RegistryField>, principal: Principal, where?: WhereSql): BuiltQuery;
export type ValidatedReport = {
    ok: true;
    obj: RegistryObject;
    def: ReportDefinition;
} | {
    ok: false;
    errors: string[];
};
/**
 * Resolve + gate + validate a definition for a viewer WITHOUT running a query. Gates the object against
 * the REAL viewer and validates the definition against the viewer's permission-filtered field set (the
 * field-level floor). Shared by runReport and the save action so identical authorization runs whether a
 * report is run or merely saved.
 */
export declare function validateReport(raw: unknown, principal: Principal, catalog: RegistryObject[]): ValidatedReport;
/** Validate + run a report for a viewer. Never trusts the definition for scoping. `db` is the injected
 *  query surface (any @fcr/core `Queryable` — the app passes its `pool()`) and `catalog` is the app's
 *  reportable-object registry (the app passes its `REPORT_OBJECTS`). Keeping BOTH the DB handle and the
 *  catalog parameters, not imports, is what makes this engine app-agnostic and lift-ready into
 *  @fcr/core/reports — it imports no app module. */
export declare function runReport(raw: unknown, principal: Principal, db: Queryable, catalog: RegistryObject[], opts?: {
    rowCap?: number;
}): Promise<RunOutcome>;
export declare function sortSummaryRows(rows: SummaryRow[], columns: ReportColumn[], sort: ReportSort | null | undefined, groupKey?: string): SummaryRow[];
//# sourceMappingURL=runner.d.ts.map