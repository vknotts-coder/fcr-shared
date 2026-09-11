import type { ReportDefinition, ReportFilter, ReportSort } from "../reports/definition.js";
export type ListViewObject = "truck" | "trailer";
export type ListViewGroup = "overview" | "location";
/** A user-selectable status dropdown on a view: `options` are the individual statuses (the full SF
 *  picklist), `activeExcludes` are the terminal statuses hidden in the default "All active" mode. */
export type StatusSelect = {
    options: string[];
    activeExcludes: string[];
};
export type ListView = {
    slug: string;
    object: ListViewObject;
    label: string;
    group: ListViewGroup;
    description?: string;
    columns: string[];
    defaultSort: ReportSort;
    statusSelect?: StatusSelect;
    locationFilter?: ReportFilter;
    filters?: ReportFilter[];
    filterLogic?: string | null;
};
export declare const LIST_VIEWS: ListView[];
export declare function getListView(object: string, slug: string): ListView | undefined;
export declare function listViewsForObject(object: ListViewObject): ListView[];
/** A ?status= value validated against the view's dropdown options. Returns the status when it's a real
 *  option, else null (⇒ the default "All active" mode). Guards a crafted param the same way resolveSort
 *  guards sort, and the runner's validator rejects an unknown value anyway. */
export declare function resolveStatus(view: ListView, raw?: string): string | null;
/** Build a runnable ReportDefinition for a view: static filters for a plain view (WIP), or the status-mode
 *  filters (location + selected/active status) for a status-selectable one. */
export declare function listViewDefinition(view: ListView, activeSort: ReportSort, selectedStatus?: string | null): ReportDefinition;
/** Resolve the effective sort from URL params, falling back to the view default. Guards the field to a
 *  column in the view and the direction to asc|desc. */
export declare function resolveSort(view: ListView, sortField?: string, dir?: string): ReportSort;
//# sourceMappingURL=listviews.d.ts.map