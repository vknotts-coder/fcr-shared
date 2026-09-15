import type { Queryable } from "../rbac/index.js";
import type { Actor, DuplicateHit, IntakeSpec, SaveResult } from "./types.js";
/**
 * The dedupe guard. Given the about-to-be-written columns, looks for existing non-deleted
 * units that likely duplicate this one: a VIN match across BOTH unit tables, and a same-table
 * unit-number (sf_name) match. Returns the hits so the caller can surface "possible duplicate
 * → open it / create anyway"; it never blocks on its own. VIN can't be a DB unique constraint
 * (often blank at "Awaiting Pickup Info", split across two tables), so this app-level check at
 * the single create chokepoint is how the fleet stays dedupe'd.
 */
export declare function findDuplicates(spec: IntakeSpec, cols: Record<string, unknown>, db: Queryable): Promise<DuplicateHit[]>;
/**
 * Create a new unit. Generates the fcr_core uuid (sf_id stays null until dispatch's reverse
 * sync creates the SF record and backfills it). Unless `confirmDuplicate` is set, a dedupe
 * hit short-circuits with `{ ok:false, duplicates }` so the UI can offer "create anyway".
 */
export declare function createUnit(spec: IntakeSpec, formData: FormData, actor: Actor, db: Queryable, opts?: {
    confirmDuplicate?: boolean;
}): Promise<SaveResult>;
/**
 * Edit an existing unit. Reads the before-image, runs the engine + validation over the
 * effective state, and writes the row + audit event atomically with an optimistic-concurrency
 * guard (the before-image's updated_at), so a concurrent edit can't be silently lost.
 */
export declare function updateUnit(spec: IntakeSpec, id: string, formData: FormData, actor: Actor, db: Queryable): Promise<SaveResult>;
//# sourceMappingURL=pipeline.d.ts.map