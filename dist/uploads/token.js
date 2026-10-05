// Client-direct upload TOKEN policy (originated epic #159 Pillar A; extracted for fcr-trailers #48).
// The browser uploads bytes straight to Vercel Blob (@vercel/blob/client `upload()`), so a 5–15 MB
// receipt never hits the ~4.5 MB serverless request-body cap that would 413 a server-proxied upload.
// The app's /api/records/file route calls @vercel/blob/client `handleUpload` and passes THIS as its
// onBeforeGenerateToken — the branch that carries the user's cookies.
//
// Auth is the per-app seam: the app supplies `authorize`, which runs on the cookie-carrying token
// request and THROWS if the caller may not upload (dispatch = requireFullUser + the passthrough
// preview allowlist; trailers = can(operate, trailer)). The completed-callback branch is a separate,
// cookie-less request Blob signs with an HMAC — it must NOT be gated here (handleUpload verifies that
// signature itself), which is why auth lives inside this callback, not around the whole route.
//
// @fcr/core stays dependency-free: @vercel/blob/client is NEVER imported here. The return shape is
// exactly what handleUpload's onBeforeGenerateToken expects, typed structurally.
import { UUID_RE, ALLOWED_TYPES, MAX_FILE_BYTES, expectedPrefix } from "./write.js";
import { PHOTO_ALLOWED_TYPES, MAX_PHOTO_BYTES, expectedPhotoPrefix } from "./photo.js";
// Shared builder: `authorize` is the app's auth check — it throws to reject (the thrown message
// becomes the 400). Then parse the client payload, validate the unit reference, and PIN the pathname
// to this unit's prefix so a minted token can only ever produce an upload the matching record* core
// will accept for this unit.
function makeBeforeToken(authorize, policy) {
    return async (pathname, clientPayload) => {
        await authorize();
        const { unitType, unitId } = JSON.parse(clientPayload || "{}");
        if ((unitType !== "truck" && unitType !== "trailer") || !unitId || !UUID_RE.test(unitId)) {
            throw new Error("Bad unit reference.");
        }
        if (!pathname.startsWith(policy.prefix(unitType, unitId))) {
            throw new Error("File path is not under this unit.");
        }
        return {
            allowedContentTypes: [...policy.allowedContentTypes],
            maximumSizeInBytes: policy.maximumSizeInBytes,
            addRandomSuffix: true,
            tokenPayload: JSON.stringify({ unitType, unitId }),
        };
    };
}
// Token policy for a unit_file upload (PDF/image, unit-files/ prefix).
export function makeBeforeGenerateToken(authorize) {
    return makeBeforeToken(authorize, {
        prefix: expectedPrefix,
        allowedContentTypes: ALLOWED_TYPES,
        maximumSizeInBytes: MAX_FILE_BYTES,
    });
}
// Token policy for a unit_photo upload (images only, unit-photos/ prefix).
export function makeBeforePhotoToken(authorize) {
    return makeBeforeToken(authorize, {
        prefix: expectedPhotoPrefix,
        allowedContentTypes: PHOTO_ALLOWED_TYPES,
        maximumSizeInBytes: MAX_PHOTO_BYTES,
    });
}
