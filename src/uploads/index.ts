// @fcr/core/uploads — the shared, React-free unit-file upload subsystem (fcr-trailers #48 slice 1).
// Extracted verbatim-in-behavior from fcr-dispatch's lib/records/files so dispatch + trailers run one
// implementation. Each app supplies its own auth (the token `authorize` seam), its own blob SDK calls
// (head/del/list injected via the deps/resolver seams), and its own "use server" wrappers; @fcr/core
// stays dependency-free. The React upload form lives in @fcr/ui/uploads.
export {
  recordUnitFile,
  expectedPrefix,
  UUID_RE,
  MAX_FILE_BYTES,
  ALLOWED_TYPES,
  type RecordFileInput,
  type FileWriteResult,
  type BlobVerify,
  type Queryable,
} from "./write.js";

export {
  reconcileUnitFileBlobs,
  reconcileUnitPhotoBlobs,
  UNIT_FILES_PREFIX,
  UNIT_PHOTOS_PREFIX,
  DEFAULT_GRACE_MS,
  MAX_DELETE_FRACTION,
  type ListedBlob,
  type BlobLister,
  type BlobDeleter,
  type GcResult,
  type ReconcileDeps,
} from "./gc.js";

export {
  recordUnitPhoto,
  expectedPhotoPrefix,
  MAX_PHOTO_BYTES,
  PHOTO_ALLOWED_TYPES,
  type RecordPhotoInput,
  type PhotoWriteResult,
} from "./photo.js";

export {
  makeBeforeGenerateToken,
  makeBeforePhotoToken,
  type BeforeGenerateToken,
  type GenerateTokenConfig,
} from "./token.js";

export { streamBlob, type DownloadUrlResolver } from "./proxy.js";

export {
  softDeleteUnitFile,
  softDeleteUnitPhoto,
  type UnitFileCleanup,
  type UnitPhotoCleanup,
} from "./del.js";

export { rowsOf } from "./seam.js";
