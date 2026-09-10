import type { Queryable } from "../rbac/index.js";
import type { ReportDefinition } from "./definition.js";
export type SavedReport = {
    id: string;
    ownerAccountId: string;
    name: string;
    objectKey: string;
    definition: ReportDefinition;
    shared: boolean;
    createdAt: string;
    updatedAt: string;
};
export type SavedReportInput = {
    name: string;
    objectKey: string;
    definition: ReportDefinition;
};
/** Reports visible to an account: their own + any shared. Newest-updated first, capped. */
export declare function listSavedReports(db: Queryable, accountId: string): Promise<SavedReport[]>;
/** One report IF the account may see it (owner OR shared). Null otherwise — never another user's private report. */
export declare function getSavedReport(db: Queryable, accountId: string, id: string): Promise<SavedReport | null>;
/**
 * Create/update a saved report for an account. Dedupes on (owner, name, object) via an ATOMIC upsert on
 * the partial-unique index — so a double-click / concurrent Save updates the existing row's definition
 * instead of racing two inserts into duplicate rows. Prunes the account's own reports beyond the cap.
 */
export declare function saveReport(db: Queryable, accountId: string, input: SavedReportInput): Promise<SavedReport>;
/** Owner-scoped soft delete — a wrong id/owner is a no-op, never touches another user's report. */
export declare function deleteSavedReport(db: Queryable, accountId: string, id: string): Promise<void>;
//# sourceMappingURL=savedReports.d.ts.map