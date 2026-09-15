// Truck intake spec — CREATE + a simple pickup seed-status, matching what fcr-sales' truck
// intake does today (which just defaults status to "Awaiting Pickup Info"). The full truck
// status↔date engine is a DEFERRED slice: unlike trailers, the truck SF flow is not specced in
// the repo (it lives in the SF audit; SF behavior is a Robert arrow). We do NOT invent it —
// this seeds the initial status from the pickup arrangement and stamps status_date on a manual
// status change, nothing more. Columns verified against fcr-dispatch db/fcr_core.schema.sql.

import { today } from "../../reports/dates.js";
import { isBlank, US_STATES, VIN_MAX_LENGTH } from "../coerce.js";
import type { EngineResult, FormField, IntakeSpec, ValidationError } from "../types.js";

const CUSTOMER_DROP_OFF_MODE = "Customer Drop Off";
const PICKUP_MODES = ["Tow", "Drive", "Customer Drop Off", "Other"];
const SHOPS = ["Livingston", "Sparta"];
const SALES_TEAMS = ["Team A", "Team B", "Team C"];

// The truck statuses relevant at intake. The downstream pipeline statuses are intentionally NOT
// enumerated here (they belong to the deferred truck-flow slice, keyed off the SF audit); the
// status is engine-seeded on create and free to be set by a later, specced edit path.
const TRUCK_INTAKE_STATUSES = ["Awaiting Pickup Info", "Awaiting Pickup", "Customer Drop Off"];

export const TRUCK_NUMERIC_COLS = new Set<string>([]);
export const TRUCK_DATE_COLS = new Set<string>(["notify_date", "status_date"]);

export const TRUCK_FORM_FIELDS: FormField[] = [
  // Information
  { column: "sf_name", label: "Unit #", section: "information", input: "text" },
  { column: "fcr_collision_customer", label: "Account (SF id)", section: "information", input: "text" },
  { column: "fcr_collision_contacts", label: "Contact (SF id)", section: "information", input: "text" },
  { column: "status", label: "Status", section: "information", input: "select", options: ["", ...TRUCK_INTAKE_STATUSES] },
  { column: "vin", label: "VIN", section: "information", input: "text" },
  { column: "truck_make", label: "Make", section: "information", input: "text" },
  { column: "shop", label: "Shop", section: "information", input: "select", options: ["", ...SHOPS] },
  { column: "sales_team", label: "Sales Team", section: "information", input: "select", options: ["", ...SALES_TEAMS] },
  // Incoming Transportation
  { column: "notify_date", label: "Notify Date", section: "incoming_transport", input: "date" },
  { column: "pickup_location_name", label: "Pickup Location", section: "incoming_transport", input: "text" },
  { column: "pickup_street_address", label: "Pickup Address", section: "incoming_transport", input: "text" },
  { column: "pickup_city", label: "Pickup City", section: "incoming_transport", input: "text" },
  { column: "pickup_state", label: "Pickup State", section: "incoming_transport", input: "select", options: ["", ...US_STATES] },
  { column: "pickup_zip_code", label: "Pickup ZIP", section: "incoming_transport", input: "text" },
  { column: "pickup_tow_drive", label: "Pickup Mode", section: "incoming_transport", input: "select", options: ["", ...PICKUP_MODES] },
  { column: "pickup_notes", label: "Pickup Notes", section: "incoming_transport", input: "textarea" },
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
    const hasPickupAddr = ["pickup_street_address", "pickup_city", "pickup_state", "pickup_zip_code"].some(
      (f) => !isBlank(eff(f)),
    );
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
  opts: { isNew?: boolean } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const status = state.status;

  // VIN fits the fcr_core.truck.vin column (varchar 17) — reject over-length as a friendly error
  // rather than letting the INSERT overflow and 500.
  if (typeof state.vin === "string" && state.vin.trim().length > VIN_MAX_LENGTH) {
    errors.push({ field: "vin", message: `VIN must be ${VIN_MAX_LENGTH} characters or fewer.` });
  }

  if (
    status === "Awaiting Pickup" &&
    state.pickup_tow_drive !== CUSTOMER_DROP_OFF_MODE &&
    ["pickup_street_address", "pickup_city", "pickup_state", "pickup_zip_code"].every((f) => isBlank(state[f]))
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
  references: [
    { column: "fcr_collision_customer", table: "customer", label: "FCR Collision Account" },
    { column: "fcr_collision_contacts", table: "unit_contact", label: "FCR Collision Contact" },
  ],
  vinColumn: "vin",
  nameColumn: "sf_name",
  engine: applyTruckStatusEngine,
  validate: validateTruck,
};
