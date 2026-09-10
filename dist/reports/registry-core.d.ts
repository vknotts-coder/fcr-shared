import type { Principal } from "../contracts/index.js";
import type { ClientReportObject, ReportFieldMeta } from "./definition.js";
/** One reportable field. Extends the client metadata with server-only wiring. */
export type RegistryField = ReportFieldMeta & {
    /**
     * SQL column path, at most ONE relation hop. Own column ⇒ the bare column name (the runner qualifies
     * it with the object's table alias, e.g. "status" → truck.status). One-hop ⇒ "<joinAlias>.<column>"
     * (e.g. "customer.sf_name"). Split on a single "." — no deeper paths (matches the one-join-hop runner).
     */
    path: string;
    /** UI + gating grouping (e.g. "identity" | "pickup" | "delivery" | "financials"). */
    section: string;
    /** Sensitive (financial/internal) — offered only when the per-field can('view', <obj>,
     *  {section, field}) check holds for the principal. */
    sensitive?: boolean;
    /** For a `date` field whose underlying column is `timestamptz` (not a plain `date`): the runner
     *  truncates it to the America/Chicago calendar date for day-granular filtering/grouping/rendering,
     *  so an evening-local record isn't bucketed a day late. Omit for real `date` columns (no-op). */
    dateTz?: boolean;
};
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
    join?: {
        alias: string;
        sql: string;
    };
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
    link?: {
        path: string;
        href: (id: string) => string;
    };
    /**
     * Optional runtime gate for `link`. When present, the runner emits row hrefs ONLY when this returns
     * true — checked PER RUN (runReport is per-request), so a cutover flag toggle is honored without a
     * rebuild. Absent ⇒ the link is always active.
     */
    linkEnabled?: () => boolean;
    fields: RegistryField[];
};
/** The same admin derivation auth.ts uses for isAdmin: a coarse ('*','admin','all') grant. v1 report
 *  access is admin-only, so this is both the object gate and (for now) the sensitive-field gate. */
export declare const isAdmin: (p: Principal) => boolean;
/**
 * The client-safe, permission-FILTERED view of one object for a principal: strips server-only wiring
 * (path/sensitive) and DROPS sensitive fields the principal may not see. Because the validator checks a
 * definition against exactly this field set, a field not returned here can never be selected, filtered,
 * grouped, summarized, or sorted — the field-level security floor.
 */
export declare function toClientObject(obj: RegistryObject, principal: Principal): ClientReportObject;
/** Every object in `catalog` this principal may report on, as client-safe filtered metadata (builder UI). */
export declare function objectsForViewer(catalog: RegistryObject[], principal: Principal): ClientReportObject[];
/** The full server-side object def for the runner, looked up in `catalog`. Undefined for an unknown key. */
export declare function getObjectDef(catalog: RegistryObject[], key: string): RegistryObject | undefined;
//# sourceMappingURL=registry-core.d.ts.map