// Trailer intake spec — lifted from fcr-trailers' lib/trailer/{constants,form-fields,
// status-engine,validation}.ts. The status engine is a faithful reproduction of the active SF
// flow FCR_Collision_Trailers (spec §6.1); the validators reproduce its VRs (spec §5). Pure +
// synchronous. Only the app coupling (TRAILER_STATUS_ORDER, centralToday, SectionKey) is
// internalized so the module carries no fcr-trailers import.

import { today } from "../../reports/dates.js";
import { isBlank, US_STATES, VIN_MAX_LENGTH } from "../coerce.js";
import type { EngineResult, FormField, IntakeSpec, ValidationError } from "../types.js";

// The two special pickup/delivery "driver" values the SF validation rules key on.
const CUSTOMER_DROP_OFF = "CUSTOMER DROP OFF";
const CUSTOMER_PICKUP = "CUSTOMER PICKUP";

// Canonical status order (sort/classification source) — the form's status options reuse it.
const TRAILER_STATUS_ORDER: string[] = [
  "Awaiting Pickup Info", "Awaiting Pickup", "Customer Drop Off", "Dispatch (Pickup)",
  "Received", "Estimating", "Awaiting Approval", "Approved", "Awaiting Parts", "LEGAL HOLD",
  "Parts Received", "Repair in Progress", "Repair Complete", "Awaiting Delivery Info",
  "Awaiting Delivery", "Awaiting Customer Pickup", "Delivery Dispatch", "Delivered",
  "Total Loss", "REWORK", "Hold", "Do Not Repair",
];

const TYPES = ["Dry Van", "Reefer", "Flat Bed", "Tanker", "Box Truck", "Other"];
const YES_NO = ["Yes", "No"];
const REPAIR_TEAMS = ["DS", "JL", "JV", "MJ", "TR", "AE"];
const SALES_TEAMS = ["Team A", "Team B", "Team C"];

export const TRAILER_NUMERIC_COLS = new Set([
  "incoming_mileage", "outgoing_mileage", "estimated_hours", "actual_hours",
  "completetion_percentage", "labor_amount", "total_repair_cost",
]);
export const TRAILER_DATE_COLS = new Set([
  "notify_date", "anticipated_arrival_date", "pickup_eta", "pickup_dispatch_date", "arrival_date",
  "estimate_start_date", "estimate_completed_date", "estimate_sent_date", "estimate_approved_date",
  "estimate_finalized", "parts_eta_date_stamped", "all_parts_received_date_stamped",
  "repair_start_date", "repair_goal", "repair_completion_date",
  "delivery_eta", "delivery_dispatch_date", "delivery_date", "invoice_date", "invoice_paid_date",
  "status_date", "rework_date", "rework_start_date", "rework_end_date",
]);
// Boolean columns edited via a Yes/No select (the DB column is a real boolean, not text). Only
// `rework` today; coerced to true/false/null so the value binds correctly to the boolean column.
export const TRAILER_BOOL_COLS = new Set(["rework"]);

export const TRAILER_FORM_FIELDS: FormField[] = [
  // Information
  { column: "sf_name", label: "Unit #", section: "information", input: "text" },
  { column: "fcr_collision_account", label: "Account (SF id)", section: "information", input: "text" },
  { column: "fcr_collision_contact", label: "Contact (SF id)", section: "information", input: "text" },
  { column: "status", label: "Status", section: "information", input: "select", options: ["", ...TRAILER_STATUS_ORDER] },
  { column: "type", label: "Type", section: "information", input: "select", options: ["", ...TYPES] },
  { column: "full_vin", label: "VIN", section: "information", input: "text" },
  { column: "team", label: "Repair Team", section: "information", input: "select", options: ["", ...REPAIR_TEAMS] },
  { column: "sales_team", label: "Sales Team", section: "information", input: "select", options: ["", ...SALES_TEAMS] },
  { column: "hours_of_operation", label: "Hours of Operation", section: "information", input: "text" },
  { column: "status_notes", label: "Status Notes", section: "information", input: "textarea" },
  // Incoming Transportation
  { column: "notify_date", label: "Notify Date", section: "incoming_transport", input: "date" },
  { column: "anticipated_arrival_date", label: "Anticipated Arrival", section: "incoming_transport", input: "date" },
  { column: "pickup_eta", label: "Pickup ETA", section: "incoming_transport", input: "date" },
  { column: "pickup_dispatch_date", label: "Pickup Dispatch", section: "incoming_transport", input: "date" },
  { column: "arrival_date", label: "Arrival Date", section: "incoming_transport", input: "date" },
  { column: "incoming_mileage", label: "Incoming Mileage", section: "incoming_transport", input: "number" },
  { column: "pickup_location_name", label: "Pickup Location", section: "incoming_transport", input: "text" },
  { column: "pickup_address", label: "Pickup Address", section: "incoming_transport", input: "text" },
  { column: "pickup_city", label: "Pickup City", section: "incoming_transport", input: "text" },
  { column: "pickup_state", label: "Pickup State", section: "incoming_transport", input: "select", options: ["", ...US_STATES] },
  { column: "pickup_zip_code", label: "Pickup ZIP", section: "incoming_transport", input: "text" },
  { column: "pickup_driver", label: "Pickup Driver", section: "incoming_transport", input: "select", options: ["", CUSTOMER_DROP_OFF] },
  { column: "swap_info_pickup", label: "Swap Info (Pickup)", section: "incoming_transport", input: "textarea" },
  { column: "pickup_notes", label: "Pickup Notes", section: "incoming_transport", input: "textarea" },
  // Estimate
  { column: "estimate_start_date", label: "Estimate Start", section: "estimate", input: "date" },
  { column: "estimate_completed_date", label: "Estimate Completed", section: "estimate", input: "date" },
  { column: "estimate_sent_date", label: "Estimate Sent", section: "estimate", input: "date" },
  { column: "estimate_approved_date", label: "Estimate Approved", section: "estimate", input: "date" },
  { column: "estimate_finalized", label: "Estimate Finalized", section: "estimate", input: "date" },
  { column: "estimated_hours", label: "Estimated Hours", section: "estimate", input: "number" },
  // Parts
  { column: "parts_available", label: "Parts Available", section: "parts", input: "select", options: ["", ...YES_NO] },
  { column: "parts_eta_date_stamped", label: "Parts ETA", section: "parts", input: "date" },
  { column: "all_parts_received_date_stamped", label: "All Parts Received", section: "parts", input: "date" },
  { column: "parts_notes", label: "Parts Notes", section: "parts", input: "textarea" },
  // Repair
  { column: "repair_start_date", label: "Repair Start", section: "repair", input: "date" },
  { column: "repair_goal", label: "Repair Goal", section: "repair", input: "date" },
  { column: "repair_completion_date", label: "Repair Completion", section: "repair", input: "date" },
  { column: "completetion_percentage", label: "Completion %", section: "repair", input: "number" },
  { column: "actual_hours", label: "Actual Hours", section: "repair", input: "number" },
  { column: "labor_amount", label: "Labor Amount", section: "repair", input: "number" },
  { column: "total_repair_cost", label: "Total Repair Cost", section: "repair", input: "number" },
  { column: "repair_notes", label: "Repair Notes", section: "repair", input: "textarea" },
  // Outgoing Transportation
  { column: "delivery_eta", label: "Delivery ETA", section: "outgoing_transport", input: "date" },
  { column: "delivery_dispatch_date", label: "Delivery Dispatch", section: "outgoing_transport", input: "date" },
  { column: "delivery_date", label: "Delivery Date", section: "outgoing_transport", input: "date" },
  { column: "delivery_address", label: "Delivery Address", section: "outgoing_transport", input: "text" },
  { column: "delivery_city", label: "Delivery City", section: "outgoing_transport", input: "text" },
  { column: "delivery_state", label: "Delivery State", section: "outgoing_transport", input: "select", options: ["", ...US_STATES] },
  { column: "delivery_zip_code", label: "Delivery ZIP", section: "outgoing_transport", input: "text" },
  { column: "delivery_driver", label: "Delivery Driver", section: "outgoing_transport", input: "select", options: ["", CUSTOMER_PICKUP] },
  { column: "outgoing_mileage", label: "Outgoing Mileage", section: "outgoing_transport", input: "number" },
  { column: "swap_info_delivery", label: "Swap Info (Delivery)", section: "outgoing_transport", input: "textarea" },
  // Invoice
  { column: "invoice_1", label: "Invoice #", section: "invoice", input: "text" },
  { column: "invoice_2", label: "Invoice #2", section: "invoice", input: "text" },
  { column: "invoicing_contact", label: "Invoicing Contact", section: "invoice", input: "text" },
  { column: "invoice_date", label: "Invoice Date", section: "invoice", input: "date" },
  { column: "invoice_paid_date", label: "Invoice Paid", section: "invoice", input: "date" },
  { column: "po", label: "PO", section: "invoice", input: "text" },
  { column: "invoice_notes", label: "Invoice Notes", section: "invoice", input: "textarea" },
  // Rework
  { column: "rework", label: "Rework", section: "rework", input: "select", options: ["", ...YES_NO] },
  { column: "rework_date", label: "Rework Date", section: "rework", input: "date" },
  { column: "rework_start_date", label: "Rework Start", section: "rework", input: "date" },
  { column: "rework_end_date", label: "Rework End", section: "rework", input: "date" },
  { column: "rework_notes", label: "Rework Notes", section: "rework", input: "textarea" },
];

// ── Status engine (SF flow FCR_Collision_Trailers) ────────────────────────────────
const DATE_TO_STATUS: { field: string; status: string }[] = [
  { field: "pickup_dispatch_date", status: "Dispatch (Pickup)" },
  { field: "arrival_date", status: "Received" },
  { field: "estimate_start_date", status: "Estimating" },
  { field: "estimate_completed_date", status: "Awaiting Approval" },
  { field: "estimate_approved_date", status: "Approved" },
  { field: "repair_start_date", status: "Repair in Progress" },
  { field: "repair_completion_date", status: "Repair Complete" },
  { field: "delivery_dispatch_date", status: "Delivery Dispatch" },
  { field: "delivery_date", status: "Delivered" },
];
const STATUS_TO_DATE: Record<string, string> = {
  "Dispatch (Pickup)": "pickup_dispatch_date",
  Received: "arrival_date",
  Estimating: "estimate_start_date",
  "Awaiting Approval": "estimate_completed_date",
  Approved: "estimate_approved_date",
  "Repair in Progress": "repair_start_date",
  "Repair Complete": "repair_completion_date",
  "Delivery Dispatch": "delivery_dispatch_date",
  Delivered: "delivery_date",
};
const STATUS_EMAIL: Record<string, string> = {
  "Awaiting Pickup": "FCR_Trailers_Awaiting_Pickup",
  "Dispatch (Pickup)": "FCR_Trailer_Pickup_Driver_Dispatched",
  Received: "FCR_Trailers_Received",
  "Awaiting Approval": "FCR_Trailers_Estimate_Complete",
  Approved: "FCR_Trailers_Estimate_Approved",
  "Repair Complete": "FCR_Trailers_Repair_Complete",
  "Awaiting Delivery": "FCR_Trailers_Awaiting_Delivery",
  "Awaiting Customer Pickup": "FCR_Trailers_Awaiting_Delivery",
  "Delivery Dispatch": "FCR_Trailer_Delivery_Driver_Dispatched",
};

function rank(s: unknown): number {
  const i = typeof s === "string" ? TRAILER_STATUS_ORDER.indexOf(s) : -1;
  return i === -1 ? -1 : i;
}

export function applyTrailerStatusEngine(
  before: Record<string, unknown>,
  edits: Record<string, unknown>,
  opts: { isNew?: boolean; today?: string } = {},
): EngineResult {
  const todayStr = opts.today ?? today();
  const eff = (field: string): unknown => (field in edits ? edits[field] : before[field]);
  const derived: Record<string, unknown> = {};
  const emails: string[] = [];
  const fromStatus = (before.status as string | null) ?? null;

  const setStatus = (status: string, statusDate: string) => {
    derived.status = status;
    derived.status_date = statusDate;
    const alert = STATUS_EMAIL[status];
    if (alert) emails.push(alert);
  };

  if (opts.isNew) {
    const driver = eff("pickup_driver");
    const hasPickupAddr = ["pickup_address", "pickup_city", "pickup_state", "pickup_zip_code"].some(
      (f) => !isBlank(eff(f)),
    );
    let initial: string;
    if (driver === CUSTOMER_DROP_OFF) initial = "Received";
    else if (hasPickupAddr) initial = "Awaiting Pickup";
    else initial = "Awaiting Pickup Info";
    if (isBlank(eff("notify_date"))) derived.notify_date = todayStr;
    setStatus(initial, todayStr);
    if (!emails.includes("FCR_Trailers_Awaiting_Pickup")) emails.push("FCR_Trailers_Awaiting_Pickup");
    applyCompletionAndRework(derived, edits, eff, before, todayStr, true);
    return { derived, statusChanged: true, fromStatus, toStatus: initial, emails };
  }

  let advanced: { status: string; date: string } | null = null;
  for (const { field, status } of DATE_TO_STATUS) {
    if (!isBlank(edits[field]) && isBlank(before[field])) {
      if (!advanced || rank(status) > rank(advanced.status)) {
        advanced = { status, date: String(edits[field]) };
      }
    }
  }
  const manual =
    "status" in edits && !isBlank(edits.status) && edits.status !== fromStatus ? (edits.status as string) : null;

  if (advanced && (!manual || rank(advanced.status) >= rank(manual))) {
    if (rank(advanced.status) > rank(fromStatus)) setStatus(advanced.status, advanced.date);
  } else if (manual) {
    setStatus(manual, todayStr);
    const dateField = STATUS_TO_DATE[manual];
    if (dateField && isBlank(eff(dateField))) derived[dateField] = todayStr;
  }

  const effStatus = (derived.status as string) ?? fromStatus;
  if (effStatus === "Approved" && eff("parts_available") === "No") {
    setStatus("Awaiting Parts", (derived.status_date as string) ?? todayStr);
  }
  // Invoice entered → stamp Invoice Date if blank (SF stamps it; no status change). SF keys off
  // BOTH Invoice_1 and Invoice_2, so a first-time entry of either stamps the date.
  const invoiceEntered =
    (!isBlank(edits.invoice_1) && isBlank(before.invoice_1)) ||
    (!isBlank(edits.invoice_2) && isBlank(before.invoice_2));
  if (invoiceEntered && isBlank(eff("invoice_date"))) derived.invoice_date = todayStr;
  if (!isBlank(edits.estimate_finalized) && isBlank(before.estimate_finalized)) {
    emails.push("FCR_Trailers_Estimate_Finalized");
  }

  applyCompletionAndRework(derived, edits, eff, before, todayStr, false);
  const toStatus = (derived.status as string | undefined) ?? fromStatus;
  return { derived, statusChanged: !!derived.status, fromStatus, toStatus: toStatus ?? null, emails };
}

function applyCompletionAndRework(
  derived: Record<string, unknown>,
  edits: Record<string, unknown>,
  eff: (f: string) => unknown,
  before: Record<string, unknown>,
  today: string,
  isNew: boolean,
): void {
  // Rework coupling — bidirectional + auto-date (SCOPE §924, Van 2026-09-16). The rework checkbox
  // and the REWORK status always agree, and turning rework on is TERMINAL: it overrides the
  // completion/delivery-routing derivations below, so status and the rework flag can never disagree
  // (the review found the old ordering let "Awaiting Customer Pickup" clobber status back while
  // rework stayed true). "Turning rework on" = the checkbox edited false→true (EDIT only — a
  // brand-new unit can't be in rework) OR the status picked → REWORK.
  const checkboxTurnedOn = !isNew && edits.rework === true && before.rework !== true;
  const statusPickedRework = edits.status === "REWORK" && before.status !== "REWORK";
  if (checkboxTurnedOn || statusPickedRework) {
    derived.rework = true;
    if (isBlank(eff("rework_date"))) derived.rework_date = today;
    // Advance status + stamp status_date ONLY on a real transition — re-ticking rework on a unit
    // already in REWORK must not re-stamp status_date or report a phantom status change.
    if (before.status !== "REWORK") {
      derived.status = "REWORK";
      derived.status_date = today;
      const name = (eff("sf_name") as string | null) ?? "";
      if (name && !/ - REWORK$/i.test(name)) derived.sf_name = `${name} - REWORK`;
    }
    return; // terminal — skip completion / delivery-routing so status can't be clobbered off REWORK
  }

  const effStatus = (derived.status as string) ?? (before.status as string | null);
  if (effStatus === "Repair Complete") derived.completetion_percentage = 100;
  if (effStatus === "Awaiting Delivery" && eff("delivery_driver") === CUSTOMER_PICKUP) {
    derived.status = "Awaiting Customer Pickup";
  }
}

// ── Validation (SF VRs §5) ────────────────────────────────────────────────────────
export function validateTrailer(
  state: Record<string, unknown>,
  opts: { isNew?: boolean } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  const status = state.status;

  // VIN fits the fcr_core.trailer.full_vin column (varchar 17) — reject over-length as a friendly
  // error rather than letting the INSERT overflow and 500.
  if (typeof state.full_vin === "string" && state.full_vin.trim().length > VIN_MAX_LENGTH) {
    errors.push({ field: "full_vin", message: `VIN must be ${VIN_MAX_LENGTH} characters or fewer.` });
  }

  if (
    status === "Awaiting Pickup" &&
    state.pickup_driver !== CUSTOMER_DROP_OFF &&
    ["pickup_address", "pickup_city", "pickup_state", "pickup_zip_code"].every((f) => isBlank(state[f]))
  ) {
    errors.push({ field: "pickup_address", message: "Status can not be Awaiting Pickup unless there is a pickup address or this is a customer drop off." });
  }
  if (
    status === "Awaiting Delivery" &&
    ["delivery_address", "delivery_city", "delivery_state", "delivery_zip_code"].every((f) => isBlank(state[f]))
  ) {
    errors.push({ field: "delivery_address", message: "Status can not be Awaiting Delivery unless there is a delivery address." });
  }
  if (status === "Repair Complete" && isBlank(state.repair_start_date)) {
    errors.push({ field: "repair_start_date", message: "Status can not be Repair Complete if there was never a Repair Start Date entered." });
  }
  if (status === "Awaiting Customer Pickup" && state.delivery_driver !== CUSTOMER_PICKUP) {
    errors.push({ field: "delivery_driver", message: "Status can not be Awaiting Customer Pickup unless Delivery Driver is set to CUSTOMER PICKUP." });
  }
  if (opts.isNew) {
    if (isBlank(state.fcr_collision_account)) {
      errors.push({ field: "fcr_collision_account", message: "FCR Collision Account is a required field. Please select the Account." });
    }
    if (isBlank(state.fcr_collision_contact)) {
      errors.push({ field: "fcr_collision_contact", message: "FCR Collision Contact is a required field. Please select the Contact." });
    }
  }
  return errors;
}

export const trailerSpec: IntakeSpec = {
  unitType: "trailer",
  table: "trailer",
  formFields: TRAILER_FORM_FIELDS,
  numericCols: TRAILER_NUMERIC_COLS,
  dateCols: TRAILER_DATE_COLS,
  boolCols: TRAILER_BOOL_COLS,
  references: [
    { column: "fcr_collision_account", table: "customer", label: "FCR Collision Account" },
    { column: "fcr_collision_contact", table: "unit_contact", label: "FCR Collision Contact" },
  ],
  vinColumn: "full_vin",
  nameColumn: "sf_name",
  engine: applyTrailerStatusEngine,
  validate: validateTrailer,
};
