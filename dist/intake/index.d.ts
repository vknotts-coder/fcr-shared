export * from "./types.js";
export * from "./sections.js";
export { isBlank, US_STATES, VIN_MAX_LENGTH, coerceField, parseEdits } from "./coerce.js";
export { createUnit, updateUnit, findDuplicates } from "./pipeline.js";
export { trailerSpec, applyTrailerStatusEngine, validateTrailer, TRAILER_FORM_FIELDS } from "./specs/trailer.js";
export { truckSpec, applyTruckStatusEngine, validateTruck, TRUCK_FORM_FIELDS } from "./specs/truck.js";
import type { IntakeSpec } from "./types.js";
/** Look up a unit-type spec by name ("truck" | "trailer"). Returns null for anything else, so
 *  a caller can reject an unknown/injected type before touching the DB. */
export declare function specForUnitType(unitType: string): IntakeSpec | null;
//# sourceMappingURL=index.d.ts.map