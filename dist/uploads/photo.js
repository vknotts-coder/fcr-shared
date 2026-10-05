// Unit-PHOTO write core — records an already-uploaded Vercel Blob as a fcr_core.unit_photo row
// (fcr-trailers #48 slice 4). The photo sibling of write.ts (unit_file): same client-direct transport
// (the browser PUTs bytes straight to Blob, dodging the ~4.5 MB serverless body cap — phone photos are
// routinely larger), same injected db+verify seams, same prefix-pinning defence. @fcr/core stays
// dependency-free: the blob SDK call is injected, never imported here.
//
// unit_photo differs from unit_file in its columns: `url` (not `blob_url`), a `caption` (not a
// `purpose`), and images only (no PDF). Its own prefix (unit-photos/) keeps the photo token + the GC
// sweep from colliding with files.
import { rowsOf } from "./seam.js";
import { UUID_RE } from "./write.js";
export { UUID_RE };
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // 15 MB — a high-res phone photo fits; blocks abuse
// Photos are images only (no PDF, no html/svg) — the allowlist also keeps an executable off the unit.
export const PHOTO_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/heic", "image/webp"];
const PHOTO_ALLOWED = new Set(PHOTO_ALLOWED_TYPES);
// The blob path a photo upload must live under. The photo token route only mints a token for a
// pathname beginning with this, so a real blob here went through our auth+limit gate. Distinct from
// unit-files/ so the file GC sweep (keyed on unit-files/) never touches photos and vice versa.
export function expectedPhotoPrefix(unitType, unitId) {
    return `unit-photos/${unitType}/${unitId}/`;
}
export async function recordUnitPhoto(input, actor, deps) {
    const { unitType, unitId, blobUrl, blobPathname, contentType, byteSize } = input;
    // Caption is free text the user types (spaces + punctuation kept — it is NOT a filename); trim,
    // cap length, and null out when blank. Stored via a parameterized INSERT, so no escaping needed.
    const caption = input.caption?.trim().slice(0, 200) || null;
    const errors = [];
    if (unitType !== "truck" && unitType !== "trailer")
        errors.push("Unknown unit type.");
    if (!UUID_RE.test(unitId))
        errors.push("Bad unit id.");
    if (!PHOTO_ALLOWED.has(contentType))
        errors.push("Photo must be a JPEG, PNG, HEIC, or WebP image.");
    if (!Number.isFinite(byteSize) || byteSize <= 0)
        errors.push("Photo is empty.");
    else if (byteSize > MAX_PHOTO_BYTES)
        errors.push("Photo is too large (max 15 MB).");
    if (!blobPathname.startsWith(expectedPhotoPrefix(unitType, unitId))) {
        errors.push("Photo is not attached to this unit.");
    }
    if (errors.length)
        return { ok: false, errors };
    // Prove the blob exists (and re-confirm its real pathname) before trusting the client's metadata.
    let verified;
    try {
        verified = await deps.verify(blobUrl);
    }
    catch {
        return { ok: false, errors: ["Uploaded photo not found. Try again."] };
    }
    if (!verified.pathname.startsWith(expectedPhotoPrefix(unitType, unitId))) {
        return { ok: false, errors: ["Photo is not attached to this unit."] };
    }
    if (verified.size > MAX_PHOTO_BYTES)
        return { ok: false, errors: ["Photo is too large (max 15 MB)."] };
    try {
        const raw = await deps.db.query(`INSERT INTO fcr_core.unit_photo
         (unit_type, unit_id, url, blob_pathname, content_type, byte_size, uploaded_by_name, caption)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`, [unitType, unitId, blobUrl, verified.pathname, contentType, verified.size, actor.name, caption]);
        const rows = rowsOf(raw);
        const id = rows[0]?.id;
        if (!id)
            return { ok: false, errors: ["Could not save the photo record."] };
        return { ok: true, id };
    }
    catch {
        return { ok: false, errors: ["Could not save the photo record."] };
    }
}
