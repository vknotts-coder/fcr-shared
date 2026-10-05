import { type Queryable } from "./seam.js";
export type { Queryable };
export type UnitFileCleanup = {
    blob_url: string;
    unit_type: string;
    unit_id: string;
    sf_content_document_id: string | null;
    sf_content_version_id: string | null;
};
export declare function softDeleteUnitFile(db: Queryable, fileId: string): Promise<UnitFileCleanup | null>;
//# sourceMappingURL=del.d.ts.map