// Canonical SF Status__c pipeline order per object, plus the ORDER BY rank expression that makes a status
// column sort by pipeline STAGE instead of alphabetically (Matt, 2026-10-21: "when sorting by status, sort
// by the actual status flow rather than alphabetical order" — applies to every list view and report).
//
// SINGLE SOURCE OF TRUTH for the trailer/truck status orderings. Imported by:
//   • the catalogs (truck.ts / trailer.ts) — the `status` field's `sortExpr` (the sort rank), and
//   • listviews.ts — the status-dropdown `options` (same array, pipeline order).
// Pure data + a trusted-SQL builder; no DB/React import, safe in any bundle.

import type { RegistryField } from "../reports/registry-core.js";
import { str, computed } from "./fields.js";

// Full SF Status__c picklists (retrieved 2026-09-09), in pipeline order. Truck also carries the legacy
// "Photo Estimate - Awaiting Approval" value (present on live records, absent from the active picklist).
// These were previously duplicated as TRUCK_STATUSES / TRAILER_STATUSES in listviews.ts; consolidated here
// so the dropdown options and the sort rank can never drift apart.
export const TRUCK_STATUS_ORDER: string[] = [
  "Awaiting Pickup Info", "Awaiting Pickup", "Pickup (Dispatch)", "Estimating", "Awaiting Approval",
  "Photo Estimate - Awaiting Approval", "Approved", "Awaiting Parts", "Awaiting Repair Start",
  "Repair in Progress", "Complete", "Awaiting Delivery", "Awaiting Customer Pickup", "Delivery (Dispatch)",
  "Delivered", "Hold", "Awaiting TL Confirmation", "LEGAL HOLD", "Total Loss", "Donor", "Sold - Total Loss",
  "No Repair", "REWORK", "FCR OWNED",
];

export const TRAILER_STATUS_ORDER: string[] = [
  "Awaiting Pickup Info", "Awaiting Pickup", "Customer Drop Off", "Dispatch (Pickup)", "Received", "Estimating",
  "Awaiting Approval", "Approved", "Awaiting Parts", "LEGAL HOLD", "Parts Received", "Repair in Progress",
  "Repair Complete", "Awaiting Delivery Info", "Awaiting Delivery", "Awaiting Customer Pickup",
  "Delivery Dispatch", "Delivered", "Total Loss", "REWORK", "Hold", "Do Not Repair",
];

// ── Donor (salvage) stages — fcr-estimating#41. UNLIKE truck/trailer, the donor `status` column stores a
// SLUG (on_the_way…scrapped_sold), not a human label. So the catalog field (donorStatusField below) renders
// the slug AS its label while sorting by stage. This one array drives the sort rank; the label map + the
// label-ordered array drive the display, the dropdown options, and the grouped-summary order. ─────────────
export const DONOR_STATUS_ORDER: string[] = ["on_the_way", "intake", "parting_out", "picked_over", "scrapped_sold"];
export const DONOR_STATUS_LABELS: Record<string, string> = {
  on_the_way: "On the way",
  intake: "Intake",
  parting_out: "Parting Out",
  picked_over: "Picked Over",
  scrapped_sold: "Scrapped/Sold Whole",
};
// Labels in stage order. The donor status field RENDERS as its label (via the CASE expr), so the dropdown
// options and the grouped-summary `sortOrder` both live in label-space (not slug-space).
export const DONOR_STATUS_LABEL_ORDER: string[] = DONOR_STATUS_ORDER.map((s) => DONOR_STATUS_LABELS[s]!);

// A trusted-SQL CASE that ranks the object's `status` column by its pipeline position, so `ORDER BY <this>`
// sorts by stage (A→Z no longer). An unlisted / legacy / NULL status sorts LAST (rank = order.length).
// `order` is registry-authored (code, never user input); the quote-doubling escape is defence-in-depth —
// every value here is a known SF picklist literal.
export function statusRankExpr(objKey: string, order: readonly string[]): string {
  const whens = order.map((s, i) => `WHEN '${s.replace(/'/g, "''")}' THEN ${i}`).join(" ");
  return `CASE "${objKey}"."status" ${whens} ELSE ${order.length} END`;
}

// The `status` RegistryField for an object, carrying the pipeline order BOTH ways (#1): `sortExpr` (a SQL
// rank CASE) for the tabular ORDER BY, and `sortOrder` (the same array) for the grouped/summary path, which
// orders groups in JS. So a status sort — whether a flat list view or a by-status GROUPED report — follows SF
// pipeline stage, not A→Z. Identical to `str("status","Status","status")` in every other respect.
export function statusField(objKey: string, order: readonly string[]): RegistryField {
  return { ...str("status", "Status", "status"), sortExpr: statusRankExpr(objKey, order), sortOrder: order };
}

// The donor `status` RegistryField. A COMPUTED field: its `expr` is a CASE that maps the stored slug to its
// human label, so the label is what the grid renders, what a filter compares against, and what a by-status
// group is keyed/labelled by (hence the dropdown options + sortOrder are the LABELS, not the slugs). The
// `sortExpr` still ranks by the raw slug's stage, so a status sort follows the yard flow, not A→Z. The CASE
// values are registry literals (status slugs + fixed labels), never user input — same trust boundary as
// statusRankExpr; the label single-quotes are doubled defence-in-depth.
export function donorStatusField(): RegistryField {
  const labelExpr =
    "CASE donor.status " +
    DONOR_STATUS_ORDER.map((s) => `WHEN '${s}' THEN '${DONOR_STATUS_LABELS[s]!.replace(/'/g, "''")}'`).join(" ") +
    " ELSE donor.status END";
  // Reuse computed() for the RegistryField shape (so the field-set/defaults can't drift from the catalog's
  // other computed fields), then add the status-only sort wiring — mirroring how statusField() reuses str().
  return {
    ...computed("string", "status", "Status", "status", labelExpr, { groupable: true, summable: false }),
    sortExpr: statusRankExpr("donor", DONOR_STATUS_ORDER),
    sortOrder: DONOR_STATUS_LABEL_ORDER,
  };
}
