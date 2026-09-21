import type { Queryable, Statement } from "../rbac/index.js";
import type { Actor, CustomerInput, ContactInput } from "./types.js";
/**
 * Find an existing, NOT-yet-synced customer with the same name to reuse instead of inserting a
 * duplicate (fcr-shared#22 companion). Scoped deliberately to `sf_id IS NULL` (a pending local
 * customer): it de-dupes a same-name re-entry from before reverse-sync ran, but NEVER silently
 * merges two distinct real Salesforce accounts that happen to share a name. Case-insensitive on
 * the trimmed name; most recent wins. Returns the customer's LOCAL UUID ref, or null.
 */
export declare function findUnsyncedCustomerByName(sfName: string, db: Queryable): Promise<string | null>;
/** Build the customer resolution: an existing ref unchanged (no statement), or a new
 *  fcr_core.customer row's LOCAL UUID + the built INSERT+event statement (not yet executed). */
export declare function buildCustomerInsert(input: CustomerInput, actor: Actor): Promise<{
    ref: string;
    statement?: Statement;
}>;
/** Build the contact resolution: an existing ref unchanged (no statement), or a new
 *  fcr_core.unit_contact row's LOCAL UUID + the built INSERT+event statement (linked to customerRef). */
export declare function buildContactInsert(input: ContactInput, customerRef: string, actor: Actor): Promise<{
    ref: string;
    statement?: Statement;
}>;
/**
 * Resolve the customer for an intake: return an existing customer's ref unchanged, or create a new
 * fcr_core.customer row (audited) and return its LOCAL UUID. Executes immediately (single-write /
 * sequential-fallback path); createUnits' transactional path uses buildCustomerInsert instead.
 */
export declare function resolveCustomerRef(input: CustomerInput, actor: Actor, db: Queryable): Promise<string>;
/**
 * Resolve the contact for an intake: return an existing contact's ref unchanged, or create a new
 * fcr_core.unit_contact row (audited) linked to `customerRef` and return its LOCAL UUID. Executes
 * immediately; createUnits' transactional path uses buildContactInsert instead.
 */
export declare function resolveContactRef(input: ContactInput, customerRef: string, actor: Actor, db: Queryable): Promise<string>;
//# sourceMappingURL=customer.d.ts.map