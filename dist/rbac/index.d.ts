import type { CanOptions, Decision, Principal } from "../contracts/index.js";
/** The minimal query surface loadPrincipalGrants needs — structurally satisfied by a
 *  node-postgres `Pool` and by `@neondatabase/serverless`'s `Pool`. Kept as a local
 *  interface so this package depends on no DB driver. */
export interface Queryable {
    query<T = unknown>(text: string, params?: unknown[]): Promise<{
        rows: T[];
    }>;
}
/**
 * Load a logged-in username's {@link Principal}: the account id and the full unioned
 * permission set across all the account's (non-deleted) assignments. Pure data access
 * over the injected `pool` — NO memoization (the caller adds that). An unknown/inactive
 * username → `{accountId: null, grants: []}`, i.e. default-deny everywhere.
 */
export declare function loadPrincipalGrants(pool: Queryable, username: string): Promise<Principal>;
/**
 * Decide whether `principal` may `action` on `resourceType`. Pure + synchronous over
 * the principal's already-loaded grants. Pass `opts.section`/`opts.field` to check a
 * narrower target, and `opts.resource` for a scoped (department/shop/self) check.
 *
 * DENY-WINS: any matching deny loses the whole check. DEFAULT-DENY: no matching allow
 * ⇒ denied. A grant with `section`/`field` NULL covers the whole resource (so it also
 * satisfies a section/field-specific check); a section/field-specific grant does NOT
 * satisfy a broader whole-resource check.
 */
export declare function can(principal: Principal, action: string, resourceType: string, opts?: CanOptions): Decision;
//# sourceMappingURL=index.d.ts.map