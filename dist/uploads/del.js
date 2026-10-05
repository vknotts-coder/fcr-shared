// Soft-delete core for a unit_file (originated #170). Soft-deletes the row and returns the fields the
// caller needs to finish cleanup (del the blob now; the gc sweep is the backstop). Extracted to
// @fcr/core (fcr-trailers #48) so every app soft-deletes with the SAME semantics — live-row-only,
// returning the SF link ids so an app that bridges to Salesforce (dispatch's receipt push) can mirror
// the delete. The blob del, the optional SF delete, and revalidatePath stay in each app's "use server"
// action (Next-specific wiring); this is only the DB mutation.
import { rowsOf } from "./seam.js";
import { UUID_RE } from "./write.js";
// Soft-delete a LIVE unit_file row by id. Returns the cleanup row, or null if no live row matched
// (already deleted, or bad id). Idempotent: a second call for the same id returns null (deleted_at is
// already set), so it can't double-fire blob/SF deletes.
//
// Guard the id with UUID_RE FIRST: fileId is user-supplied, the column is uuid, and a non-uuid handed
// straight to the UPDATE makes Postgres throw `22P02 invalid input syntax for type uuid` — which would
// surface as a 500, not the documented graceful null (the unit-test fake db hid this because it ignores
// params). A bad id is a no-op, same as a missing row.
export async function softDeleteUnitFile(db, fileId) {
    if (!UUID_RE.test(fileId))
        return null;
    const raw = await db.query(`UPDATE fcr_core.unit_file
        SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING blob_url, unit_type, unit_id, sf_content_document_id, sf_content_version_id`, [fileId]);
    const rows = rowsOf(raw);
    return rows[0] ?? null;
}
// Soft-delete a LIVE unit_photo row by id — the photo parallel of softDeleteUnitFile. Same UUID_RE
// guard (a non-uuid would 22P02→500 against the uuid column) and same idempotent no-op on a missing
// row, so it can't double-fire the blob delete.
export async function softDeleteUnitPhoto(db, photoId) {
    if (!UUID_RE.test(photoId))
        return null;
    const raw = await db.query(`UPDATE fcr_core.unit_photo
        SET deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING url, unit_type, unit_id`, [photoId]);
    const rows = rowsOf(raw);
    return rows[0] ?? null;
}
