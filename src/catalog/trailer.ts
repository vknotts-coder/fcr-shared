// Trailer reportable-object catalog (#107 Slice 1 — lifted verbatim from fcr-dispatch's registry.ts
// TRAILER). Parallels truck.ts but over the ASYMMETRIC trailer table (verified against
// db/fcr_core.schema.sql, 2026-09-03): the customer link is `fcr_collision_account` (not
// `fcr_collision_customer`), financials are total_repair_cost/labor_amount (no total_sales), mileage is
// incoming/outgoing (no per-trip miles), and there is NO shop/team_leader/estimator/delivery_location or
// swap/tow_drive column. As with truck, the app-specific gate + link/linkEnabled are injected; the schema
// half is shared. See truck.ts header for why `capability` is required and never defaulted.

import type { Principal } from "../contracts/index.js";
import type { RegistryField, RegistryObject } from "../reports/registry-core.js";
import { str, dateF, dateTzF, numF, money, bool, computed, tzToday, sfDuration } from "./fields.js";

/** The trailer object's field table (schema-coupled; identical across apps). */
export const trailerFields: RegistryField[] = [
  // Identity
  str("sf_name", "Unit #", "identity"),
  str("status", "Status", "status"),
  str("team", "Team", "identity"),
  str("sales_team", "Sales team", "identity"),
  // Status / lifecycle dates
  dateF("status_date", "Status date", "status"),
  dateF("notify_date", "Notified", "status"),
  dateTzF("created_at", "Created", "status"), // timestamptz — local-date in the runner
  dateF("arrival_date", "Arrived", "status"),
  dateF("repair_completion_date", "Repair complete", "status"),
  dateF("invoice_date", "Invoiced", "status"),
  dateF("invoice_paid_date", "Invoice paid", "status"),
  // Pickup leg (trailer: pickup_dispatch_date, pickup_eta; no per-trip miles)
  str("pickup_driver", "Pickup driver", "pickup"),
  str("pickup_location_name", "Pickup location", "pickup"),
  str("pickup_city", "Pickup city", "pickup"),
  str("pickup_state", "Pickup state", "pickup"),
  dateF("pickup_dispatch_date", "Pickup dispatched", "pickup"),
  dateF("pickup_eta", "Pickup ETA", "pickup"),
  // Delivery leg (no delivery_location_name / per-trip miles on trailer)
  str("delivery_driver", "Delivery driver", "delivery"),
  str("delivery_city", "Delivery city", "delivery"),
  str("delivery_state", "Delivery state", "delivery"),
  dateF("delivery_eta", "Delivery ETA", "delivery"),
  // Mileage (trailer-specific: odometer in/out, not per-trip)
  numF("incoming_mileage", "Incoming mileage", "mileage"),
  numF("outgoing_mileage", "Outgoing mileage", "mileage"),
  // Financials (sensitive — gated per-field by can('view', <obj>, {section:'financials', field}))
  money("total_repair_cost", "Total repair cost", "financials"),
  money("labor_amount", "Labor amount", "financials"),
  // List-view parity fields (Salesforce-style List Views). Verified against db/fcr_core.schema.sql:
  // full_vin varchar(17), the *_date columns are real `date`, parts_available is `text`,
  // completetion_percentage/estimated_hours are `numeric`. (Column name `completetion_percentage`
  // preserves the SF-synced spelling.)
  str("full_vin", "VIN", "identity"),
  dateF("repair_start_date", "Repair started", "status"),
  dateF("repair_goal", "Repair goal", "status"),
  dateF("estimate_approved_date", "Estimate approved", "status"),
  dateF("parts_eta_date_stamped", "Parts ETA", "status"),
  dateF("all_parts_received_date_stamped", "All parts received", "status"),
  str("parts_available", "Parts available", "status"),
  numF("completetion_percentage", "% complete", "status"),
  numF("estimated_hours", "Est. hours", "status"),
  // Repair-pipeline parity fields (the fcr-trailers list surface: type, invoice #, and the two day-counts).
  str("type", "Type", "identity"),
  str("invoice_1", "Invoice #", "status"),
  // Account FK — the stable customer.sf_id link. Filterable so an account-scoped list (a search hit
  // /trailers?account=<sf_id>) can filter on it; not a friendly display column, so section=customer.
  str("fcr_collision_account", "Account (SF id)", "customer"),
  // SF report-parity fields (#26 canned reports). These columns all exist in fcr_core.trailer (verified
  // against db/fcr_core.schema.sql, 2026-09-14) but weren't surfaced in the catalog until now — the SF
  // "FCR Collision - Trailers" report folder references them, and the reports here are declarative
  // definitions run through the shared engine, so every referenced column must be a catalog field.
  // Estimate lifecycle
  dateF("estimate_start_date", "Estimate started", "status"),
  dateF("estimate_completed_date", "Estimate completed", "status"),
  dateF("estimate_finalized", "Estimate finalized", "status"),
  numF("actual_hours", "Actual hours", "status"),
  // Arrival / anticipation
  dateF("anticipated_arrival_date", "Anticipated arrival", "status"),
  // Invoicing (invoice_1 is above; §2.0 invoice number + free-text notes)
  str("invoice_2", "Invoice # (2)", "status"),
  str("invoice_notes", "Invoice notes", "status"),
  str("po", "PO #", "identity"),
  // Delivery leg detail (address/zip + the dispatch + completed dates)
  str("delivery_address", "Delivery address", "delivery"),
  str("delivery_zip_code", "Delivery ZIP", "delivery"),
  dateF("delivery_dispatch_date", "Delivery dispatched", "delivery"),
  dateF("delivery_date", "Delivered", "delivery"),
  // Pickup leg detail (address/zip; city/state/dispatch already above)
  str("pickup_address", "Pickup address", "pickup"),
  str("pickup_zip_code", "Pickup ZIP", "pickup"),
  // Rework (boolean flag + the two dates + free-text notes)
  bool("rework", "Rework", "status"),
  dateF("rework_date", "Rework date", "status"),
  dateF("rework_end_date", "Rework ended", "status"),
  str("rework_notes", "Rework notes", "status"),
  // Total loss decision (timestamptz — local-date in the runner)
  dateTzF("total_loss_decided_at", "Total loss decided", "status"),
  // Contact (free-text SF contact string; section=customer alongside the account FK)
  str("fcr_collision_contact", "Contact", "customer"),
  // Computed day-counts (require reports ≥ v0.7.0). Central-tz calendar day (tzToday), matching the record
  // page's dayDiff, so counts don't drift a day in the evening (UTC). filterable ⇒ the past_due view filters.
  // NOT summable (the computed default): a now()-based count drifts daily and blends open rows, so a SUM/AVG
  // of it is meaningless.
  computed("number", "days_in_status", "Days in status", "status", `${tzToday} - trailer.status_date`),
  // NULL unless invoiced-and-unpaid (invoice_date set, invoice_paid_date null) — exactly the old bespoke SQL.
  computed("number", "days_past_due", "Days past due", "status", `CASE WHEN trailer.invoice_date IS NOT NULL AND trailer.invoice_paid_date IS NULL THEN ${tzToday} - trailer.invoice_date END`),
  // Turn-time durations (#26 Ship 3). Reproduce the SF FORMULA fields verbatim (FCR_Collision_Trailer__c
  // describe): `IF(ISBLANK(end), TODAY() - start, end - start)` → elapsed-so-far when the end date is missing,
  // else the completed span (see sfDuration). These are OPEN-INCLUSIVE (a still-open trailer contributes its
  // partial elapsed days), so — like the day-counts above — they are DISPLAY-ONLY and left NOT summable: an
  // AVG/SUM would blend in-progress rows, drift daily, and not be reproducible for a past date. The reports
  // show them as detail columns, they don't aggregate them.
  computed("number", "notification_to_arrival_duration", "Notification → arrival (days)", "turnaround", sfDuration("trailer.arrival_date", "trailer.notify_date")),
  computed("number", "approved_to_complete_duration", "Approved → complete (days)", "turnaround", sfDuration("trailer.repair_completion_date", "trailer.estimate_approved_date")),
  computed("number", "repair_in_progress_duration", "Repair in progress (days)", "turnaround", sfDuration("trailer.repair_completion_date", "trailer.repair_start_date")),
  computed("number", "repair_completion_to_delivery_duration", "Repair complete → delivery (days)", "turnaround", sfDuration("trailer.delivery_date", "trailer.repair_completion_date")),
  // SF returns NULL when there is no arrival date at all (not an elapsed count) — preserve that. Open-inclusive
  // once arrival exists, so also display-only / not summable.
  computed("number", "pickup_to_delivery", "Pickup → delivery (days)", "turnaround", `CASE WHEN trailer.arrival_date IS NULL THEN NULL ELSE COALESCE(trailer.delivery_date, ${tzToday}) - trailer.arrival_date END`),
  // The ONLY summable duration: a plain completed-minus-started span (no now() branch → NULL until both dates
  // exist → completed rows only), so an AVG is a stable, reproducible turn-time KPI. SF's Bi-Weekly report
  // AVGs exactly this field.
  computed("number", "estimate_start_to_complete_duration", "Estimate start → complete (days)", "turnaround", "trailer.estimate_completed_date - trailer.estimate_start_date", { summable: true }),
  // Customer (one-hop join)
  str("customer_name", "Customer", "customer", "customer.sf_name"),
  str("customer_city", "Customer city", "customer", "customer.billing_city"),
  str("customer_state", "Customer state", "customer", "customer.billing_state"),
];

export type TrailerObjectOptions = {
  /** Object gate — may this principal report on trailers at all. Required (see truck.ts header). */
  capability: (p: Principal) => boolean;
  /** Detail-page hyperlink for tabular rows (app routing). The /records/trailer/[id] route is DARK behind
   *  a flag, so callers typically pass a `linkEnabled` that mirrors it. */
  link?: { path: string; href: (id: string) => string };
  /** Optional per-run gate for `link` (e.g. RECORDS_TRAILER_LIVE). Absent ⇒ link always active. */
  linkEnabled?: () => boolean;
  /** Row-level owner column; null ⇒ shared data (v1 default). */
  ownerField?: string | null;
  /** Row-scope widening predicate (forward hook for per-owner objects). */
  seesAllCapability?: (p: Principal) => boolean;
};

/** Build the trailer RegistryObject, injecting the app's gate + routing. */
export function trailerObject(opts: TrailerObjectOptions): RegistryObject {
  return {
    key: "trailer",
    label: "Trailers",
    description: "Collision trailer units. Read-only.",
    table: "fcr_core.trailer",
    // Same many-to-one customer join as truck, but trailer's FK column is `fcr_collision_account`
    // (nullable — fine for a LEFT JOIN). customer.sf_id is UNIQUE, so no row multiplication; the
    // soft-delete/test exclusion rides the ON clause to keep LEFT JOIN semantics.
    join: { alias: "customer", sql: "LEFT JOIN fcr_core.customer customer ON trailer.fcr_collision_account = customer.sf_id AND customer.deleted_at IS NULL AND customer.is_test = false" },
    baseWhere: "trailer.deleted_at IS NULL AND trailer.is_test = false",
    capability: opts.capability,
    ownerField: opts.ownerField ?? null, // shared data — v1 admins are all-scope
    seesAllCapability: opts.seesAllCapability,
    link: opts.link,
    linkEnabled: opts.linkEnabled,
    fields: trailerFields,
  };
}
