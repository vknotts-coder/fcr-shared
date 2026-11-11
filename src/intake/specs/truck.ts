// Truck intake spec — CREATE + a simple pickup seed-status, matching what fcr-sales' truck
// intake does today (which just defaults status to "Awaiting Pickup Info"). The full truck
// status↔date engine is a DEFERRED slice: unlike trailers, the truck SF flow is not specced in
// the repo (it lives in the SF audit; SF behavior is a Robert arrow). We do NOT invent it —
// this seeds the initial status from the pickup arrangement and stamps status_date on a manual
// status change, nothing more. Columns verified against fcr-dispatch db/fcr_core.schema.sql.

import { today } from "../../reports/dates.js";
import { isBlank, makeChanged, US_STATES, VIN_MAX_LENGTH, YES_NO } from "../coerce.js";
import type { EngineResult, FormField, IntakeSpec, ValidationError } from "../types.js";

const CUSTOMER_DROP_OFF_MODE = "Customer Drop Off";
const PICKUP_MODES = ["Tow", "Drive", "Customer Drop Off", "Other"];
const SHOPS = ["Livingston", "Sparta"];
const SALES_TEAMS = ["Team A", "Team B", "Team C"];
// Truck Make — the SF Truck_Make__c RESTRICTED picklist (Jordan, 2026-11-11: "same as salesforce"). A write
// outside this set dead-letters at SF's picklist, so the form offers only these and validateTruck refuses an
// off-list CHANGED value (scoped like estimator_name — a legacy free-text make on an unrelated edit is left be).
const TRUCK_MAKES = ["Freightliner", "International", "Kenworth", "Volvo", "Peterbilt", "Mack", "Other"];

// The SF Estimator_Name__c RESTRICTED picklist (active values, verified against the live org 2026-10-21):
// estimator initials, NOT names. estimator_name WILL reverse-sync to SF's Estimator_Name__c once the paired
// fcr-dispatch map addition lands (fcr-estimating#18 S2 — it is not in any reverse-sync allowlist in THIS PR
// alone); restricting to the picklist here keeps an app write from dead-lettering at SF's restricted picklist
// when that lands. Exported as the single source of truth for the estimating assignment board's columns.
export const ESTIMATOR_NAMES = ["JR", "BH", "JS", "AR"];

// The truck statuses relevant at intake. The downstream pipeline statuses are intentionally NOT
// enumerated here (they belong to the deferred truck-flow slice, keyed off the SF audit); the
// status is engine-seeded on create and free to be set by a later, specced edit path.
const TRUCK_INTAKE_STATUSES = ["Awaiting Pickup Info", "Awaiting Pickup", "Customer Drop Off"];

// Estimate-information edit surface (epic fcr-estimating#60 S2): the labor-hour components + line count +
// both sales-$ figures coerce as numbers; the estimate dates coerce as dates. All verified updateable:true,
// calculated:false against the live FCR_Collision_Truck__c (2026-11-10), and each reverse-syncs Core→SF via
// fcr-dispatch TRUCK_EDIT_COLS. The sales-$ columns (total_sales / finalized_total_sales) are editable by the
// estimating department (they own the number) — visibility is opened to all estimating staff in the app layer
// (fcr-estimating resolvePrincipal), NOT here. The computed rollups total_estimated_hours / finalized_total_hours
// are NOT columns and are NOT editable (SF formula fields) — the UI edits the components; SF recomputes.
export const TRUCK_NUMERIC_COLS = new Set<string>([
  "body_hours", "body_s_hours", "frame_hours", "mechanical_hours", "refinish_hours",
  "finalized_body_hours", "finalized_frame_hours", "finalized_mechanical_hours",
  "finalized_refinish_hours", "total_billed_hours", "total_lines_on_estimate",
  "total_sales", "finalized_total_sales",
]);
export const TRUCK_DATE_COLS = new Set<string>([
  "notify_date", "status_date",
  "estimate_sent_date", "estimate_completed", "estimate_approved", "estimate_finalized",
  "revised_esimate_date",
]);
// `rework` is a real boolean column edited via a Yes/No <select>; coerced to true/false/null (blank) so the
// value binds to the boolean column (mirrors TRAILER_BOOL_COLS). Added with the billing section (epic #28 B).
export const TRUCK_BOOL_COLS = new Set(["rework"]);

// The pickup-address columns, in one place: the create-time status seed (applyTruckStatusEngine) and the
// Awaiting-Pickup validation both key off "is any pickup-address field present". Shared so a column add/rename
// can't let the two drift apart.
const PICKUP_ADDR_FIELDS = ["pickup_street_address", "pickup_city", "pickup_state", "pickup_zip_code"];

export const TRUCK_FORM_FIELDS: FormField[] = [
  // Information
  { column: "sf_name", label: "Unit #", section: "information", input: "text" },
  { column: "fcr_collision_customer", label: "Account (SF id)", section: "information", input: "text" },
  { column: "fcr_collision_contacts", label: "Contact (SF id)", section: "information", input: "text" },
  { column: "status", label: "Status", section: "information", input: "select", options: ["", ...TRUCK_INTAKE_STATUSES] },
  { column: "vin", label: "VIN", section: "information", input: "text" },
  { column: "truck_make", label: "Make", section: "information", input: "select", options: ["", ...TRUCK_MAKES] },
  { column: "shop", label: "Shop", section: "information", input: "select", options: ["", ...SHOPS] },
  { column: "sales_team", label: "Sales Team", section: "information", input: "select", options: ["", ...SALES_TEAMS] },
  { column: "estimator_name", label: "Estimator", section: "information", input: "select", options: ["", ...ESTIMATOR_NAMES] },
  // Incoming Transportation
  { column: "notify_date", label: "Notify Date", section: "incoming_transport", input: "date" },
  { column: "pickup_location_name", label: "Pickup Location", section: "incoming_transport", input: "text" },
  { column: "pickup_street_address", label: "Pickup Address", section: "incoming_transport", input: "text" },
  { column: "pickup_city", label: "Pickup City", section: "incoming_transport", input: "text" },
  { column: "pickup_state", label: "Pickup State", section: "incoming_transport", input: "select", options: ["", ...US_STATES] },
  { column: "pickup_zip_code", label: "Pickup ZIP", section: "incoming_transport", input: "text" },
  { column: "pickup_tow_drive", label: "Pickup Mode", section: "incoming_transport", input: "select", options: ["", ...PICKUP_MODES] },
  { column: "pickup_notes", label: "Pickup Notes", section: "incoming_transport", input: "textarea" },
  // Invoice / Rework — SF-parity invoice numbers + the rework flag, in the SF page-layout sections. These
  // reverse-sync Core→SF field-scoped via fcr-dispatch TRUCK_EDIT_COLS (invoice_1-4 + rework, added in #391);
  // updateUnit records whichever of them actually changed into dispatch_dirty_cols, so the push sends only the
  // edited field. invoice_* are free-text numbers; rework is a Yes/No boolean (coerced via TRUCK_BOOL_COLS).
  // epic fcr-estimating#28 Slice B.
  { column: "invoice_1", label: "Invoice #1", section: "invoice", input: "text" },
  { column: "invoice_2", label: "Invoice #2", section: "invoice", input: "text" },
  { column: "invoice_3", label: "Invoice #3", section: "invoice", input: "text" },
  { column: "invoice_4", label: "Invoice #4", section: "invoice", input: "text" },
  { column: "rework", label: "Rework?", section: "rework", input: "select", options: ["", ...YES_NO] },

  // Estimate Information (epic fcr-estimating#60 S2) — the estimating department's day-to-day edit surface.
  // Dates + per-area labor hours + line count + estimate notes + Total Sales. total_sales is editable by the
  // estimating staff who own the figure (money visibility is opened app-side, not gated here). The computed
  // rollup total_estimated_hours is NOT here — it is a SF formula (sum of the components), recomputed by SF.
  { column: "estimate_sent_date", label: "Estimate Sent", section: "estimate", input: "date" },
  { column: "estimate_completed", label: "Estimate Completed", section: "estimate", input: "date" },
  { column: "estimate_approved", label: "Estimate Approved", section: "estimate", input: "date" },
  { column: "estimate_finalized", label: "Estimate Finalized", section: "estimate", input: "date" },
  { column: "body_hours", label: "Body Hours", section: "estimate", input: "number" },
  { column: "body_s_hours", label: "Body-S Hours", section: "estimate", input: "number" },
  { column: "frame_hours", label: "Frame Hours", section: "estimate", input: "number" },
  { column: "mechanical_hours", label: "Mechanical Hours", section: "estimate", input: "number" },
  { column: "refinish_hours", label: "Refinish Hours", section: "estimate", input: "number" },
  { column: "total_lines_on_estimate", label: "Lines on Estimate", section: "estimate", input: "number" },
  { column: "estimate_notes", label: "Estimate Notes", section: "estimate", input: "textarea" },
  { column: "revised_esimate_date", label: "Revised Estimate Date", section: "estimate", input: "date" },
  { column: "revised_estimate_notes", label: "Revised Estimate Notes", section: "estimate", input: "textarea" },
  // Tires — SF Tires__c Yes/No picklist (Jordan, 2026-11-11). License Tag (also SF Yes/No) lands in its own
  // cross-repo slice once the fcr_core.license_tag column + sync exist.
  { column: "tires", label: "Tires", section: "estimate", input: "select", options: ["", ...YES_NO] },
  { column: "total_sales", label: "Total Sales", section: "estimate", input: "number" },

  // Finalized Estimate Information (epic fcr-estimating#60 S2) — finalized per-area hours + billed hours +
  // Finalized Total Sales. finalized_total_hours (rollup) is omitted for the same reason as total_estimated_hours.
  { column: "finalized_body_hours", label: "Finalized Body Hours", section: "finalized", input: "number" },
  { column: "finalized_frame_hours", label: "Finalized Frame Hours", section: "finalized", input: "number" },
  { column: "finalized_mechanical_hours", label: "Finalized Mechanical Hours", section: "finalized", input: "number" },
  { column: "finalized_refinish_hours", label: "Finalized Refinish Hours", section: "finalized", input: "number" },
  { column: "total_billed_hours", label: "Total Billed Hours", section: "finalized", input: "number" },
  { column: "finalized_total_sales", label: "Finalized Total Sales", section: "finalized", input: "number" },
];

/** Truck status seed/stamp. CREATE: seed status from the pickup arrangement (Customer Drop Off
 *  mode → "Customer Drop Off"; a pickup address → "Awaiting Pickup"; else "Awaiting Pickup Info"),
 *  set notify_date + status_date to today if blank. UPDATE: a manual status change stamps
 *  status_date today (no milestone back-fill — deferred). No emails (truck alerts unspecced). */
export function applyTruckStatusEngine(
  before: Record<string, unknown>,
  edits: Record<string, unknown>,
  opts: { isNew?: boolean; today?: string } = {},
): EngineResult {
  const todayStr = opts.today ?? today();
  const eff = (field: string): unknown => (field in edits ? edits[field] : before[field]);
  const derived: Record<string, unknown> = {};
  const fromStatus = (before.status as string | null) ?? null;

  if (opts.isNew) {
    const mode = eff("pickup_tow_drive");
    const hasPickupAddr = PICKUP_ADDR_FIELDS.some((f) => !isBlank(eff(f)));
    let initial: string;
    if (mode === CUSTOMER_DROP_OFF_MODE) initial = "Customer Drop Off";
    else if (hasPickupAddr) initial = "Awaiting Pickup";
    else initial = "Awaiting Pickup Info";
    // Only seed the status when the user didn't pick one explicitly.
    if (isBlank(eff("status"))) derived.status = initial;
    if (isBlank(eff("notify_date"))) derived.notify_date = todayStr;
    derived.status_date = todayStr;
    return { derived, statusChanged: true, fromStatus, toStatus: (derived.status as string) ?? (eff("status") as string) ?? initial, emails: [] };
  }

  const manual = "status" in edits && !isBlank(edits.status) && edits.status !== fromStatus ? (edits.status as string) : null;
  if (manual) derived.status_date = todayStr;
  return { derived, statusChanged: !!manual, fromStatus, toStatus: manual ?? fromStatus, emails: [] };
}

export function validateTruck(
  state: Record<string, unknown>,
  opts: { isNew?: boolean; before?: Record<string, unknown> } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const status = state.status;

  // Scope each merged-before-image rule to the fields the edit CHANGED (see makeChanged). Used by the
  // estimator_name and Awaiting-Pickup rules below.
  const changed = makeChanged(state, opts.before);

  // VIN fits the fcr_core.truck.vin column (varchar 17) — reject over-length as a friendly error
  // rather than letting the INSERT overflow and 500.
  if (typeof state.vin === "string" && state.vin.trim().length > VIN_MAX_LENGTH) {
    errors.push({ field: "vin", message: `VIN must be ${VIN_MAX_LENGTH} characters or fewer.` });
  }

  // estimator_name reverse-syncs to the SF Estimator_Name__c RESTRICTED picklist — refuse a value outside the
  // active set so an app write (board assign / record edit) can't dead-letter at SF. Blank is allowed (clears).
  // ⚠ Scope this to the value actually being SET: updateUnit validates the MERGED before-image, and legacy rows
  // hold out-of-domain values (the retired estimating runTransition wrote full names like "Jordan"). Only
  // validating a CHANGED value keeps an unchanged legacy estimator_name from freezing edits to unrelated fields
  // (there is no DB backstop, unlike VIN's varchar(17)). On create (no before) every value is "changed".
  if (
    changed(["estimator_name"]) &&
    typeof state.estimator_name === "string" &&
    !isBlank(state.estimator_name) &&
    !ESTIMATOR_NAMES.includes(state.estimator_name)
  ) {
    errors.push({ field: "estimator_name", message: `Estimator must be one of: ${ESTIMATOR_NAMES.join(", ")}.` });
  }

  // truck_make + tires reverse-sync to SF RESTRICTED picklists (Truck_Make__c / Tires__c), so an off-domain
  // write dead-letters at SF. Refuse a value outside the set — but ONLY when the edit CHANGED it (same reasoning
  // as estimator_name): legacy rows hold free-text makes the old SF had, and there's no DB backstop (both are
  // plain text columns), so validating the merged before-image unconditionally would freeze edits to unrelated
  // fields on such a row. Blank is allowed (clears). On create (no before) every value is "changed".
  if (
    changed(["truck_make"]) &&
    typeof state.truck_make === "string" &&
    !isBlank(state.truck_make) &&
    !TRUCK_MAKES.includes(state.truck_make)
  ) {
    errors.push({ field: "truck_make", message: `Make must be one of: ${TRUCK_MAKES.join(", ")}.` });
  }
  if (
    changed(["tires"]) &&
    typeof state.tires === "string" &&
    !isBlank(state.tires) &&
    !YES_NO.includes(state.tires)
  ) {
    errors.push({ field: "tires", message: `Tires must be one of: ${YES_NO.join(", ")}.` });
  }

  // Awaiting-Pickup requires a pickup address (or a customer drop-off). ⚠ Scope this to an edit that actually
  // TOUCHES the coupling — status, pickup mode, or an address field — mirroring the estimator_name rule above.
  // updateUnit validates the MERGED before-image, and legacy "Awaiting Pickup" rows can carry no stored address,
  // so without this guard an edit to an unrelated field (e.g. an invoice number or the rework flag) on such a row
  // is frozen with no way to satisfy it. On create (no before) every field is "changed".
  if (
    changed(["status", "pickup_tow_drive", ...PICKUP_ADDR_FIELDS]) &&
    status === "Awaiting Pickup" &&
    state.pickup_tow_drive !== CUSTOMER_DROP_OFF_MODE &&
    PICKUP_ADDR_FIELDS.every((f) => isBlank(state[f]))
  ) {
    errors.push({ field: "pickup_street_address", message: "Status can not be Awaiting Pickup unless there is a pickup address or this is a customer drop off." });
  }
  if (opts.isNew) {
    if (isBlank(state.fcr_collision_customer)) {
      errors.push({ field: "fcr_collision_customer", message: "FCR Collision Account is a required field. Please select the Account." });
    }
    if (isBlank(state.fcr_collision_contacts)) {
      errors.push({ field: "fcr_collision_contacts", message: "FCR Collision Contact is a required field. Please select the Contact." });
    }
  }
  return errors;
}

export const truckSpec: IntakeSpec = {
  unitType: "truck",
  table: "truck",
  formFields: TRUCK_FORM_FIELDS,
  numericCols: TRUCK_NUMERIC_COLS,
  dateCols: TRUCK_DATE_COLS,
  boolCols: TRUCK_BOOL_COLS,
  references: [
    { column: "fcr_collision_customer", table: "customer", label: "FCR Collision Account" },
    { column: "fcr_collision_contacts", table: "unit_contact", label: "FCR Collision Contact" },
  ],
  vinColumn: "vin",
  nameColumn: "sf_name",
  customerRefColumn: "fcr_collision_customer",
  contactRefColumn: "fcr_collision_contacts",
  engine: applyTruckStatusEngine,
  validate: validateTruck,
};
