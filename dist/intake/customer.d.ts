import type { Queryable } from "../rbac/index.js";
import type { Actor, CustomerInput, ContactInput } from "./types.js";
/**
 * Resolve the customer for an intake: return an existing customer's Salesforce id unchanged, or
 * create a new fcr_core.customer row (audited) and return its LOCAL UUID (reverse-sync resolves it
 * to the SF Id later — see the file header). Caller must ensure a new customer's `sfName` is present.
 */
export declare function resolveCustomerRef(input: CustomerInput, actor: Actor, db: Queryable): Promise<string>;
/**
 * Resolve the contact for an intake: return an existing contact's ref (sf_id or UUID) unchanged, or
 * create a new fcr_core.unit_contact row (audited) linked to `customerRef` (the just-resolved
 * customer's sf_id or local UUID) and return its LOCAL UUID. Caller must ensure a new contact's
 * `sfName` is present.
 */
export declare function resolveContactRef(input: ContactInput, customerRef: string, actor: Actor, db: Queryable): Promise<string>;
//# sourceMappingURL=customer.d.ts.map