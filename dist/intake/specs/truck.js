// Truck intake spec — CREATE + a simple pickup seed-status, matching what fcr-sales' truck
// intake does today (which just defaults status to "Awaiting Pickup Info"). The full truck
// status↔date engine is a DEFERRED slice: unlike trailers, the truck SF flow is not specced in
// the repo (it lives in the SF audit; SF behavior is a Robert arrow). We do NOT invent it —
// this seeds the initial status from the pickup arrangement and stamps status_date on a manual
// status change, nothing more. Columns verified against fcr-dispatch db/fcr_core.schema.sql.
import { today } from "../../reports/dates.js";
import { isBlank, US_STATES, VIN_MAX_LENGTH } from "../coerce.js";
const CUSTOMER_DROP_OFF_MODE = "Customer Drop Off";
const PICKUP_MODES = ["Tow", "Drive", "Customer Drop Off", "Other"];
const SHOPS = ["Livingston", "Sparta"];
const SALES_TEAMS = ["Team A", "Team B", "Team C"];
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
export const TRUCK_NUMERIC_COLS = new Set([]);
export const TRUCK_DATE_COLS = new Set(["notify_date", "status_date"]);
export const TRUCK_FORM_FIELDS = [
    // Information
    { column: "sf_name", label: "Unit #", section: "information", input: "text" },
    { column: "fcr_collision_customer", label: "Account (SF id)", section: "information", input: "text" },
    { column: "fcr_collision_contacts", label: "Contact (SF id)", section: "information", input: "text" },
    { column: "status", label: "Status", section: "information", input: "select", options: ["", ...TRUCK_INTAKE_STATUSES] },
    { column: "vin", label: "VIN", section: "information", input: "text" },
    { column: "truck_make", label: "Make", section: "information", input: "text" },
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
];
/** Truck status seed/stamp. CREATE: seed status from the pickup arrangement (Customer Drop Off
 *  mode → "Customer Drop Off"; a pickup address → "Awaiting Pickup"; else "Awaiting Pickup Info"),
 *  set notify_date + status_date to today if blank. UPDATE: a manual status change stamps
 *  status_date today (no milestone back-fill — deferred). No emails (truck alerts unspecced). */
export function applyTruckStatusEngine(before, edits, opts = {}) {
    const todayStr = opts.today ?? today();
    const eff = (field) => (field in edits ? edits[field] : before[field]);
    const derived = {};
    const fromStatus = before.status ?? null;
    if (opts.isNew) {
        const mode = eff("pickup_tow_drive");
        const hasPickupAddr = ["pickup_street_address", "pickup_city", "pickup_state", "pickup_zip_code"].some((f) => !isBlank(eff(f)));
        let initial;
        if (mode === CUSTOMER_DROP_OFF_MODE)
            initial = "Customer Drop Off";
        else if (hasPickupAddr)
            initial = "Awaiting Pickup";
        else
            initial = "Awaiting Pickup Info";
        // Only seed the status when the user didn't pick one explicitly.
        if (isBlank(eff("status")))
            derived.status = initial;
        if (isBlank(eff("notify_date")))
            derived.notify_date = todayStr;
        derived.status_date = todayStr;
        return { derived, statusChanged: true, fromStatus, toStatus: derived.status ?? eff("status") ?? initial, emails: [] };
    }
    const manual = "status" in edits && !isBlank(edits.status) && edits.status !== fromStatus ? edits.status : null;
    if (manual)
        derived.status_date = todayStr;
    return { derived, statusChanged: !!manual, fromStatus, toStatus: manual ?? fromStatus, emails: [] };
}
export function validateTruck(state, opts = {}) {
    const errors = [];
    const status = state.status;
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
    const estimatorChanged = !opts.before || state.estimator_name !== opts.before.estimator_name;
    if (estimatorChanged &&
        typeof state.estimator_name === "string" &&
        !isBlank(state.estimator_name) &&
        !ESTIMATOR_NAMES.includes(state.estimator_name)) {
        errors.push({ field: "estimator_name", message: `Estimator must be one of: ${ESTIMATOR_NAMES.join(", ")}.` });
    }
    if (status === "Awaiting Pickup" &&
        state.pickup_tow_drive !== CUSTOMER_DROP_OFF_MODE &&
        ["pickup_street_address", "pickup_city", "pickup_state", "pickup_zip_code"].every((f) => isBlank(state[f]))) {
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
export const truckSpec = {
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
    customerRefColumn: "fcr_collision_customer",
    contactRefColumn: "fcr_collision_contacts",
    engine: applyTruckStatusEngine,
    validate: validateTruck,
};
