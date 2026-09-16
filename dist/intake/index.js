// @fcr/core/intake — the fleet's shared unit-intake write engine (create/edit a truck or
// trailer through the event-log chokepoint, with a per-type status engine, validation, and a
// dedupe guard). React-free and DB-driver-free: the consuming app injects a Queryable and
// renders the form (see @fcr/ui/intake). Epic fcr-dispatch#141.
export * from "./types.js";
export * from "./sections.js";
export { isBlank, US_STATES, VIN_MAX_LENGTH, coerceField, parseEdits } from "./coerce.js";
export { createUnit, updateUnit, findDuplicates, createUnits } from "./pipeline.js";
export { resolveCustomerRef, resolveContactRef } from "./customer.js";
export { trailerSpec, applyTrailerStatusEngine, validateTrailer, TRAILER_FORM_FIELDS } from "./specs/trailer.js";
export { truckSpec, applyTruckStatusEngine, validateTruck, TRUCK_FORM_FIELDS } from "./specs/truck.js";
import { truckSpec } from "./specs/truck.js";
import { trailerSpec } from "./specs/trailer.js";
/** Look up a unit-type spec by name ("truck" | "trailer"). Returns null for anything else, so
 *  a caller can reject an unknown/injected type before touching the DB. */
export function specForUnitType(unitType) {
    if (unitType === "truck")
        return truckSpec;
    if (unitType === "trailer")
        return trailerSpec;
    return null;
}
