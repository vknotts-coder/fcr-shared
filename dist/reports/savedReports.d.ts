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
    /** When set, UPDATE that owned report in place (rename/edit) instead of creating a new one (#66). A
     *  stale/deleted/not-owned id simply falls through to a create, so a dead link never 500s. */
    id?: string | null;
    name: string;
    objectKey: string;
    definition: ReportDefinition;
};
/** Thrown by {@link saveReport} when the write would collide with ANOTHER of the account's reports on
 *  (name, object) — a new report under an existing name, or a rename onto a taken name. The caller surfaces
 *  it as a clear "name already exists" message instead of the old silent name-keyed overwrite (#66, #2). */
export declare class SavedReportNameConflictError extends Error {
    readonly reportName: string;
    constructor(reportName: string);
}
/** Reports visible to an account: their own + any shared. Newest-updated first, capped. */
export declare function listSavedReports(db: Queryable, accountId: string): Promise<SavedReport[]>;
/** One report IF the account may see it (owner OR shared). Null otherwise — never another user's private report. */
export declare function getSavedReport(db: Queryable, accountId: string, id: string): Promise<SavedReport | null>;
/**
 * Create or update a saved report for an account, keyed on IDENTITY (#66):
 *   • `input.id` set → UPDATE that owned row in place (rename/edit), so opening a saved report, renaming it,
 *     and saving updates the SAME row instead of orphaning it + inserting a duplicate. A stale/deleted/
 *     not-owned id matches no row and falls through to a create (a dead link never 500s).
 *   • no `input.id` → a plain INSERT of a NEW row. It is NOT a name-keyed upsert: two coworkers (per-account
 *     scope) saving different reports under the same name no longer silently overwrite each other — the
 *     partial-unique index raises a conflict, surfaced as {@link SavedReportNameConflictError} for the caller
 *     to turn into a clear "name already exists" message. A rename ONTO a taken name raises the same error.
 * Prunes the account's own reports beyond the cap.
 */
export declare function saveReport(db: Queryable, accountId: string, input: SavedReportInput): Promise<SavedReport>;
/** Owner-scoped soft delete — a wrong id/owner is a no-op, never touches another user's report. */
export declare function deleteSavedReport(db: Queryable, accountId: string, id: string): Promise<void>;
//# sourceMappingURL=savedReports.d.ts.map