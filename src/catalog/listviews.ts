// Salesforce-style List Views (#107 Slice 1 — lifted verbatim from fcr-dispatch's lib/reports/listviews).
//
// A "list view" is a saved, filtered, SORTABLE record table. This is the FCR mirror: each view runs a
// PREDEFINED report definition through the existing reports engine (registry → runner → parameterized SQL).
// Salesforce does NOT persist sort in ListView metadata, so the default sort here is ours; the surface lets
// the user re-sort by clicking a column header.
//
// STATUS is a user-selectable DROPDOWN, not one view per status: a status-selectable view shows "All active"
// by default (excludes the object's terminal statuses) and lets the user narrow to any single SF status via
// a `?status=` dropdown. So trucks are 3 views (All + per-shop Livingston/Sparta), trailers 1 (+ the WIP
// composite) — instead of ~45 per-status buttons.
//
// PURE module — types + data only, no server imports — safe in a client or server bundle. Field references
// are registry KEYS (validated by validateDefinition against the viewer's permission-filtered field set
// before any query runs); this catalog never touches SQL.

import type { ReportDefinition, ReportFilter, ReportSort } from "../reports/definition.js";

export type ListViewObject = "truck" | "trailer";
export type ListViewGroup = "overview" | "location";

/** A user-selectable status dropdown on a view: `options` are the individual statuses (the full SF
 *  picklist), `activeExcludes` are the terminal statuses hidden in the default "All active" mode. */
export type StatusSelect = { options: string[]; activeExcludes: string[] };

export type ListView = {
  slug: string; // URL segment, unique within an object
  object: ListViewObject;
  label: string;
  group: ListViewGroup;
  description?: string;
  columns: string[]; // registry field keys, in display order
  defaultSort: ReportSort; // must reference a column above (validator enforces sort ∈ columns)
  // A status-selectable view: a dropdown narrows to one status; default is "All active".
  statusSelect?: StatusSelect;
  // An extra always-applied filter (e.g. shop = Livingston), AND'd with the status filter.
  locationFilter?: ReportFilter;
  // A fully-static view (e.g. WIP) — used only when statusSelect is absent.
  filters?: ReportFilter[];
  filterLogic?: string | null;
};

// ── Filter helpers ───────────────────────────────────────────────────────────────────────────────
const eq = (field: string, value: string): ReportFilter => ({ field, op: "eq", value });
const neq = (field: string, value: string): ReportFilter => ({ field, op: "neq", value });
const isNull = (field: string): ReportFilter => ({ field, op: "isNull" });
const notNull = (field: string): ReportFilter => ({ field, op: "notNull" });
const sort = (field: string, dir: "asc" | "desc" = "asc"): ReportSort => ({ field, dir });

// Terminal statuses excluded by the default "All active" mode.
const TRUCK_TERMINAL = ["Delivered", "Total Loss", "Donor", "Sold - Total Loss", "No Repair"];
const TRAILER_TERMINAL = ["Delivered", "Total Loss", "Do Not Repair"];

// Full SF Status__c picklists (retrieved 2026-09-09) — the dropdown options, in pipeline order. Truck also
// carries "Photo Estimate - Awaiting Approval" (a legacy value still on live records, absent from the
// active picklist but verified present in the data).
const TRUCK_STATUSES = [
  "Awaiting Pickup Info", "Awaiting Pickup", "Pickup (Dispatch)", "Estimating", "Awaiting Approval",
  "Photo Estimate - Awaiting Approval", "Approved", "Awaiting Parts", "Awaiting Repair Start",
  "Repair in Progress", "Complete", "Awaiting Delivery", "Awaiting Customer Pickup", "Delivery (Dispatch)",
  "Delivered", "Hold", "Awaiting TL Confirmation", "LEGAL HOLD", "Total Loss", "Donor", "Sold - Total Loss",
  "No Repair", "REWORK", "FCR OWNED",
];
const TRAILER_STATUSES = [
  "Awaiting Pickup Info", "Awaiting Pickup", "Customer Drop Off", "Dispatch (Pickup)", "Received", "Estimating",
  "Awaiting Approval", "Approved", "Awaiting Parts", "LEGAL HOLD", "Parts Received", "Repair in Progress",
  "Repair Complete", "Awaiting Delivery Info", "Awaiting Delivery", "Awaiting Customer Pickup",
  "Delivery Dispatch", "Delivered", "Total Loss", "REWORK", "Hold", "Do Not Repair",
];

const TRUCK_COLS = ["sf_name", "vin", "status", "shop", "notify_date", "arrival_date", "repair_goal", "customer_name", "contacts", "invoice_1"];
const TRAILER_COLS = ["sf_name", "full_vin", "status", "team", "notify_date", "arrival_date", "repair_goal", "estimated_hours", "completetion_percentage"];

// ── The catalog ───────────────────────────────────────────────────────────────────────────────────

const TRUCK_VIEWS: ListView[] = [
  {
    slug: "all",
    object: "truck",
    label: "All Trucks",
    group: "overview",
    description: "Every active truck. Pick a status to narrow (any status, including delivered / total loss).",
    columns: TRUCK_COLS,
    defaultSort: sort("notify_date", "desc"),
    statusSelect: { options: TRUCK_STATUSES, activeExcludes: TRUCK_TERMINAL },
  },
  {
    slug: "livingston",
    object: "truck",
    label: "Livingston",
    group: "location",
    description: "Livingston-shop trucks. Pick a status to narrow.",
    columns: TRUCK_COLS,
    defaultSort: sort("notify_date", "desc"),
    statusSelect: { options: TRUCK_STATUSES, activeExcludes: TRUCK_TERMINAL },
    locationFilter: eq("shop", "Livingston"),
  },
  {
    slug: "sparta",
    object: "truck",
    label: "Sparta",
    group: "location",
    description: "Sparta-shop trucks. Pick a status to narrow.",
    columns: TRUCK_COLS,
    defaultSort: sort("notify_date", "desc"),
    statusSelect: { options: TRUCK_STATUSES, activeExcludes: TRUCK_TERMINAL },
    locationFilter: eq("shop", "Sparta"),
  },
];

const TRAILER_VIEWS: ListView[] = [
  {
    slug: "trailers",
    object: "trailer",
    label: "Trailers",
    group: "overview",
    description: "Every active trailer. Pick a status to narrow (any status, including delivered / total loss).",
    columns: TRAILER_COLS,
    defaultSort: sort("notify_date", "desc"),
    statusSelect: { options: TRAILER_STATUSES, activeExcludes: TRAILER_TERMINAL },
  },
  {
    slug: "wip",
    object: "trailer",
    label: "WIP",
    group: "overview",
    description: "Trailers in repair (started, not yet invoiced, not a total loss).",
    columns: ["sf_name", "full_vin", "notify_date", "status", "labor_amount", "completetion_percentage", "team", "repair_start_date", "repair_completion_date", "invoice_date"],
    defaultSort: sort("repair_start_date", "asc"),
    filters: [notNull("repair_start_date"), isNull("invoice_date"), neq("status", "Total Loss"), isNull("status")],
    filterLogic: "1 AND 2 AND (3 OR 4)",
  },
];

export const LIST_VIEWS: ListView[] = [...TRUCK_VIEWS, ...TRAILER_VIEWS];

// ── Lookups ────────────────────────────────────────────────────────────────────────────────────────

export function getListView(object: string, slug: string): ListView | undefined {
  return LIST_VIEWS.find((v) => v.object === object && v.slug === slug);
}

export function listViewsForObject(object: ListViewObject): ListView[] {
  return LIST_VIEWS.filter((v) => v.object === object);
}

/** A ?status= value validated against the view's dropdown options. Returns the status when it's a real
 *  option, else null (⇒ the default "All active" mode). Guards a crafted param the same way resolveSort
 *  guards sort, and the runner's validator rejects an unknown value anyway. */
export function resolveStatus(view: ListView, raw?: string): string | null {
  if (!view.statusSelect || !raw) return null;
  return view.statusSelect.options.includes(raw) ? raw : null;
}

/**
 * Build the status-mode filters for a status-selectable view: the location filter (if any) AND either the
 * chosen status (`status = X`) or, by default, "active" — `(status NOT IN terminals) OR status IS NULL`
 * (the OR-null keeps SF-faithful parity, since Postgres `status <> 'X'` is NULL for a null status).
 */
function statusFilters(view: ListView, selectedStatus: string | null): { filters: ReportFilter[]; filterLogic: string | null } {
  const sel = view.statusSelect!;
  const filters: ReportFilter[] = [];
  const andParts: string[] = [];
  if (view.locationFilter) {
    filters.push(view.locationFilter);
    andParts.push(String(filters.length));
  }
  if (selectedStatus) {
    filters.push(eq("status", selectedStatus));
    andParts.push(String(filters.length));
  } else {
    const start = filters.length;
    sel.activeExcludes.forEach((s) => filters.push(neq("status", s)));
    filters.push(isNull("status"));
    const neqIdx = sel.activeExcludes.map((_, i) => String(start + 1 + i));
    const nullIdx = filters.length;
    andParts.push(`(${neqIdx.join(" AND ")} OR ${nullIdx})`);
  }
  // A single bare index needs no explicit logic (default AND handles it); an OR group or 2+ parts do.
  const first = andParts[0];
  const filterLogic = andParts.length === 1 && first !== undefined && /^\d+$/.test(first) ? null : andParts.join(" AND ");
  return { filters, filterLogic };
}

/** Build a runnable ReportDefinition for a view: static filters for a plain view (WIP), or the status-mode
 *  filters (location + selected/active status) for a status-selectable one. */
export function listViewDefinition(view: ListView, activeSort: ReportSort, selectedStatus: string | null = null): ReportDefinition {
  const { filters, filterLogic } = view.statusSelect
    ? statusFilters(view, selectedStatus)
    : { filters: view.filters ?? [], filterLogic: view.filterLogic ?? null };
  return { object: view.object, columns: view.columns, filters, filterLogic, summaries: [], sort: activeSort };
}

/** Resolve the effective sort from URL params, falling back to the view default. Guards the field to a
 *  column in the view and the direction to asc|desc. */
export function resolveSort(view: ListView, sortField?: string, dir?: string): ReportSort {
  const validField = sortField && view.columns.includes(sortField);
  const validDir = dir === "asc" || dir === "desc";
  if (validField) return { field: sortField, dir: validDir ? dir : "asc" };
  return view.defaultSort;
}
