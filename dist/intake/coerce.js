// Field coercion + tiny predicates shared by the pipeline and the specs. One definition of
// "blank" and one of how a raw FormData string becomes a typed column value, so the parse,
// the status engine and the validators can never drift.
/** True for null/undefined or an all-whitespace string — one definition of "empty field". */
export function isBlank(v) {
    return v == null || (typeof v === "string" && v.trim() === "");
}
/** A field rule that runs over the MERGED before-image must scope itself to the fields the edit actually
 *  CHANGED, or an unchanged LEGACY value freezes edits to unrelated fields. `updateUnit` validates the merged
 *  state (before + edits), so e.g. a truck/trailer sitting at "Awaiting Pickup" with a missing coupled field
 *  would otherwise reject an edit to any other field with no way to satisfy it. Returns a predicate: a rule
 *  guards itself with `changed([...the fields it couples])`. On create (no before) every field counts as
 *  changed. One definition shared by validateTruck + validateTrailer so the scoping can't drift. */
export function makeChanged(state, before) {
    return (fields) => !before || fields.some((f) => state[f] !== before[f]);
}
/** Max VIN length — the fcr_core truck.vin / trailer.full_vin columns are varchar(17). A longer
 *  value would overflow the column and 500 the create; the specs reject it as a friendly error. */
export const VIN_MAX_LENGTH = 17;
// Yes/No picklist for a boolean <select> (coerced to true/false/null). Shared so the truck + trailer specs'
// rework/parts-available selects have one source of truth instead of each inlining the literal.
export const YES_NO = ["Yes", "No"];
export const US_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
];
/** Map a Yes/No (or true/false/1/0) select value to a real boolean, or null when it is neither.
 *  A boolean fcr_core column (e.g. trailer.rework) is edited via a Yes/No `select`, so the raw
 *  submission is a string the DB driver would otherwise bind as text into a boolean column. */
export function coerceBool(s) {
    const t = s.trim().toLowerCase();
    if (t === "yes" || t === "true" || t === "1" || t === "on")
        return true;
    if (t === "no" || t === "false" || t === "0" || t === "off")
        return false;
    return null;
}
/**
 * Coerce a raw string to the typed value for its column. Blank → null. Numeric columns →
 * finite number or null; date columns → a valid 'YYYY-MM-DD' or null; boolean columns →
 * true/false/null (Yes/No select); a `*_state` column → upper-cased 2-letter code. Everything
 * else → trimmed string. `boolCols` is optional so existing specs (truck) need no change.
 */
export function coerceField(column, raw, numericCols, dateCols, boolCols = new Set()) {
    const s = (raw ?? "").trim();
    if (s === "")
        return null;
    if (numericCols.has(column)) {
        // Strip currency/formatting chars, then coerce. A value with NO digits at all ("N/A", "TBD",
        // "pending") strips to "" — and Number("") is 0 (finite), which would silently write a real 0
        // (e.g. $0 Total Sales reverse-syncing to SF) instead of leaving the field unset. So treat an
        // all-non-numeric entry the same as blank: null, not 0. (#60 S2 review — money-coercion bug.)
        const cleaned = s.replace(/[^0-9.\-]/g, "");
        if (cleaned === "")
            return null;
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
    }
    if (dateCols.has(column))
        return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    if (boolCols.has(column))
        return coerceBool(s);
    if (column.endsWith("_state"))
        return s.toUpperCase().slice(0, 2);
    return s;
}
/**
 * Parse the editable fields out of a submitted form into a typed column map. Only fields
 * PRESENT in the submission are included — an absent field is left untouched (not written as
 * null), so a partial update can't wipe columns it didn't send. An empty input IS present, so
 * clearing a field to blank still works (present → coerced to null).
 */
export function parseEdits(formData, fields, numericCols, dateCols, boolCols = new Set()) {
    const edits = {};
    for (const f of fields) {
        if (!formData.has(f.column))
            continue;
        edits[f.column] = coerceField(f.column, String(formData.get(f.column)), numericCols, dateCols, boolCols);
    }
    return edits;
}
