import { type Queryable } from "./seam.js";
export type { Queryable };
export declare const UUID_RE: RegExp;
export type BlobVerify = (url: string) => Promise<{
    pathname: string;
    size: number;
    contentType: string;
}>;
export declare function inferContentType(filename: string): string | null;
export declare function resolveContentType(reportedType: string | undefined, filename: string): string | null;
export type RecordFileInput = {
    unitType: string;
    unitId: string;
    filename: string;
    blobUrl: string;
    blobPathname: string;
    contentType: string;
    byteSize: number;
    purpose: string | null;
};
export type FileWriteResult = {
    ok: true;
    id: string;
} | {
    ok: false;
    errors: string[];
};
export declare const MAX_FILE_BYTES: number;
export declare const ALLOWED_TYPES: readonly ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"];
export declare function expectedPrefix(unitType: string, unitId: string): string;
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
export type VerifyResult = {
    ok: true;
    verified: {
        pathname: string;
        size: number;
        contentType: string;
    };
} | {
    ok: false;
    errors: string[];
};
export declare function verifyUploadInput(input: {
    unitType: string;
    unitId: string;
    blobUrl: string;
    blobPathname: string;
    contentType: string;
    byteSize: number;
}, policy: UploadPolicy, verify: BlobVerify): Promise<VerifyResult>;
export declare function recordUnitFile(input: RecordFileInput, actor: {
    username: string;
    name: string;
}, deps: {
    db: Queryable;
    verify: BlobVerify;
}): Promise<FileWriteResult>;
//# sourceMappingURL=write.d.ts.map