import { type Queryable } from "./seam.js";
export type { Queryable };
export type ListedBlob = {
    pathname: string;
    url: string;
    uploadedAt: Date;
};
export type BlobLister = (opts: {
    prefix: string;
    cursor?: string;
}) => Promise<{
    blobs: ListedBlob[];
    cursor?: string;
    hasMore: boolean;
}>;
export type BlobDeleter = (urls: string[]) => Promise<void>;
export declare const UNIT_FILES_PREFIX = "unit-files/";
export declare const DEFAULT_GRACE_MS: number;
export declare const MAX_DELETE_FRACTION = 0.5;
export type GcResult = {
    scanned: number;
    live: number;
    orphaned: number;
    deleted: number;
    aborted?: "live-zero" | "over-fraction";
};
export declare function reconcileUnitFileBlobs(deps: {
    list: BlobLister;
    del: BlobDeleter;
    db: Queryable;
    now?: number;
    graceMs?: number;
    prefix?: string;
}): Promise<GcResult>;
//# sourceMappingURL=gc.d.ts.map