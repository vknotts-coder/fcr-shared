// TRUCK back-order-parts field model — the Salesforce FCR_Collision_Parts_on_Backorder__c shape as it
// forward-syncs into fcr_core.truck_backorder_part. This is the ONE source of truth for the fcr-parts form
// and the @fcr/core write layer (parts/index), so the two never drift on which columns exist or their types.
//
// ⚠ This is the TRUCK object, which is a DIFFERENT shape from the trailer parts object: a 2-slot + single-PO
// model, NOT the trailer 6-flat-slot model. Columns verified against the live fcr_core.truck_backorder_part
// schema (db/fcr_core.schema.sql in fcr-dispatch): part_1, part_1_description, part_2, part_2_description,
// po_number, estimated_arrival_date, paragon_number, fcr_order_tolas, parts_in_stock_yes_no,
// all_parts_received_date. Note the TRUCK naming `part_N_description` (vs the trailer `description_part_N`).

/** The two part slots (truck object holds exactly two). Each is a part number + a description. */
export const TRUCK_PART_SLOT_COLUMNS = [
  "part_1", "part_1_description",
  "part_2", "part_2_description",
] as const;

/** Record-level editable columns besides the slots. Single PO / single ETA (not per-slot like trailer). */
export const TRUCK_PART_RECORD_COLUMNS = [
  "po_number",
  "fcr_order_tolas",
  "paragon_number",
  "parts_in_stock_yes_no",
  "estimated_arrival_date",
  "all_parts_received_date",
] as const;

/** Every editable truck-parts column the form submits + the write layer parses. `unit_number` (parent truck
 *  ref), `sf_id`, `sf_name`, `id`, and the audit stamps are NOT here — identity/bookkeeping the write layer
 *  sets itself, never from the form. Mirrors PARTS_EDIT_COLS[truck_backorder_part] in fcr-dispatch reverse-sync. */
export const TRUCK_PART_EDITABLE_COLUMNS: string[] = [
  ...TRUCK_PART_SLOT_COLUMNS,
  ...TRUCK_PART_RECORD_COLUMNS,
];

/** Date-typed columns (YYYY-MM-DD) — for the event-log diff and for coercion. */
export const TRUCK_PART_DATE_COLS = new Set<string>([
  "estimated_arrival_date",
  "all_parts_received_date",
]);

/** Parts_in_Stock_Yes_No__c is a restricted SF picklist {Yes, No}. The form offers "", "Yes", "No". We coerce
 *  to exactly that domain (anything off-domain → null) so a reverse-synced value can never dead-letter on the
 *  SF restricted-picklist validation. */
const IN_STOCK_COL = "parts_in_stock_yes_no";

/**
 * Coerce a raw form string to the typed value for its truck-parts column. Blank → null. Dates accepted only in
 * YYYY-MM-DD form (else null). parts_in_stock_yes_no is restricted to {Yes, No} (else null). Everything else is
 * a trimmed string (or null when blank).
 */
export function coerceTruckPartField(column: string, raw: string | null): unknown {
  const s = (raw ?? "").trim();
  if (column === IN_STOCK_COL) {
    return s === "Yes" || s === "No" ? s : null;
  }
  if (s === "") return null;
  if (TRUCK_PART_DATE_COLS.has(column)) {
    // Format AND calendar validity: a format-valid-but-impossible date (2026-02-30, 2026-13-01) would otherwise
    // reach the `date` column as a raw Postgres 22007/22008 → unhandled 500. Round-trip through Date and require
    // it to render back to the same string (rejects both JS month-rollover and out-of-range), fail-soft to null.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
  }
  return s;
}

/**
 * Parse the editable truck-parts fields out of a submission into a typed column map. Only fields actually
 * PRESENT in the submission are included (an absent field is left untouched by the write layer, not written
 * null); an empty input IS present, so clearing a field to blank works (present → coerced to null).
 */
export function parseTruckParts(formData: FormData): Record<string, unknown> {
  const edits: Record<string, unknown> = {};
  for (const col of TRUCK_PART_EDITABLE_COLUMNS) {
    if (!formData.has(col)) continue;
    edits[col] = coerceTruckPartField(col, String(formData.get(col)));
  }
  return edits;
}

/**
 * True when the effective record carries no part line and no PO — an empty shell we refuse to create (an SF
 * back-order record always names at least one part or a PO in practice).
 */
export function isEmptyTruckPartRecord(cols: Record<string, unknown>): boolean {
  for (const c of ["part_1", "part_2", "po_number"]) {
    if (cols[c] != null && cols[c] !== "") return false;
  }
  return true;
}

// Max lengths of the varchar columns on fcr_core.truck_backorder_part (verified against the baseline schema).
// Without this guard a too-long value reaches Postgres as a raw `22001 value too long` error — a 500, not a
// usable message. parts_in_stock_yes_no is text (and already domain-restricted) and the date cols are
// format-validated, so neither needs a length cap here.
export const TRUCK_PART_MAX_LEN: Record<string, number> = {
  part_1: 16,
  part_2: 16,
  part_1_description: 50,
  part_2_description: 60,
  po_number: 20,
  paragon_number: 20,
  fcr_order_tolas: 60,
};

const TRUCK_PART_LABELS: Record<string, string> = {
  part_1: "Part #1",
  part_2: "Part #2",
  part_1_description: "Part #1 description",
  part_2_description: "Part #2 description",
  po_number: "PO number",
  paragon_number: "Paragon number",
  fcr_order_tolas: "FCR order / Tolas",
};

/**
 * Validate the coerced field lengths against the DB column widths. Returns one field-level error per over-long
 * value (empty array = ok). Callers reject the write with these instead of letting Postgres 22001 bubble up.
 */
export function validateTruckPartLengths(cols: Record<string, unknown>): { field: string; message: string }[] {
  const errs: { field: string; message: string }[] = [];
  for (const [col, max] of Object.entries(TRUCK_PART_MAX_LEN)) {
    const v = cols[col];
    if (typeof v === "string" && v.length > max) {
      errs.push({ field: col, message: `${TRUCK_PART_LABELS[col] ?? col} is too long (max ${max} characters).` });
    }
  }
  return errs;
}
