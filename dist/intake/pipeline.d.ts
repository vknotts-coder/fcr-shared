import type { Queryable, TxRunner } from "../rbac/index.js";
import type { Actor, ContactInput, CreateUnitsResult, CustomerInput, DuplicateHit, IntakeSpec, SaveResult } from "./types.js";
/**
 * The dedupe guard. Given the about-to-be-written columns, looks for existing non-deleted
 * units that likely duplicate this one: a VIN match across BOTH unit tables, and a same-table
 * unit-number (sf_name) match. Returns the hits so the caller can surface "possible duplicate
 * → open it / create anyway"; it never blocks on its own. VIN can't be a DB unique constraint
 * (often blank at "Awaiting Pickup Info", split across two tables), so this app-level check at
 * the single create chokepoint is how the fleet stays dedupe'd.
 */
export declare function findDuplicates(spec: IntakeSpec, cols: Record<string, unknown>, db: Queryable): Promise<DuplicateHit[]>;
export declare function createUnit(spec: IntakeSpec, formData: FormData, actor: Actor, db: Queryable, opts?: {
    confirmDuplicate?: boolean;
}): Promise<SaveResult>;
export declare function createUnits(spec: IntakeSpec, customer: CustomerInput, contact: ContactInput, units: FormData[], actor: Actor, db: Queryable, opts?: {
    confirmDuplicate?: boolean;
    tx?: TxRunner;
}): Promise<CreateUnitsResult>;
/**
 * Edit an existing unit. Reads the before-image, runs the engine + validation over the
 * effective state, and writes the row + audit event atomically with an optimistic-concurrency
 * guard (the before-image's updated_at), so a concurrent edit can't be silently lost.
 */
export declare function updateUnit(spec: IntakeSpec, id: string, formData: FormData, actor: Actor, db: Queryable): Promise<SaveResult>;
//# sourceMappingURL=pipeline.d.ts.map