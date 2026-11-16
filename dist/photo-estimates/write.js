// @fcr/core/photo-estimates write path — create a request and move it through its lifecycle.
// APP-OWNED, never Salesforce-synced: these writes stamp NO dispatch_dirty_cols and NO local_edit_at
// (the two signals the dispatch reverse-sync cron reads), and fcr_core.photo_estimate is absent from
// sync-targets.json with no sf_id — so a photo-estimate write can never reach SF. History is app-owned
// too: event_log is not a sync target, so every create/transition lands one event row through the
// shared @fcr/core/events chokepoint, exactly as donor/truck do.
//
// DB-agnostic: every function takes an injected Queryable; this package never imports an app db.
// Transition guards are enforced by a load-before-image check PLUS an optimistic `status = <observed>`
// in the UPDATE WHERE, so a concurrent change is a no-op rather than a lost update.
import { randomUUID } from "node:crypto";
import { commitWithEvent, diffChanges } from "../events/index.js";
import { isTerminalStatus, } from "./types.js";
const BOOKKEEPING = new Set([
    "id",
    "created_by",
    "created_by_name",
    "updated_by",
    "updated_by_name",
]);
function err(message, field = null) {
    return { ok: false, errors: [{ field, message }] };
}
async function loadRow(db, id) {
    const { rows } = await db.query(`SELECT * FROM fcr_core.photo_estimate WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return rows[0] ?? null;
}
/** Create a new request (status 'unassigned'). Jordan's hard rule: Customer, Truck # and VIN are all
 *  required. The "at least one of Photos OR a Comparative Estimate" requirement is enforced at the app
 *  layer (attachments land on unit_file/unit_photo after the row exists, keyed by this id). */
export async function createPhotoEstimate(db, input, actor) {
    const customer_name = input.customerName.trim();
    const truck_number = input.truckNumber.trim();
    const vin = input.vin.trim();
    const customer_sf_id = input.customerSfId?.trim() || null;
    const contact_ref = input.contactRef?.trim() || null;
    const contact_name = (input.contactName ?? "").trim();
    const errors = [];
    if (!customer_name)
        errors.push({ field: "customer_name", message: "Customer is required." });
    if (!truck_number)
        errors.push({ field: "truck_number", message: "Truck Number is required." });
    if (!vin)
        errors.push({ field: "vin", message: "VIN is required." });
    if (errors.length)
        return { ok: false, errors };
    const id = randomUUID();
    const cols = {
        id,
        customer_name,
        customer_sf_id,
        truck_number,
        vin,
        contact_ref,
        contact_name,
        status: "unassigned",
        submitted_by: actor.username ?? null,
        submitted_by_name: actor.name,
        created_by: actor.username ?? null,
        created_by_name: actor.name,
        updated_by: actor.username ?? null,
        updated_by_name: actor.name,
    };
    const changes = diffChanges({}, cols, { exclude: BOOKKEEPING });
    const keys = Object.keys(cols);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    await commitWithEvent({
        source: "app",
        resourceType: "photo_estimate",
        resourceId: id,
        action: "create",
        actor: { label: actor.name },
        changes,
        metadata: { form: "photo_estimate" },
    }, {
        text: `INSERT INTO fcr_core.photo_estimate (${keys.join(", ")}, created_at, updated_at)
             VALUES (${placeholders.join(", ")}, NOW(), NOW())`,
        params: keys.map((k) => cols[k]),
    }, db);
    return { ok: true, id };
}
/** Internal: run a guarded status transition + log it. `set` is the SET fragment (after `status=$2`);
 *  `extraParams` are its bind values (starting at $3). The WHERE pins id, not-deleted, and the observed
 *  status (optimistic). `changes` is the field-level diff to record. */
async function transition(db, id, observedStatus, toStatus, setFragment, extraParams, actor, changes) {
    // actor stamps are the last two params.
    const params = [id, toStatus, ...extraParams, actor.username ?? null, actor.name, observedStatus];
    const uIdx = params.length - 2; // $ for updated_by
    const { changed } = await commitWithEvent({
        source: "app",
        resourceType: "photo_estimate",
        resourceId: id,
        action: "status_change",
        actor: { label: actor.name },
        changes,
    }, {
        text: `UPDATE fcr_core.photo_estimate
                SET status = $2${setFragment ? ", " + setFragment : ""},
                    updated_by = $${uIdx}, updated_by_name = $${uIdx + 1}, updated_at = NOW()
              WHERE id = $1 AND deleted_at IS NULL AND status = $${uIdx + 2}`,
        params,
    }, db);
    // The optimistic `AND status = $observed` guard matched zero rows → a concurrent actor already
    // moved this request between our loadRow and this UPDATE. Report the conflict instead of a
    // false success (a caller that reads ok:true as "it transitioned" could e.g. double-convert a
    // truck in S5). See @fcr/core/events commitWithEvent `changed`.
    if (!changed) {
        return err("This request was just changed by someone else — reload and try again.");
    }
    return { ok: true, id };
}
/** Assign (or re-assign) to an estimator and move to In Progress. assigned_at is set once (first pick-up). */
export async function assignPhotoEstimate(db, id, estimator, actor) {
    const who = estimator.trim();
    if (!who)
        return err("An estimator is required.", "assigned_estimator");
    const row = await loadRow(db, id);
    if (!row)
        return err("Photo estimate not found.");
    if (isTerminalStatus(row.status))
        return err("This request is already resolved.");
    // SET assigned_estimator=$3, assigned_at=COALESCE(assigned_at, NOW())
    return transition(db, id, row.status, "in_progress", "assigned_estimator = $3, assigned_at = COALESCE(assigned_at, NOW())", [who], actor, [
        { field: "status", before: row.status, after: "in_progress" },
        { field: "assigned_estimator", before: row.assigned_estimator, after: who },
    ]);
}
/** Mark Completed. Only from In Progress. The caller (estimating app) must have verified the finished
 *  estimate file is uploaded before calling this — that check needs unit_file and lives app-side. */
export async function completePhotoEstimate(db, id, actor) {
    const row = await loadRow(db, id);
    if (!row)
        return err("Photo estimate not found.");
    if (row.status !== "in_progress")
        return err("Only an in-progress estimate can be completed.");
    return transition(db, id, row.status, "completed", "completed_at = NOW()", [], actor, [{ field: "status", before: row.status, after: "completed" }]);
}
/** Customer accepted. Only from Completed. `convertedTruckId` links the real truck created by the
 *  convert-to-job flow (S5); pass it when the truck has been created, else null (link set later). */
export async function acceptPhotoEstimate(db, id, actor, convertedTruckId = null) {
    const row = await loadRow(db, id);
    if (!row)
        return err("Photo estimate not found.");
    if (row.status !== "completed")
        return err("Only a completed estimate can be accepted.");
    return transition(db, id, row.status, "accepted", "accepted_at = NOW(), converted_truck_id = $3", [convertedTruckId], actor, [
        { field: "status", before: row.status, after: "accepted" },
        ...(convertedTruckId
            ? [{ field: "converted_truck_id", before: row.converted_truck_id, after: convertedTruckId }]
            : []),
    ]);
}
/** Customer declined. Allowed from any active (non-terminal) status. Optional reason for win/loss. */
export async function declinePhotoEstimate(db, id, reason, actor) {
    const row = await loadRow(db, id);
    if (!row)
        return err("Photo estimate not found.");
    if (isTerminalStatus(row.status))
        return err("This request is already resolved.");
    const r = (reason ?? "").trim();
    return transition(db, id, row.status, "declined", "declined_at = NOW(), declined_reason = $3", [r], actor, [
        { field: "status", before: row.status, after: "declined" },
        ...(r ? [{ field: "declined_reason", before: row.declined_reason, after: r }] : []),
    ]);
}
/** Set (or correct) the converted-truck link after the convert-to-job flow creates the real truck.
 *  Separate from accept so the two-step UI (accept → review card → Create Job) can link once the truck
 *  id exists. No status change. */
export async function linkConvertedTruck(db, id, truckId, actor) {
    const row = await loadRow(db, id);
    if (!row)
        return err("Photo estimate not found.");
    const { changed } = await commitWithEvent({
        source: "app",
        resourceType: "photo_estimate",
        resourceId: id,
        action: "update",
        actor: { label: actor.name },
        changes: [{ field: "converted_truck_id", before: row.converted_truck_id, after: truckId }],
    }, {
        text: `UPDATE fcr_core.photo_estimate
                SET converted_truck_id = $2, updated_by = $3, updated_by_name = $4, updated_at = NOW()
              WHERE id = $1 AND deleted_at IS NULL`,
        params: [id, truckId, actor.username ?? null, actor.name],
    }, db);
    if (!changed)
        return err("Photo estimate not found."); // deleted between loadRow and write
    return { ok: true, id };
}
