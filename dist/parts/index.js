// @fcr/core/parts — the ONE write path for a TRUCK back-order-parts record
// (fcr_core.truck_backorder_part). Create + edit go through the event-log chokepoint (commitWithEvent) and
// stamp the reverse-sync bookkeeping (local_edit_at + dispatch_dirty_cols), so fcr-parts stops doing the
// bespoke raw UPDATE that (a) never reached Salesforce and (b) was silently overwritten by the SF→core
// forward sync. Shared platform code: the DB is an INJECTED Queryable (the app passes its pool()/sql()),
// exactly like @fcr/core/rbac + /reports + /events.
//
// TRUCK-ONLY by design (SCOPE-parts-lane.md, Van 2026-11-17): this does NOT touch the trailer parts writer
// (fcr-trailers lib/trailer/parts.ts). The trailer object is a different shape and already has its own live
// reverse-sync; fcr-parts is strictly trucks.
//
// REVERSE-SYNC: truck_backorder_part is wired into fcr-dispatch's create (PUSH_ORDER) + field-scoped edit
// (pushDispatchEdits) paths (SCOPE-parts-lane.md A2), gated dark behind DISPATCH_TRUCK_PARTS_SYNC_LIVE. So a
// part created here reaches Salesforce via the create path (sf_id stays NULL until SF assigns one), and an
// EDIT reaches it via the field-scoped path — which is why this write path stamps local_edit_at +
// dispatch_dirty_cols (the signal the edit push reads). It is DOUBLY gated OFF in prod: the push is dark behind
// DISPATCH_TRUCK_PARTS_SYNC_LIVE, and parts writes themselves are behind fcr-parts' PARTS_WRITE_LIVE.
//
// ⚠ CROSS-REPO SCHEMA PREREQ: the local_edit_at / dispatch_dirty_cols columns this file writes live on the
// SHARED fcr_core.truck_backorder_part table, added by fcr-dispatch migration
// 202611171200_truck_backorder_part_reverse_sync.sql (fcr-dispatch OWNS the fcr_core migrations — do NOT add
// one here). A CoW/preview branch cut off prod before that migration lands would not carry them.
import { randomUUID } from "node:crypto";
import { commitWithEvent, diffChanges } from "../events/index.js";
import { TRUCK_PART_EDITABLE_COLUMNS, TRUCK_PART_DATE_COLS, parseTruckParts, isEmptyTruckPartRecord, validateTruckPartLengths, } from "./fields.js";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v) {
    return UUID_RE.test(v);
}
// Identity / bookkeeping columns written but not business facts — kept out of the event-log diff (and thus out
// of dispatch_dirty_cols) so a re-save or the create INSERT's own id/link emits no phantom field change and
// never tries to reverse-sync an identity column. sf_name is SF-assigned (left null on create), never edited.
const DIFF_EXCLUDE = new Set(["id", "unit_number", "sf_name", "created_by", "updated_by"]);
/** Load the parent truck's id + sf_id. Null when it doesn't exist / is soft-deleted. `truckId` is the
 *  fcr_core uuid. */
async function loadTruck(db, truckId) {
    if (!isUuid(truckId))
        return null;
    // sf_name is intentionally NOT selected: the new part's Name is SF-assigned (left NULL on create), so no
    // caller needs the parent's sf_name.
    const { rows } = await db.query(`SELECT id, sf_id FROM fcr_core.truck WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [truckId]);
    return rows[0] ?? null;
}
/**
 * Create a back-order-parts record on a truck. Generates the fcr_core uuid (sf_id stays NULL until Salesforce
 * assigns one — the row reaches SF via fcr-dispatch's create/PUSH_ORDER path once DISPATCH_TRUCK_PARTS_SYNC_LIVE
 * is lit). Links via unit_number = truck.sf_id; rejects a truck with no sf_id (unit_number is NOT NULL, and an
 * SF create needs the parent's real Id). sf_name is left NULL for SF to assign (the truck parts object Name is
 * SF-owned); the forward sync backfills it after the record exists in SF.
 */
export async function createTruckBackorderPart(db, truckId, formData, actor) {
    const truck = await loadTruck(db, truckId);
    if (!truck)
        return { ok: false, errors: [{ field: null, message: "Truck not found." }] };
    if (!truck.sf_id) {
        return {
            ok: false,
            errors: [{
                    field: null,
                    message: "This truck hasn't synced to Salesforce yet, so back-order parts can't be linked to it. Try again once it has a Salesforce id.",
                }],
        };
    }
    const edits = parseTruckParts(formData);
    if (isEmptyTruckPartRecord(edits)) {
        return { ok: false, errors: [{ field: "part_1", message: "Add at least one part number or a PO." }] };
    }
    const lenErrors = validateTruckPartLengths(edits);
    if (lenErrors.length > 0)
        return { ok: false, errors: lenErrors };
    const id = randomUUID();
    const cols = { ...edits, id };
    cols.unit_number = truck.sf_id;
    cols.created_by = actor.username;
    cols.updated_by = actor.name;
    const changes = diffChanges({}, cols, { dateCols: TRUCK_PART_DATE_COLS, exclude: DIFF_EXCLUDE });
    const keys = Object.keys(cols);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const { changed } = await commitWithEvent({
        source: "app",
        resourceType: "truck_backorder_part",
        resourceId: id,
        // Parent link for the truck's Activity timeline: resource_key is a first-class, indexable event_log
        // column, so the record-page history query filters on it instead of a jsonb metadata extraction.
        resourceKey: truck.id,
        action: "backorder_part_add",
        actor: { label: actor.name },
        changes,
        metadata: { truckId: truck.id, unitNumber: truck.sf_id, form: "truck_backorder_part" },
    }, {
        text: `INSERT INTO fcr_core.truck_backorder_part (${keys.join(", ")}, created_at, updated_at)
             VALUES (${placeholders.join(", ")}, NOW(), NOW())`,
        params: keys.map((k) => cols[k]),
    }, db);
    // Defensive only: a plain INSERT (no ON CONFLICT / WHERE) affects exactly one row or throws, so `changed` is
    // always true here. Kept as a guard against a future gated-INSERT variant; it cannot fire today.
    if (!changed)
        return { ok: false, errors: [{ field: null, message: "Could not create the parts record. Try again." }] };
    return { ok: true, id };
}
/** Read a part's before-image, confirming it belongs to `truckSfId` (unit_number = sf_id) so a part can't be
 *  edited through a mismatched truck URL (IDOR). Returns the row + the exact-precision optimistic-concurrency
 *  guard, or null when not found / not this truck. */
async function loadPartForTruck(db, partId, truckSfId) {
    const { rows } = await db.query(`SELECT id, updated_at::text AS __guard, unit_number, ${TRUCK_PART_EDITABLE_COLUMNS.join(", ")}
       FROM fcr_core.truck_backorder_part
      WHERE id = $1 AND unit_number = $2 AND deleted_at IS NULL
      LIMIT 1`, [partId, truckSfId]);
    const before = rows[0];
    if (!before)
        return null;
    const guard = before.__guard;
    delete before.__guard;
    return { before, guard };
}
/**
 * Edit a back-order-parts record. Reads the before-image (scoped to the parent truck — IDOR guard), diffs the
 * business columns, and writes row + audit event atomically with an optimistic-concurrency guard on the
 * before-image's updated_at. Stamps local_edit_at + unions the genuinely-changed columns into
 * dispatch_dirty_cols so fcr-dispatch's field-scoped reverse-sync pushes ONLY those fields to Salesforce — and
 * the SF→core forward sync's overwrite guard preserves them until pushed. The DISTINCT-unnest union matches
 * fcr-dispatch's unionDirtyColsSql exactly (append + dedupe); kept inline because @fcr/core/events doesn't
 * export it and the two repos don't share lib code.
 */
export async function updateTruckBackorderPart(db, partId, truckId, formData, actor) {
    if (!isUuid(partId))
        return { ok: false, errors: [{ field: null, message: "Invalid parts record id." }] };
    const truck = await loadTruck(db, truckId);
    if (!truck || !truck.sf_id)
        return { ok: false, errors: [{ field: null, message: "Truck not found." }] };
    const loaded = await loadPartForTruck(db, partId, truck.sf_id);
    if (!loaded)
        return { ok: false, errors: [{ field: null, message: "Parts record not found." }] };
    const { before, guard } = loaded;
    const cols = parseTruckParts(formData);
    const lenErrors = validateTruckPartLengths(cols);
    if (lenErrors.length > 0)
        return { ok: false, errors: lenErrors };
    // Reject an edit that would EMPTY the record (clearing every part + the PO) — it would otherwise persist an
    // empty shell and, once the push flag is lit, reverse-sync nulls to Salesforce. Check the MERGED post-edit row
    // (before-image + the submitted edits), since an edit submits only the fields it changed.
    if (isEmptyTruckPartRecord({ ...before, ...cols })) {
        return { ok: false, errors: [{ field: "part_1", message: "A back-order part needs at least one part number or a PO." }] };
    }
    // No-op edit: skip the write AND the audit event (an empty save otherwise writes a fieldless event). Diff the
    // business columns before adding bookkeeping.
    const changes = diffChanges(before, cols, { dateCols: TRUCK_PART_DATE_COLS, exclude: DIFF_EXCLUDE });
    if (changes.length === 0)
        return { ok: true, id: partId };
    cols.updated_by = actor.name;
    // We only reach here with changes.length > 0, so dirtyCols is always non-empty; it excludes identity columns
    // (DIFF_EXCLUDE) because those are not in `changes`.
    const dirtyCols = changes.map((c) => c.field);
    const keys = Object.keys(cols);
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    // Param layout: $1..$keys.length = column values; $keys.length+1 = partId; $keys.length+2 = optimistic guard;
    // $keys.length+3 = the dirty-cols text[] (appended last so the WHERE numbering is unchanged).
    const dirtyParam = keys.length + 3;
    const { changed } = await commitWithEvent({
        source: "app",
        resourceType: "truck_backorder_part",
        resourceId: partId,
        resourceKey: truck.id,
        action: "backorder_part_edit",
        actor: { label: actor.name },
        changes,
        metadata: { truckId: truck.id, unitNumber: truck.sf_id, form: "truck_backorder_part" },
    }, {
        text: `UPDATE fcr_core.truck_backorder_part
                SET ${setClause}, updated_at = NOW(), local_edit_at = NOW(),
                    dispatch_dirty_cols = ARRAY(SELECT DISTINCT unnest(COALESCE(dispatch_dirty_cols, '{}'::text[]) || $${dirtyParam}::text[]))
              WHERE id = $${keys.length + 1} AND deleted_at IS NULL AND updated_at = $${keys.length + 2}::timestamptz`,
        params: [...keys.map((k) => cols[k]), partId, guard, dirtyCols],
    }, db);
    // Optimistic guard in the WHERE: a concurrent write that moved updated_at makes the UPDATE match zero rows, so
    // the gated event writes zero rows too and `changed` is false.
    if (!changed) {
        return { ok: false, errors: [{ field: null, message: "This parts record was changed by someone else — reload and try again." }] };
    }
    return { ok: true, id: partId };
}
