// @fcr/core/photo-estimates — shared domain for the Photo Estimates module (epic
// fcr-estimating#94), consumed by fcr-sales (submit) and fcr-estimating (board/complete/convert).
// React-free, DB-driver-free: inject a Queryable. See ./types for the status machine and the
// app-owned / never-SF-synced invariant.

export * from "./types.js";
export {
  createPhotoEstimate,
  assignPhotoEstimate,
  completePhotoEstimate,
  acceptPhotoEstimate,
  declinePhotoEstimate,
  linkConvertedTruck,
  type PhotoEstimateCreateInput,
} from "./write.js";
export {
  getPhotoEstimate,
  listPhotoEstimates,
  photoEstimateCounts,
  type PhotoEstimateListFilter,
} from "./read.js";
