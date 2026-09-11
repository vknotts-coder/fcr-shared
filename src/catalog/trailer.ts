// Trailer reportable-object catalog (#107 Slice 1 — lifted verbatim from fcr-dispatch's registry.ts
// TRAILER). Parallels truck.ts but over the ASYMMETRIC trailer table (verified against
// db/fcr_core.schema.sql, 2026-09-03): the customer link is `fcr_collision_account` (not
// `fcr_collision_customer`), financials are total_repair_cost/labor_amount (no total_sales), mileage is
// incoming/outgoing (no per-trip miles), and there is NO shop/team_leader/estimator/delivery_location or
// swap/tow_drive column. As with truck, the app-specific gate + link/linkEnabled are injected; the schema
// half is shared. See truck.ts header for why `capability` is required and never defaulted.

import type { Principal } from "../contracts/index.js";
import type { RegistryField, RegistryObject } from "../reports/registry-core.js";
import { str, dateF, dateTzF, numF, money } from "./fields.js";

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
