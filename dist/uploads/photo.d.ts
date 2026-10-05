import { type Queryable } from "./seam.js";
import { UUID_RE, type BlobVerify } from "./write.js";
export type { Queryable, BlobVerify };
export { UUID_RE };
export type RecordPhotoInput = {
    unitType: string;
    unitId: string;
    blobUrl: string;
    blobPathname: string;
    contentType: string;
    byteSize: number;
    caption: string | null;
};
export type PhotoWriteResult = {
    ok: true;
    id: string;
} | {
    ok: false;
    errors: string[];
};
export declare const MAX_PHOTO_BYTES: number;
export declare const PHOTO_ALLOWED_TYPES: readonly ["image/jpeg", "image/png", "image/heic", "image/webp"];
export declare function expectedPhotoPrefix(unitType: string, unitId: string): string;
export declare function recordUnitPhoto(input: RecordPhotoInput, actor: {
    username: string;
    name: string;
}, deps: {
    db: Queryable;
    verify: BlobVerify;
}): Promise<PhotoWriteResult>;
//# sourceMappingURL=photo.d.ts.map