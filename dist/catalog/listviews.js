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
// Status dropdown options = the canonical pipeline-order arrays (single source of truth, also the sort rank).
import { TRAILER_STATUS_ORDER as TRAILER_STATUSES, TRUCK_STATUS_ORDER as TRUCK_STATUSES } from "./status-order.js";
// ── Filter helpers ───────────────────────────────────────────────────────────────────────────────
const eq = (field, value) => ({ field, op: "eq", value });
const neq = (field, value) => ({ field, op: "neq", value });
const gte = (field, value) => ({ field, op: "gte", value });
const isNull = (field) => ({ field, op: "isNull" });
const notNull = (field) => ({ field, op: "notNull" });
const sort = (field, dir = "asc") => ({ field, dir });
// "status ∈ {values}" expressed as OR'd eq()s — the engine has NO `in` operator (OPERATORS_BY_TYPE omits
// it, inert until a multi-select control lands), so the status-select active mode and these preset views
// all build set-membership from eq + OR. Returns the filters plus a "(1 OR 2 …)" logic fragment; `start`
// is the 1-based index of the first of these filters in the final filter array.
function statusOneOf(values, start = 1) {
    return { filters: values.map((v) => eq("status", v)), logic: `(${values.map((_, i) => String(start + i)).join(" OR ")})` };
}
// "status ∉ {values}" as AND'd neq()s (no `in`/`not in` operator — the mirror of statusOneOf). `start` is the
// 1-based index of the first of these in the final filter array; returns the filters + "(a AND b …)" logic.
// A NULL status fails `status <> 'X'` (NULL), so a null-status row is EXCLUDED — intended for these action
// queues (a status-less trailer is a data anomaly, not a repair in flight).
function statusNoneOf(values, start = 1) {
    return { filters: values.map((v) => neq("status", v)), logic: `(${values.map((_, i) => String(start + i)).join(" AND ")})` };
}
// Terminal statuses excluded by the default "All active" mode.
const TRUCK_TERMINAL = ["Delivered", "Total Loss", "Donor", "Sold - Total Loss", "No Repair"];
const TRAILER_TERMINAL = ["Delivered", "Total Loss", "Do Not Repair"];
// (TRUCK_STATUSES / TRAILER_STATUSES — the SF Status__c picklists in pipeline order — now live in
// status-order.ts and are imported above, so the dropdown options and the status sort rank share one array.)
const TRUCK_COLS = ["sf_name", "vin", "status", "shop", "notify_date", "arrival_date", "repair_goal", "customer_name", "contacts", "invoice_1"];
// Truck "Repair Pipeline" columns (parity with TRAILER_PIPELINE_COLS, adapted to the truck schema: truck has
// no `type`/`team`, so shop + team_leader stand in). Requires the computed day-count fields (truck.ts).
const TRUCK_PIPELINE_COLS = ["sf_name", "customer_name", "status", "days_in_status", "shop", "team_leader", "invoice_1", "days_past_due"];
// Truck WIP columns (truck has no completetion_percentage/labor column; show shop + the repair-stage dates).
const TRUCK_WIP_COLS = ["sf_name", "vin", "notify_date", "status", "shop", "repair_start_date", "repair_completion_date", "invoice_date"];
// Truck pre-repair scheduling queue (mirrors the trailer scheduling preset, adapted to the truck picklist —
// truck has "Awaiting Repair Start", not trailer's "Parts Received").
const TRUCK_SCHEDULING_STATUSES = ["Approved", "Awaiting Parts", "Awaiting Repair Start"];
// The fcr-trailers "Repair Pipeline" columns (parity with the old bespoke TrailerTable): unit, customer,
// status, days-in-status, type, team, invoice #, days-past-due. Requires the computed day-count fields.
const TRAILER_PIPELINE_COLS = ["sf_name", "customer_name", "status", "days_in_status", "type", "team", "invoice_1", "days_past_due"];
// "Past Due" columns (Matt 2026-10-21: repair-overdue, not AR aging) — swap invoice #/days-past-due for the
// repair goal + days-past-goal so the row shows WHY it's overdue.
const TRAILER_PAST_DUE_COLS = ["sf_name", "customer_name", "status", "days_in_status", "type", "team", "repair_goal", "days_past_goal"];
// Statuses at/after "Repair Complete" — a trailer here is "past the repair process" (Matt 2026-10-21), so it's
// excluded from the pre-repair Scheduling queue and the repair-overdue Past Due view.
const TRAILER_POST_REPAIR = [
    "Repair Complete", "Awaiting Delivery Info", "Awaiting Delivery", "Awaiting Customer Pickup",
    "Delivery Dispatch", "Delivered", "Total Loss", "Do Not Repair", "REWORK",
];
// ── The catalog ───────────────────────────────────────────────────────────────────────────────────
const TRUCK_VIEWS = [
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
    // ── Repair-pipeline views (parity with the trailer pipeline; added for the fcr-estimating /trucks surface,
    // fcr-shared#28). Use TRUCK_PIPELINE_COLS + the computed day-counts. Additive to the catalog — the three
    // views above are untouched. Isolation from existing consumers (e.g. dispatch's /list) comes from the
    // immutable-SHA tarball pin, NOT from additivity: a consumer that repins @fcr/core to >=0.24.0 inherits
    // these four truck views too (same way dispatch already renders the trailer pipeline views).
    {
        slug: "scheduling",
        object: "truck",
        label: "Scheduling",
        group: "overview",
        description: "Approved, awaiting parts, or awaiting repair start — the pre-repair scheduling queue.",
        columns: TRUCK_PIPELINE_COLS,
        defaultSort: sort("days_in_status", "desc"),
        filters: statusOneOf(TRUCK_SCHEDULING_STATUSES).filters,
        filterLogic: statusOneOf(TRUCK_SCHEDULING_STATUSES).logic,
    },
    {
        slug: "wip",
        object: "truck",
        label: "WIP",
        group: "overview",
        description: "Trucks in repair (started, not yet invoiced, not a total loss).",
        columns: TRUCK_WIP_COLS,
        defaultSort: sort("repair_start_date", "asc"),
        filters: [notNull("repair_start_date"), isNull("invoice_date"), neq("status", "Total Loss"), isNull("status")],
        filterLogic: "1 AND 2 AND (3 OR 4)",
    },
    {
        slug: "to_invoice",
        object: "truck",
        label: "To Invoice",
        group: "overview",
        description: "Closed trucks not yet invoiced (terminal status, invoice # blank).",
        columns: TRUCK_PIPELINE_COLS,
        // status ∈ terminal  AND  invoice_1 IS NULL. The isNull follows the OR'd status eq()s.
        defaultSort: sort("days_in_status", "desc"),
        filters: [...statusOneOf(TRUCK_TERMINAL).filters, isNull("invoice_1")],
        filterLogic: `${statusOneOf(TRUCK_TERMINAL).logic} AND ${TRUCK_TERMINAL.length + 1}`,
    },
    {
        slug: "past_due",
        object: "truck",
        label: "Past Due",
        group: "overview",
        description: "Invoiced-and-unpaid trucks 30+ days past the invoice date.",
        columns: TRUCK_PIPELINE_COLS,
        defaultSort: sort("days_past_due", "desc"),
        filters: [gte("days_past_due", "30")],
        filterLogic: null,
    },
];
const TRAILER_VIEWS = [
    {
        slug: "trailers",
        object: "trailer",
        label: "Trailers",
        group: "overview",
        // The Repair Pipeline overview. Columns are the pipeline set (days-in-status / type / invoice # /
        // days-past-due) rather than the earlier VIN/arrival/est-hours set — parity with the fcr-trailers list
        // this replaces. Only affects a consumer on reports ≥ v0.7.0 (the computed columns); older pins are
        // unaffected until they repin.
        description: "Every active trailer. Pick a status to narrow (any status, including delivered / total loss).",
        columns: TRAILER_PIPELINE_COLS,
        defaultSort: sort("days_in_status", "desc"),
        statusSelect: { options: TRAILER_STATUSES, activeExcludes: TRAILER_TERMINAL },
    },
    {
        slug: "scheduling",
        object: "trailer",
        label: "Scheduling",
        group: "overview",
        // Matt 2026-10-21: estimate approved AND all parts received, not yet past repair — the ready-to-schedule
        // queue (approved + parts in hand, repair not yet done). Replaces the old status-only {Approved / Awaiting
        // Parts / Parts Received} preset.
        description: "Estimate approved and all parts received, not yet past repair — the ready-to-schedule queue.",
        columns: TRAILER_PIPELINE_COLS,
        defaultSort: sort("days_in_status", "desc"),
        filters: [notNull("estimate_approved_date"), notNull("all_parts_received_date_stamped"), ...statusNoneOf(TRAILER_POST_REPAIR, 3).filters],
        filterLogic: `1 AND 2 AND ${statusNoneOf(TRAILER_POST_REPAIR, 3).logic}`,
    },
    {
        slug: "stuck_on_parts",
        object: "trailer",
        label: "Stuck on Parts (20+ days)",
        group: "overview",
        // Matt 2026-10-21: trailers that have been awaiting parts for 20+ days. Trailers track "awaiting parts" as
        // a STATUS (there is no Awaiting-Parts DATE column on the trailer object — that's truck-only), so "20+ days
        // out" = in the "Awaiting Parts" status for 20+ days (days_in_status, measured from status_date).
        description: "Trailers awaiting parts for 20 or more days (in “Awaiting Parts” status ≥ 20 days).",
        columns: TRAILER_PIPELINE_COLS,
        defaultSort: sort("days_in_status", "desc"),
        filters: [eq("status", "Awaiting Parts"), gte("days_in_status", "20")],
        filterLogic: "1 AND 2",
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
    {
        slug: "to_invoice",
        object: "trailer",
        label: "To Invoice",
        group: "overview",
        description: "Closed trailers not yet invoiced (delivered / total loss / do not repair, invoice # blank).",
        columns: TRAILER_PIPELINE_COLS,
        // status ∈ terminal  AND  invoice_1 IS NULL. The isNull follows the OR'd status eq()s.
        defaultSort: sort("days_in_status", "desc"),
        filters: [...statusOneOf(TRAILER_TERMINAL).filters, isNull("invoice_1")],
        filterLogic: `${statusOneOf(TRAILER_TERMINAL).logic} AND ${TRAILER_TERMINAL.length + 1}`,
    },
    {
        slug: "past_due",
        object: "trailer",
        label: "Past Due",
        group: "overview",
        // Matt 2026-10-21: REDEFINED from invoice aging to repair-overdue — repairs not complete AND past the
        // repair goal (the estimated completion date). days_past_goal = tzToday - repair_goal (NULL when no goal),
        // so gte 0 == repair_goal on/before today; repair_completion_date IS NULL == repairs not done; and status
        // not past repair. (AR invoice aging now lives in the Invoicing canned reports / "15 Days Past Due".)
        description: "Repairs not complete and past the estimated completion date (repair goal).",
        columns: TRAILER_PAST_DUE_COLS,
        defaultSort: sort("days_past_goal", "desc"),
        filters: [gte("days_past_goal", "0"), isNull("repair_completion_date"), ...statusNoneOf(TRAILER_POST_REPAIR, 3).filters],
        filterLogic: `1 AND 2 AND ${statusNoneOf(TRAILER_POST_REPAIR, 3).logic}`,
    },
];
export const LIST_VIEWS = [...TRUCK_VIEWS, ...TRAILER_VIEWS];
// ── Lookups ────────────────────────────────────────────────────────────────────────────────────────
export function getListView(object, slug) {
    return LIST_VIEWS.find((v) => v.object === object && v.slug === slug);
}
export function listViewsForObject(object) {
    return LIST_VIEWS.filter((v) => v.object === object);
}
/** A ?status= value validated against the view's dropdown options. Returns the status when it's a real
 *  option, else null (⇒ the default "All active" mode). Guards a crafted param the same way resolveSort
 *  guards sort, and the runner's validator rejects an unknown value anyway. */
export function resolveStatus(view, raw) {
    if (!view.statusSelect || !raw)
        return null;
    return view.statusSelect.options.includes(raw) ? raw : null;
}
/**
 * Build the status-mode filters for a status-selectable view: the location filter (if any) AND either the
 * chosen status (`status = X`) or, by default, "active" — `(status NOT IN terminals) OR status IS NULL`
 * (the OR-null keeps SF-faithful parity, since Postgres `status <> 'X'` is NULL for a null status).
 */
function statusFilters(view, selectedStatus) {
    const sel = view.statusSelect;
    const filters = [];
    const andParts = [];
    if (view.locationFilter) {
        filters.push(view.locationFilter);
        andParts.push(String(filters.length));
    }
    if (selectedStatus) {
        filters.push(eq("status", selectedStatus));
        andParts.push(String(filters.length));
    }
    else {
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
export function listViewDefinition(view, activeSort, selectedStatus = null) {
    const { filters, filterLogic } = view.statusSelect
        ? statusFilters(view, selectedStatus)
        : { filters: view.filters ?? [], filterLogic: view.filterLogic ?? null };
    return { object: view.object, columns: view.columns, filters, filterLogic, summaries: [], sort: activeSort };
}
/** Resolve the effective sort from URL params, falling back to the view default. Guards the field to a
 *  column in the view and the direction to asc|desc. */
export function resolveSort(view, sortField, dir) {
    const validField = sortField && view.columns.includes(sortField);
    const validDir = dir === "asc" || dir === "desc";
    if (validField)
        return { field: sortField, dir: validDir ? dir : "asc" };
    return view.defaultSort;
}
