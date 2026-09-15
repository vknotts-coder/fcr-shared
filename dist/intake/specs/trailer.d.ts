import type { EngineResult, FormField, IntakeSpec, ValidationError } from "../types.js";
export declare const TRAILER_NUMERIC_COLS: Set<string>;
export declare const TRAILER_DATE_COLS: Set<string>;
export declare const TRAILER_FORM_FIELDS: FormField[];
export declare function applyTrailerStatusEngine(before: Record<string, unknown>, edits: Record<string, unknown>, opts?: {
    isNew?: boolean;
    today?: string;
}): EngineResult;
export declare function validateTrailer(state: Record<string, unknown>, opts?: {
    isNew?: boolean;
}): ValidationError[];
export declare const trailerSpec: IntakeSpec;
//# sourceMappingURL=trailer.d.ts.map