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
import { rowsOf, sanitizeFilename, type Queryable } from "./seam.js";

export type { Queryable };

// uuid matcher — @fcr/core has no uuid util, so the uploads module carries its own (same regex the
// apps use). A unit_id must be a real uuid before we trust it in a prefix or a query.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Blob existence check seam — the app injects @vercel/blob's head(); a test injects a fake.
export type BlobVerify = (url: string) => Promise<{ pathname: string; size: number }>;

export type RecordFileInput = {
  unitType: string;
  unitId: string;
  filename: string; // the clean original name the user picked (blob_pathname keeps the ts/random suffix)
  blobUrl: string;
  blobPathname: string;
  contentType: string;
  byteSize: number;
  purpose: string | null;
};

export type FileWriteResult = { ok: true; id: string } | { ok: false; errors: string[] };

export const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB — a scanned multi-page receipt fits; blocks abuse
// Receipts/docs are PDFs or phone photos. Allowlist keeps someone from parking an executable/HTML on the unit.
export const ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"] as const;
const ALLOWED = new Set<string>(ALLOWED_TYPES);

// The blob path we require an upload to live under. The token route only issues a client-upload
// token for a pathname beginning with this, so a real blob here went through our auth+limit gate.
export function expectedPrefix(unitType: string, unitId: string): string {
  return `unit-files/${unitType}/${unitId}/`;
}

// The per-kind upload policy. The ONLY differences between a unit_file and a unit_photo upload are
// these values (prefix, allowed types, size cap, wording) — so the security-critical guard sequence
// lives ONCE, in verifyUploadInput, parameterized by this (mirroring token.ts's makeBeforeToken).
export type UploadPolicy = {
  allowed: ReadonlySet<string>;
  maxBytes: number;
  prefix: (unitType: string, unitId: string) => string;
  msg: {
    unknownType: string;
    badId: string;
    badContentType: string;
    empty: string;
    tooLarge: string;
    notAttached: string;
    notFound: string;
  };
};

export type VerifyResult =
  | { ok: true; verified: { pathname: string; size: number } }
  | { ok: false; errors: string[] };

// Shared validate + verify for a client-direct upload finalize. Runs every guard BEFORE the blob
// lookup (so a bad request never costs a head() call), then proves the blob exists and re-confirms
// its REAL pathname + size against the policy — the defence-in-depth a lying client can't dodge.
// recordUnitFile and recordUnitPhoto both call this so these guards can never drift between them.
export async function verifyUploadInput(
  input: { unitType: string; unitId: string; blobUrl: string; blobPathname: string; contentType: string; byteSize: number },
  policy: UploadPolicy,
  verify: BlobVerify,
): Promise<VerifyResult> {
  const { unitType, unitId, blobUrl, blobPathname, contentType, byteSize } = input;
  const errors: string[] = [];
  if (unitType !== "truck" && unitType !== "trailer") errors.push(policy.msg.unknownType);
  if (!UUID_RE.test(unitId)) errors.push(policy.msg.badId);
  if (!policy.allowed.has(contentType)) errors.push(policy.msg.badContentType);
  if (!Number.isFinite(byteSize) || byteSize <= 0) errors.push(policy.msg.empty);
  else if (byteSize > policy.maxBytes) errors.push(policy.msg.tooLarge);
  if (!blobPathname.startsWith(policy.prefix(unitType, unitId))) errors.push(policy.msg.notAttached);
  if (errors.length) return { ok: false, errors };

  let verified: { pathname: string; size: number };
  try {
    verified = await verify(blobUrl);
  } catch {
    return { ok: false, errors: [policy.msg.notFound] };
  }
  if (!verified.pathname.startsWith(policy.prefix(unitType, unitId))) {
    return { ok: false, errors: [policy.msg.notAttached] };
  }
  if (verified.size > policy.maxBytes) return { ok: false, errors: [policy.msg.tooLarge] };
  return { ok: true, verified };
}

const FILE_POLICY: UploadPolicy = {
  allowed: ALLOWED,
  maxBytes: MAX_FILE_BYTES,
  prefix: expectedPrefix,
  msg: {
    unknownType: "Unknown unit type.",
    badId: "Bad unit id.",
    badContentType: "File must be a PDF or an image.",
    empty: "File is empty.",
    tooLarge: "File is too large (max 15 MB).",
    notAttached: "File is not attached to this unit.",
    notFound: "Uploaded file not found. Try again.",
  },
};

export async function recordUnitFile(
  input: RecordFileInput,
  actor: { username: string; name: string },
  deps: { db: Queryable; verify: BlobVerify },
): Promise<FileWriteResult> {
  const { unitType, unitId, blobUrl, contentType } = input;
  const purpose = input.purpose?.trim() || null;
  // Store the clean name the user picked (not the ts-/random-suffixed storage key). Sanitize defensively.
  const filename = sanitizeFilename(input.filename || "receipt").slice(-100) || "receipt";

  // Shared guard + verify (one home for the security-critical checks — see verifyUploadInput).
  const v = await verifyUploadInput(input, FILE_POLICY, deps.verify);
  if (!v.ok) return { ok: false, errors: v.errors };
  const { verified } = v;

  try {
    const raw = await deps.db.query(
      `INSERT INTO fcr_core.unit_file
         (unit_type, unit_id, filename, blob_url, blob_pathname, content_type, byte_size,
          purpose, uploaded_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [unitType, unitId, filename, blobUrl, verified.pathname, contentType, verified.size, purpose, actor.name],
    );
    const rows = rowsOf<{ id: string }>(raw);
    const id = rows[0]?.id;
    if (!id) return { ok: false, errors: ["Could not save the file record."] };
    return { ok: true, id };
  } catch {
    return { ok: false, errors: ["Could not save the file record."] };
  }
}
