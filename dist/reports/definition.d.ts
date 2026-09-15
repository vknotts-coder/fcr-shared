export type FieldType = "string" | "number" | "money" | "date" | "boolean" | "enum";
export declare function isNumericType(type: FieldType): boolean;
export declare const ALL_OPERATORS: readonly ["eq", "neq", "contains", "gt", "gte", "lt", "lte", "isNull", "notNull", "in"];
export type FilterOperator = (typeof ALL_OPERATORS)[number];
/** Which operators are legal for each field type. The builder offers only these; the validator
 *  rejects anything else. `isNull`/`notNull` take no value; `in` takes a list; the rest take one. */
export declare const OPERATORS_BY_TYPE: Record<FieldType, FilterOperator[]>;
export declare const VALUELESS_OPERATORS: ReadonlySet<FilterOperator>;
export type SummaryAgg = "sum" | "avg" | "count" | "min" | "max";
export type DateBucket = "day" | "month" | "year";
export type ReportFieldMeta = {
    key: string;
    label: string;
    type: FieldType;
    filterable: boolean;
    groupable: boolean;
    summable: boolean;
    enumValues?: string[];
};
export type ClientReportObject = {
    key: string;
    label: string;
    description?: string;
    fields: ReportFieldMeta[];
};
export type ReportFilter = {
    field: string;
    op: FilterOperator;
    value?: string | string[] | null;
};
export type ReportSummary = {
    field: string;
    agg: SummaryAgg;
};
export type ReportGroupBy = {
    field: string;
    bucket?: DateBucket;
};
export type ReportSort = {
    field: string;
    dir: "asc" | "desc";
};
export type ReportDefinition = {
    object: string;
    columns: string[];
    filters: ReportFilter[];
    /**
     * Salesforce-style filter logic combining the 1-indexed filters, e.g. "1 AND (2 OR 3)". null/empty ⇒
     * all filters AND'd. Governs ONLY how the user's filters combine — the runner always AND's the result
     * under the mandatory base/owner scope, so no OR can widen past what the viewer may see.
     */
    filterLogic?: string | null;
    groupBy?: ReportGroupBy | null;
    summaries: ReportSummary[];
    sort?: ReportSort | null;
};
export type LogicNode = {
    op: "num";
    n: number;
} | {
    op: "and" | "or";
    left: LogicNode;
    right: LogicNode;
} | {
    op: "not";
    child: LogicNode;
};
/**
 * Parse "1 AND (2 OR 3)" into an AST, validating: only AND/OR/NOT/parens/filter-numbers, balanced
 * parens, and every number in 1..count. Pure — used by the validator (reject bad logic) and the runner
 * (build the WHERE tree). Recursive descent: OR is lowest precedence, then AND, then NOT/parens/number.
 */
export declare function parseFilterLogic(logic: string, count: number): {
    ok: true;
    ast: LogicNode;
} | {
    ok: false;
    error: string;
};
export declare const REPORT_ROW_CAP = 5000;
export declare const EXPORT_ROW_CAP = 100000;
export declare const MAX_COLUMNS = 60;
export declare const MAX_FILTERS = 40;
export declare const MAX_SUMMARIES = 20;
export type ValidationResult = {
    ok: true;
    def: ReportDefinition;
} | {
    ok: false;
    errors: string[];
};
/**
 * Validate a raw (client- or DB-sourced) definition against the viewer's ClientReportObject. The
 * object's `fields` are ALREADY permission-filtered for this viewer by the registry, so validating field
 * references against it is the field-level security floor: a viewer can never select, filter, group,
 * summarize, or sort by a field they weren't offered. Returns a clean typed definition or a list of
 * human-readable errors (surfaced in the builder). Never throws on bad input.
 */
export declare function validateDefinition(raw: unknown, obj: ClientReportObject): ValidationResult;
/** Stable key a summary column is addressed by in the result + sort (e.g. "sum:amount", "count"). */
export declare function summaryKey(s: ReportSummary): string;
//# sourceMappingURL=definition.d.ts.map