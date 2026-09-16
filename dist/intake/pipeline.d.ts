import type { Queryable } from "../rbac/index.js";
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
/**
 * Create a new unit. Generates the fcr_core uuid (sf_id stays null until dispatch's reverse
 * sync creates the SF record and backfills it). Unless `confirmDuplicate` is set, a dedupe
 * hit short-circuits with `{ ok:false, duplicates }` so the UI can offer "create anyway".
 */
export declare function createUnit(spec: IntakeSpec, formData: FormData, actor: Actor, db: Queryable, opts?: {
    confirmDuplicate?: boolean;
}): Promise<SaveResult>;
/**
 * Create MANY units for ONE customer in a single intake (the "one customer, multiple units at
 * once" flow). Resolves the customer + contact ONCE — picking existing rows or creating them
 * inline (resolveCustomerRef/resolveContactRef) — then injects that shared ref into each unit's
 * FormData and calls `createUnit` per unit, so the whole batch hangs off the same audited create
 * path (dedupe + validation + event) as a single create.
 *
 * v1 semantics (documented, matches the fcr-sales flow this is lifted from): SEQUENTIAL and
 * NOT wrapped in one transaction — the customer/contact are created first, then each unit; a
 * unit that fails validation/dedupe is reported in its `units[]` entry while the others proceed,
 * so partial success is possible. The caller inspects the per-unit results and can re-submit the
 * failed ones with `confirmDuplicate` (the customer/contact are already created — pass them as
 * `existingSfId`/`existingRef` on the retry so they aren't duplicated). Full batch atomicity +
 * a single pre-create dedupe pass are a hardening follow-up (needs a transaction-scoped Queryable).
 *
 * Caller must validate inputs first (≥1 unit; a new customer/contact has a non-empty name),
 * exactly as the app server action does today before writing.
 */
export declare function createUnits(spec: IntakeSpec, customer: CustomerInput, contact: ContactInput, units: FormData[], actor: Actor, db: Queryable, opts?: {
    confirmDuplicate?: boolean;
}): Promise<CreateUnitsResult>;
/**
 * Edit an existing unit. Reads the before-image, runs the engine + validation over the
 * effective state, and writes the row + audit event atomically with an optimistic-concurrency
 * guard (the before-image's updated_at), so a concurrent edit can't be silently lost.
 */
export declare function updateUnit(spec: IntakeSpec, id: string, formData: FormData, actor: Actor, db: Queryable): Promise<SaveResult>;
//# sourceMappingURL=pipeline.d.ts.map