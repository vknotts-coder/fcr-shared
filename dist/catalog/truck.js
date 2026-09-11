// Truck reportable-object catalog (#107 Slice 1 — lifted verbatim from fcr-dispatch's registry.ts TRUCK).
// The SCHEMA half of the object def (table/join/baseWhere/fields) — the fcr_core coupling — lives here so
// every app shares ONE source of truth instead of copy-pasting it. The app-SPECIFIC half is injected:
//   • `capability` — the object gate (v1 admin-only). REQUIRED, never defaulted: the permission model is
//     Module 1 (unscoped), so the consuming app supplies its gate and Module 1 rewires policy without a
//     package bump. Pass `isAdmin` from @fcr/core/reports for the v1 behavior.
//   • `link` / `linkEnabled` — the detail-page route + its flag, which are app routing, not schema.
//
// Column paths verified against fcr-dispatch db/fcr_core.schema.sql (2026-09-03). Money/mileage columns are
// stored as SF-synced text on some rows; the runner casts numeric/money aggregates (SUM/AVG) explicitly.
import { str, dateF, dateTzF, numF, money } from "./fields.js";
/** The truck object's field table (schema-coupled; identical across apps). */
export const truckFields = [
    // Identity
    str("sf_name", "Unit #", "identity"),
    str("status", "Status", "status"),
    str("shop", "Shop", "identity"),
    str("team_leader", "Team leader", "identity"),
    str("estimator_name", "Estimator", "identity"),
    str("sales_team", "Sales team", "identity"),
    // Status / lifecycle dates
    dateF("status_date", "Status date", "status"),
    dateF("notify_date", "Notified", "status"),
    dateTzF("created_at", "Created", "status"), // timestamptz — local-date in the runner
    dateF("arrival_date", "Arrived", "status"),
    dateF("repair_completion_date", "Repair complete", "status"),
    dateF("invoice_date", "Invoiced", "status"),
    dateF("invoice_paid_date", "Invoice paid", "status"),
    // Pickup leg
    str("pickup_driver", "Pickup driver", "pickup"),
    str("pickup_location_name", "Pickup location", "pickup"),
    str("pickup_city", "Pickup city", "pickup"),
    str("pickup_state", "Pickup state", "pickup"),
    numF("pickup_miles_one_way", "Pickup miles (1-way)", "pickup"),
    dateF("driver_dispatched_date", "Pickup dispatched", "pickup"),
    dateF("anticipated_pickup_date", "Anticipated pickup", "pickup"),
    // Delivery leg
    str("delivery_driver", "Delivery driver", "delivery"),
    str("delivery_location_name", "Delivery location", "delivery"),
    str("delivery_city", "Delivery city", "delivery"),
    str("delivery_state", "Delivery state", "delivery"),
    numF("delivery_miles_one_way", "Delivery miles (1-way)", "delivery"),
    dateF("delivery_eta", "Delivery ETA", "delivery"),
    // Financials (sensitive — gated per-field by can('view', <obj>, {section:'financials', field}))
    money("total_sales", "Total sales", "financials"),
    money("finalized_total_sales", "Finalized total sales", "financials"),
    // List-view parity fields (added for the Salesforce-style List Views surface; all verified against
    // db/fcr_core.schema.sql — vin varchar(17), invoice_1 varchar(30), the *_date columns are real `date`,
    // repair_notes/parts_information/delivery_tow_drive/fcr_collision_contacts are `text`). Non-sensitive:
    // invoice_1 is an invoice NUMBER (identifier), not a dollar amount, so it is not financials-gated.
    str("vin", "VIN", "identity"),
    str("invoice_1", "Invoice #", "status"),
    str("contacts", "Contacts", "customer", "fcr_collision_contacts"),
    dateF("estimate_completed", "Estimate completed", "status"),
    dateF("estimate_finalized", "Estimate finalized", "status"),
    dateF("estimate_approved", "Estimate approved", "status"),
    dateF("awaiting_parts_date", "Awaiting parts", "status"),
    str("parts_information", "Parts info", "status"),
    dateF("parts_eta_date", "Parts ETA", "status"),
    dateF("repair_start_date", "Repair started", "status"),
    dateF("repair_goal", "Repair goal", "status"),
    str("repair_notes", "Repair notes", "status"),
    dateF("delivery_date", "Delivered on", "delivery"),
    str("delivery_tow_drive", "Delivery mode", "delivery"),
    // Customer (one-hop join)
    str("customer_name", "Customer", "customer", "customer.sf_name"),
    str("customer_city", "Customer city", "customer", "customer.billing_city"),
    str("customer_state", "Customer state", "customer", "customer.billing_state"),
];
/** Build the truck RegistryObject, injecting the app's gate + routing. */
export function truckObject(opts) {
    return {
        key: "truck",
        label: "Trucks",
        description: "Collision truck units. Everything on the dispatch board, reportable. Read-only.",
        table: "fcr_core.truck",
        // customer.sf_id is UNIQUE (customer_sf_id_key) → many-to-one, no row multiplication. The soft-delete/
        // test exclusion rides the ON clause so a deleted/test customer can't leak into or mis-bucket a report.
        join: { alias: "customer", sql: "LEFT JOIN fcr_core.customer customer ON truck.fcr_collision_customer = customer.sf_id AND customer.deleted_at IS NULL AND customer.is_test = false" },
        baseWhere: "truck.deleted_at IS NULL AND truck.is_test = false",
        capability: opts.capability,
        ownerField: opts.ownerField ?? null, // shared data — v1 admins are all-scope
        seesAllCapability: opts.seesAllCapability,
        link: opts.link,
        linkEnabled: opts.linkEnabled,
        fields: truckFields,
    };
}
