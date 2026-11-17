/** The two part slots (truck object holds exactly two). Each is a part number + a description. */
export declare const TRUCK_PART_SLOT_COLUMNS: readonly ["part_1", "part_1_description", "part_2", "part_2_description"];
/** Record-level editable columns besides the slots. Single PO / single ETA (not per-slot like trailer). */
export declare const TRUCK_PART_RECORD_COLUMNS: readonly ["po_number", "fcr_order_tolas", "paragon_number", "parts_in_stock_yes_no", "estimated_arrival_date", "all_parts_received_date"];
/** Every editable truck-parts column the form submits + the write layer parses. `unit_number` (parent truck
 *  ref), `sf_id`, `sf_name`, `id`, and the audit stamps are NOT here — identity/bookkeeping the write layer
 *  sets itself, never from the form. Mirrors PARTS_EDIT_COLS[truck_backorder_part] in fcr-dispatch reverse-sync. */
export declare const TRUCK_PART_EDITABLE_COLUMNS: string[];
/** Date-typed columns (YYYY-MM-DD) — for the event-log diff and for coercion. */
export declare const TRUCK_PART_DATE_COLS: Set<string>;
/**
 * Coerce a raw form string to the typed value for its truck-parts column. Blank → null. Dates accepted only in
 * YYYY-MM-DD form (else null). parts_in_stock_yes_no is restricted to {Yes, No} (else null). Everything else is
 * a trimmed string (or null when blank).
 */
export declare function coerceTruckPartField(column: string, raw: string | null): unknown;
/**
 * Parse the editable truck-parts fields out of a submission into a typed column map. Only fields actually
 * PRESENT in the submission are included (an absent field is left untouched by the write layer, not written
 * null); an empty input IS present, so clearing a field to blank works (present → coerced to null).
 */
export declare function parseTruckParts(formData: FormData): Record<string, unknown>;
/**
 * True when the effective record carries no part line and no PO — an empty shell we refuse to create (an SF
 * back-order record always names at least one part or a PO in practice).
 */
export declare function isEmptyTruckPartRecord(cols: Record<string, unknown>): boolean;
export declare const TRUCK_PART_MAX_LEN: Record<string, number>;
/**
 * Validate the coerced field lengths against the DB column widths. Returns one field-level error per over-long
 * value (empty array = ok). Callers reject the write with these instead of letting Postgres 22001 bubble up.
 */
export declare function validateTruckPartLengths(cols: Record<string, unknown>): {
    field: string;
    message: string;
}[];
//# sourceMappingURL=fields.d.ts.map