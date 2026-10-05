// Orphan-blob reconciliation for unit files (originated #170). The upload is client-direct: the
// browser PUTs the blob, then a finalize server action writes the unit_file row. Two ways a blob can
// end up with no LIVE row: (a) the upload succeeded but finalize failed/aborted (orphan), or (b) the
// row was soft-deleted (deleted_at set) — its blob should go too. This sweep deletes any blob under
// the unit-files/ prefix that no live unit_file row references, and is the backstop behind the
// immediate del() the delete action does. Extracted to @fcr/core (fcr-trailers #48) so every app's
// upload store is reconciled by the SAME blast-radius-guarded sweep.
//
// GRACE WINDOW: a blob that was just uploaded but whose finalize hasn't landed YET looks identical to
// an orphan. So a blob with no row is only deleted once it is older than graceMs — long enough that
// any real finalize has completed. Injected seams (list/del/db) keep this unit-testable without Blob.
import { rowsOf } from "./seam.js";
export const UNIT_FILES_PREFIX = "unit-files/";
export const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 1h — far longer than a finalize takes
const DEL_CHUNK = 100;
// Blast-radius guard for an UNATTENDED destructive job: if a valid-but-wrong DB target (an empty/
// drifted branch during an incident, or a change to how blob_pathname is stored) makes live files
// read as orphans, one run could wipe the whole store. Abort instead of deleting when the live set is
// empty-but-blobs-exist, or when we'd delete more than this fraction of what we scanned.
export const MAX_DELETE_FRACTION = 0.5;
export async function reconcileUnitFileBlobs(deps) {
    const now = deps.now ?? Date.now();
    const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
    const prefix = deps.prefix ?? UNIT_FILES_PREFIX;
    // 1) Enumerate every blob under the prefix (paginated).
    const all = [];
    let cursor;
    do {
        const page = await deps.list({ prefix, cursor });
        all.push(...page.blobs);
        cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    if (all.length === 0)
        return { scanned: 0, live: 0, orphaned: 0, deleted: 0 };
    // 2) Which of those pathnames still have a LIVE (not soft-deleted) unit_file row?
    const pathnames = all.map((b) => b.pathname);
    const raw = await deps.db.query(`SELECT blob_pathname FROM fcr_core.unit_file
      WHERE deleted_at IS NULL AND blob_pathname = ANY($1::text[])`, [pathnames]);
    const rows = rowsOf(raw);
    const live = new Set(rows.map((r) => r.blob_pathname));
    // 3) An orphan = no live row AND older than the grace window (so we never race an in-flight upload).
    const orphans = all.filter((b) => {
        if (live.has(b.pathname))
            return false;
        const age = now - new Date(b.uploadedAt).getTime();
        return age > graceMs;
    });
    // 3b) BLAST-RADIUS GUARD — refuse to run destructively against a target that looks wrong.
    // Zero live rows but blobs exist ⇒ almost certainly the wrong/empty DB, not a truly-empty store.
    if (live.size === 0) {
        return { scanned: all.length, live: 0, orphaned: orphans.length, deleted: 0, aborted: "live-zero" };
    }
    // Deleting more than half of everything scanned in one unattended run ⇒ bail and alert.
    if (orphans.length > all.length * MAX_DELETE_FRACTION) {
        return { scanned: all.length, live: live.size, orphaned: orphans.length, deleted: 0, aborted: "over-fraction" };
    }
    // 4) Delete in chunks.
    let deleted = 0;
    for (let i = 0; i < orphans.length; i += DEL_CHUNK) {
        const batch = orphans.slice(i, i + DEL_CHUNK).map((b) => b.url);
        await deps.del(batch);
        deleted += batch.length;
    }
    return { scanned: all.length, live: live.size, orphaned: orphans.length, deleted };
}
