// The generic unit-intake write path — the ONE place a truck or trailer is created or edited.
// Ties a per-unit-type spec (form-fields + status engine + validation) to the event-log
// chokepoint (commitWithEvent), so every write is: parse → engine → validate effective state
// → dedupe (create) → diff → atomic mutation + audit. Lifted and generalized from
// fcr-trailers' lib/trailer/mutate.ts (trailer-only) to truck + trailer.
//
// ⚠ REVERSE-SYNC REALITY (do not overclaim): the write sets `local_edit_at` so fcr-dispatch's
// reverse-sync CAN carry the row to Salesforce. A locally-created unit (sf_id NULL) is pushed
// to SF by dispatch's `syncCoreToSf()` create path on the next cron tick when DISPATCH_PUSH_LIVE=1.
// That is exactly why every consumer gates create/edit behind a dark *_WRITE_LIVE flag and dev
// runs on a copy-on-write Neon branch (no sync cron there). This package writes fcr_core only;
// it never calls Salesforce.
import { randomUUID } from "node:crypto";
import { commitWithEvent, eventInsert, diffChanges } from "../events/index.js";
import { parseEdits } from "./coerce.js";
import { resolveCustomerRef, resolveContactRef } from "./customer.js";
// Bookkeeping / identity columns written but NOT business facts — kept out of the audit diff
// so a re-save (or the create INSERT's own id) emits no phantom field change.
const BASE_DIFF_EXCLUDE = ["id", "updated_by", "local_edit_at", "created_by", "created_by_name"];
// The two unit tables + their VIN columns — the dedupe guard checks a VIN across BOTH, so a
// duplicate unit can't be created in either table. Table/column names are package constants
// (trusted identifiers, never user input) — the same boundary as the reports registry SQL.
const VIN_TABLES = [
    { unitType: "truck", table: "truck", vinCol: "vin" },
    { unitType: "trailer", table: "trailer", vinCol: "full_vin" },
];
function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function diffExcludeFor(spec) {
    return new Set([...BASE_DIFF_EXCLUDE, ...(spec.diffExclude ?? [])]);
}
/** Verify submitted account/contact SF ids resolve to real fcr_core rows (a soft link — no DB
 *  FK enforces it). Only checks a reference that is PRESENT and CHANGED from the before-image. */
async function checkReferences(spec, edits, before, db) {
    const checks = [];
    for (const ref of spec.references ?? []) {
        const val = edits[ref.column];
        if (typeof val === "string" && val && val !== before[ref.column]) {
            // A ref column holds EITHER an existing row's sf_id OR a just-created row's local UUID (the
            // inline-customer/contact convention — see customer.ts). Resolve a UUID against `id`, an sf_id
            // against `sf_id`, so a customer/contact created in the same intake flow validates rather than
            // failing "not found" because its sf_id is still NULL pending reverse-sync.
            const keyCol = isUuid(val) ? "id" : "sf_id";
            checks.push(db
                // `deleted_at IS NULL` matches the dedupe + update reads (sf_id survives a soft delete),
                // so a soft-deleted account/contact resolves as not-found rather than a dangling soft-FK
                // that reverse-sync would push to the real SF org.
                .query(`SELECT 1 FROM fcr_core.${ref.table} WHERE ${keyCol} = $1 AND deleted_at IS NULL LIMIT 1`, [val])
                .then((r) => r.rows.length === 0
                ? { field: ref.column, message: `${ref.label} "${val}" was not found — pick a valid ${ref.label}.` }
                : null));
        }
    }
    return (await Promise.all(checks)).filter((e) => e !== null);
}
/**
 * The dedupe guard. Given the about-to-be-written columns, looks for existing non-deleted
 * units that likely duplicate this one: a VIN match across BOTH unit tables, and a same-table
 * unit-number (sf_name) match. Returns the hits so the caller can surface "possible duplicate
 * → open it / create anyway"; it never blocks on its own. VIN can't be a DB unique constraint
 * (often blank at "Awaiting Pickup Info", split across two tables), so this app-level check at
 * the single create chokepoint is how the fleet stays dedupe'd.
 */
export async function findDuplicates(spec, cols, db) {
    const hits = [];
    const seen = new Set();
    const vin = cols[spec.vinColumn];
    if (typeof vin === "string" && vin.trim()) {
        const v = vin.trim().toUpperCase();
        for (const t of VIN_TABLES) {
            const r = await db.query(`SELECT id, sf_name FROM fcr_core.${t.table}
          WHERE UPPER(TRIM(${t.vinCol})) = $1 AND deleted_at IS NULL LIMIT 5`, [v]);
            for (const row of r.rows) {
                if (seen.has(row.id))
                    continue;
                seen.add(row.id);
                hits.push({ unitType: t.unitType, id: row.id, sfName: row.sf_name, matchedOn: "vin" });
            }
        }
    }
    const name = cols[spec.nameColumn];
    if (typeof name === "string" && name.trim()) {
        const r = await db.query(`SELECT id, sf_name FROM fcr_core.${spec.table}
        WHERE UPPER(TRIM(${spec.nameColumn})) = $1 AND deleted_at IS NULL LIMIT 5`, [name.trim().toUpperCase()]);
        for (const row of r.rows) {
            if (seen.has(row.id))
                continue;
            seen.add(row.id);
            hits.push({ unitType: spec.unitType, id: row.id, sfName: row.sf_name, matchedOn: "name" });
        }
    }
    return hits;
}
/**
 * Create a new unit. Generates the fcr_core uuid (sf_id stays null until dispatch's reverse
 * sync creates the SF record and backfills it). Unless `confirmDuplicate` is set, a dedupe
 * hit short-circuits with `{ ok:false, duplicates }` so the UI can offer "create anyway".
 */
export async function createUnit(spec, formData, actor, db, opts = {}) {
    const edits = parseEdits(formData, spec.formFields, spec.numericCols, spec.dateCols, spec.boolCols);
    const before = {};
    const { derived, emails } = spec.engine(before, edits, { isNew: true });
    const cols = { ...edits, ...derived };
    const errors = [...spec.validate(cols, { isNew: true }), ...(await checkReferences(spec, edits, before, db))];
    if (errors.length)
        return { ok: false, errors };
    if (!opts.confirmDuplicate) {
        const duplicates = await findDuplicates(spec, cols, db);
        if (duplicates.length)
            return { ok: false, duplicates };
    }
    const id = randomUUID();
    cols.id = id;
    cols.created_by = actor.username;
    cols.created_by_name = actor.name;
    cols.updated_by = actor.name;
    cols.local_edit_at = new Date();
    const changes = diffChanges(before, cols, {
        numericCols: spec.numericCols,
        dateCols: spec.dateCols,
        exclude: diffExcludeFor(spec),
    });
    const keys = Object.keys(cols);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    await commitWithEvent({
        source: "app",
        resourceType: spec.unitType,
        resourceId: id,
        action: "create",
        actor: { label: actor.name },
        changes,
        metadata: { form: spec.unitType },
    }, {
        text: `INSERT INTO fcr_core.${spec.table} (${keys.join(", ")}, created_at, updated_at)
             VALUES (${placeholders.join(", ")}, NOW(), NOW())`,
        params: keys.map((k) => cols[k]),
    }, db);
    return { ok: true, id, emails };
}
/**
 * Create MANY units for ONE customer in a single intake (the "one customer, multiple units at
 * once" flow). Resolves the customer + contact ONCE — picking existing rows or creating them
 * inline (resolveCustomerRef/resolveContactRef) — then injects that shared ref into each unit's
 * FormData and calls `createUnit` per unit, so the whole batch hangs off the same audited create
 * path (dedupe + validation + event) as a single create.
 *
 * v1 semantics (documented, matches the fcr-sales flow this is lifted from): SEQUENTIAL and
 * NOT wrapped in one transaction — the customer/contact are created first, then each unit; a
 * unit that fails validation/dedupe is reported in its `units[]` entry while the others proceed,
 * so partial success is possible. The caller inspects the per-unit results and can re-submit the
 * failed ones with `confirmDuplicate` (the customer/contact are already created — pass them as
 * `existingSfId`/`existingRef` on the retry so they aren't duplicated). Full batch atomicity +
 * a single pre-create dedupe pass are a hardening follow-up (needs a transaction-scoped Queryable).
 *
 * Caller must validate inputs first (≥1 unit; a new customer/contact has a non-empty name),
 * exactly as the app server action does today before writing.
 */
export async function createUnits(spec, customer, contact, units, actor, db, opts = {}) {
    const customerRef = await resolveCustomerRef(customer, actor, db);
    const contactRef = await resolveContactRef(contact, customerRef, actor, db);
    const results = [];
    for (const [i, fd] of units.entries()) {
        // Every unit in the batch shares the one resolved customer/contact — inject the refs so the
        // caller doesn't repeat them per unit (and can't drift them across the batch).
        fd.set(spec.customerRefColumn, customerRef);
        fd.set(spec.contactRefColumn, contactRef);
        results.push({ index: i, result: await createUnit(spec, fd, actor, db, opts) });
    }
    return { customerRef, contactRef, units: results, ok: results.every((r) => r.result.ok) };
}
/**
 * Edit an existing unit. Reads the before-image, runs the engine + validation over the
 * effective state, and writes the row + audit event atomically with an optimistic-concurrency
 * guard (the before-image's updated_at), so a concurrent edit can't be silently lost.
 */
export async function updateUnit(spec, id, formData, actor, db) {
    if (!isUuid(id))
        return { ok: false, errors: [{ field: null, message: `Invalid ${spec.unitType} id.` }] };
    const edits = parseEdits(formData, spec.formFields, spec.numericCols, spec.dateCols, spec.boolCols);
    const editableColumns = spec.formFields.map((f) => f.column);
    // Before-image includes status_date (engine-written, not an editable field) so the audit diff
    // compares against the true prior date, plus updated_at::text as the exact-precision optimistic
    // guard (a timestamptz round-trips to a ms-truncated Date, so key off the text form).
    const found = await db.query(`SELECT id, updated_at::text AS __guard, status_date, ${editableColumns.join(", ")}
       FROM fcr_core.${spec.table}
      WHERE id = $1 AND deleted_at IS NULL
      LIMIT 1`, [id]);
    if (found.rows.length === 0)
        return { ok: false, errors: [{ field: null, message: `${spec.unitType} not found.` }] };
    const before = found.rows[0];
    const guard = before.__guard;
    delete before.__guard;
    const { derived } = spec.engine(before, edits, { isNew: false });
    const cols = { ...edits, ...derived };
    const effectiveState = { ...before, ...cols };
    const errors = [...spec.validate(effectiveState, { isNew: false }), ...(await checkReferences(spec, edits, before, db))];
    if (errors.length)
        return { ok: false, errors };
    // No-op edit: skip the write, the audit event AND the local_edit_at stamp — otherwise an
    // empty save writes a fieldless event and spuriously triggers the reverse-sync push.
    const changes = diffChanges(before, cols, {
        numericCols: spec.numericCols,
        dateCols: spec.dateCols,
        exclude: diffExcludeFor(spec),
    });
    if (changes.length === 0)
        return { ok: true, id, emails: [] };
    cols.updated_by = actor.name;
    cols.local_edit_at = new Date();
    // Field-scoped reverse-sync (fcr-dispatch #119): union the columns that actually changed into
    // dispatch_dirty_cols, so the reverse push (pushDispatchEdits) can send ONLY what changed instead
    // of a whole-row PATCH that could clobber a concurrent SF-desk edit. The push intersects this with
    // its own DISPATCH_COLS allowlist, so recording every changed business column here is sufficient —
    // this package needn't know which columns are reverse-synced. Inert until DISPATCH_FIELD_SCOPED_SYNC
    // is on (the reverse sync ignores the column otherwise); safe to populate now. `changes` is
    // non-empty here (the no-op guard returned above), so this never writes an empty array.
    // Lifecycle: the reverse push (fcr-dispatch pushDispatchEdits / defaultClearFlag) OWNS clearing
    // dispatch_dirty_cols after it syncs — this path only accumulates. It is a denormalized mirror of
    // event_log.changes chosen deliberately to match the existing #119 field-scoped-sync mechanism the
    // reverse push already reads, rather than re-deriving a per-row watermark from event_log.
    const dirtyCols = changes.map((c) => c.field);
    const keys = Object.keys(cols);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    // Build the chokepoint statement with eventInsert and run it via db so we can read the
    // affected-row count — the reliable signal for "did my guarded UPDATE match?": if a concurrent
    // write moved updated_at, the UPDATE matches zero rows, the gated event INSERT (WHERE EXISTS upd)
    // writes zero rows too, and this is a lost-update conflict.
    const { text, params } = await eventInsert({
        source: "app",
        resourceType: spec.unitType,
        resourceId: id,
        action: "edit",
        actor: { label: actor.name },
        changes,
        metadata: { form: spec.unitType },
    }, {
        text: `UPDATE fcr_core.${spec.table}
                SET ${setClause},
                    dispatch_dirty_cols = ARRAY(SELECT DISTINCT unnest(COALESCE(dispatch_dirty_cols, '{}'::text[]) || $${keys.length + 1}::text[])),
                    updated_at = NOW()
              WHERE id = $${keys.length + 2} AND deleted_at IS NULL AND updated_at = $${keys.length + 3}::timestamptz`,
        params: [...keys.map((k) => cols[k]), dirtyCols, id, guard],
    });
    const res = await db.query(text, params);
    // Real neon/pg pools return rowCount; fall back to rows.length for a bare Queryable.
    const affected = res.rowCount ?? res.rows.length;
    if (affected === 0) {
        return { ok: false, errors: [{ field: null, message: `This ${spec.unitType} was changed by someone else — reload and try again.` }] };
    }
    const emails = spec.engine(before, edits, { isNew: false }).emails;
    return { ok: true, id, emails };
}
