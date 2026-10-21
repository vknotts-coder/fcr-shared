// Canonical SF Status__c pipeline order per object, plus the ORDER BY rank expression that makes a status
// column sort by pipeline STAGE instead of alphabetically (Matt, 2026-10-21: "when sorting by status, sort
// by the actual status flow rather than alphabetical order" — applies to every list view and report).
//
// SINGLE SOURCE OF TRUTH for the trailer/truck status orderings. Imported by:
//   • the catalogs (truck.ts / trailer.ts) — the `status` field's `sortExpr` (the sort rank), and
//   • listviews.ts — the status-dropdown `options` (same array, pipeline order).
// Pure data + a trusted-SQL builder; no DB/React import, safe in any bundle.

import type { RegistryField } from "../reports/registry-core.js";
import { str } from "./fields.js";

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
