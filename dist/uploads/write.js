// Unit-file WRITE core — records an already-uploaded Vercel Blob as a fcr_core.unit_file row
// (originated as epic #159 Pillar A — Amanda's "upload a tow/storage receipt to the unit + a purpose
// note for accounting" flow; extracted to @fcr/core so the trailers app can reuse it, fcr-trailers #48).
//
// Transport: the browser uploads the bytes DIRECTLY to Vercel Blob via @vercel/blob/client `upload()`
// (see @fcr/ui FileUploadForm + the app's /api/records/file token route), NOT through a server route
// body — a Vercel serverless function caps the request body at ~4.5 MB and would 413 a real 5–15 MB
// scanned receipt at the platform edge before any of our code ran (round-1 review, HIGH). So this
// core does not receive the File; it receives the ALREADY-UPLOADED blob's metadata and records the
// row. Type + size are enforced at the Blob edge by the token route's allowedContentTypes/
// maximumSizeInBytes; the checks here are defence-in-depth on the finalize call, which a client could
// invoke with forged metadata.
//
// Injected seams: `db` executes SQL (see ./seam); `verify` is blob head() — used to prove the blob
// actually exists AND sits under our own unit-files/<type>/<id>/ prefix, so a client can't attach an
// arbitrary public blob url to a unit. No @fcr/core/events, no SF push: unit_file is not a sync target
// and this never touches the unit's local_edit_at. @fcr/core stays dependency-free — the blob SDK call
// is injected, never imported here.
import { rowsOf } from "./seam.js";
// uuid matcher — @fcr/core has no uuid util, so the uploads module carries its own (same regex the
// apps use). A unit_id must be a real uuid before we trust it in a prefix or a query.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB — a scanned multi-page receipt fits; blocks abuse
// Receipts/docs are PDFs or phone photos. Allowlist keeps someone from parking an executable/HTML on the unit.
export const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"];
const ALLOWED = new Set(ALLOWED_TYPES);
// The blob path we require an upload to live under. The token route only issues a client-upload
// token for a pathname beginning with this, so a real blob here went through our auth+limit gate.
export function expectedPrefix(unitType, unitId) {
    return `unit-files/${unitType}/${unitId}/`;
}
export async function recordUnitFile(input, actor, deps) {
    const { unitType, unitId, blobUrl, blobPathname, contentType, byteSize } = input;
    const purpose = input.purpose?.trim() || null;
    // Store the clean name the user picked (not the ts-/random-suffixed storage key). Sanitize defensively.
    const filename = (input.filename || "receipt").replace(/[^\w.\-]/g, "_").slice(-100) || "receipt";
    const errors = [];
    if (unitType !== "truck" && unitType !== "trailer")
        errors.push("Unknown unit type.");
    if (!UUID_RE.test(unitId))
        errors.push("Bad unit id.");
    if (!ALLOWED.has(contentType))
        errors.push("File must be a PDF or an image.");
    if (!Number.isFinite(byteSize) || byteSize <= 0)
        errors.push("File is empty.");
    else if (byteSize > MAX_FILE_BYTES)
        errors.push("File is too large (max 15 MB).");
    if (!blobPathname.startsWith(expectedPrefix(unitType, unitId)))
        errors.push("File is not attached to this unit.");
    if (errors.length)
        return { ok: false, errors };
    // Prove the blob exists (and re-confirm its real pathname) before trusting the client's metadata.
    let verified;
    try {
        verified = await deps.verify(blobUrl);
    }
    catch {
        return { ok: false, errors: ["Uploaded file not found. Try again."] };
    }
    if (!verified.pathname.startsWith(expectedPrefix(unitType, unitId))) {
        return { ok: false, errors: ["File is not attached to this unit."] };
    }
    if (verified.size > MAX_FILE_BYTES)
        return { ok: false, errors: ["File is too large (max 15 MB)."] };
    try {
        const raw = await deps.db.query(`INSERT INTO fcr_core.unit_file
         (unit_type, unit_id, filename, blob_url, blob_pathname, content_type, byte_size,
          purpose, uploaded_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`, [unitType, unitId, filename, blobUrl, verified.pathname, contentType, verified.size, purpose, actor.name]);
        const rows = rowsOf(raw);
        const id = rows[0]?.id;
        if (!id)
            return { ok: false, errors: ["Could not save the file record."] };
        return { ok: true, id };
    }
    catch {
        return { ok: false, errors: ["Could not save the file record."] };
    }
}
