// Unit-PHOTO write core — records an already-uploaded Vercel Blob as a fcr_core.unit_photo row
// (fcr-trailers #48 slice 4). The photo sibling of write.ts (unit_file): same client-direct transport
// (the browser PUTs bytes straight to Blob, dodging the ~4.5 MB serverless body cap — phone photos are
// routinely larger), same injected db+verify seams, same prefix-pinning defence. @fcr/core stays
// dependency-free: the blob SDK call is injected, never imported here.
//
// The validate+verify guard sequence is the SHARED verifyUploadInput (write.ts), parameterized by a
// PHOTO_POLICY — so the security-critical checks live in one place and can't drift from the file core.
// unit_photo differs from unit_file in its columns (`url` not `blob_url`, a `caption` not a `purpose`)
// and in being images-only with its own prefix.
import { rowsOf } from "./seam.js";
import { verifyUploadInput } from "./write.js";
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
const PHOTO_POLICY = {
    allowed: PHOTO_ALLOWED,
    maxBytes: MAX_PHOTO_BYTES,
    prefix: expectedPhotoPrefix,
    msg: {
        unknownType: "Unknown unit type.",
        badId: "Bad unit id.",
        badContentType: "Photo must be a JPEG, PNG, HEIC, or WebP image.",
        empty: "Photo is empty.",
        tooLarge: "Photo is too large (max 15 MB).",
        notAttached: "Photo is not attached to this unit.",
        notFound: "Uploaded photo not found. Try again.",
    },
};
export async function recordUnitPhoto(input, actor, deps) {
    const { unitType, unitId, blobUrl } = input;
    // Caption is free text the user types (spaces + punctuation kept — it is NOT a filename); trim,
    // cap length, and null out when blank. Stored via a parameterized INSERT, so no escaping needed.
    const caption = input.caption?.trim().slice(0, 200) || null;
    // Shared guard + verify (one home for the security-critical checks — see verifyUploadInput).
    const v = await verifyUploadInput(input, PHOTO_POLICY, deps.verify);
    if (!v.ok)
        return { ok: false, errors: v.errors };
    const { verified } = v;
    try {
        const raw = await deps.db.query(`INSERT INTO fcr_core.unit_photo
         (unit_type, unit_id, url, blob_pathname, content_type, byte_size, uploaded_by_name, caption)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`, [unitType, unitId, blobUrl, verified.pathname, verified.contentType, verified.size, actor.name, caption]);
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
