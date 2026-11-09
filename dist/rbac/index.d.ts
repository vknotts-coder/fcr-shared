import type { CanOptions, Decision, Principal } from "../contracts/index.js";
/** The minimal query surface loadPrincipalGrants needs — structurally satisfied by a
 *  node-postgres `Pool` and by `@neondatabase/serverless`'s `Pool`. Kept as a local
 *  interface so this package depends on no DB driver. */
export interface Queryable {
    query<T = unknown>(text: string, params?: unknown[]): Promise<{
        rows: T[];
    }>;
}
/** A built, parameterized SQL statement — `eventInsert`'s output shape. */
export interface Statement {
    text: string;
    params: unknown[];
}
/** Optional atomic-batch seam for the intake engine's create-MULTIPLE flow. `transaction`
 *  runs the given statements as ONE all-or-nothing transaction (any failure rolls the whole
 *  batch back), so createUnits can create the shared customer/contact + N units atomically
 *  instead of the sequential, partial-success default. Driver-agnostic like `Queryable`: a
 *  consumer implements it with `@neondatabase/serverless`'s `neon(url).transaction([...])`
 *  (over HTTP — no WebSocket) or with node-postgres BEGIN/COMMIT on a single client. When no
 *  TxRunner is passed, createUnits keeps its sequential fallback. */
export interface TxRunner {
    transaction(statements: Statement[]): Promise<void>;
}
/**
 * Load a logged-in username's {@link Principal}: the account id and the full unioned
 * permission set across all the account's (non-deleted) assignments. Pure data access
 * over the injected `pool` — NO memoization (the caller adds that). An unknown/inactive
 * username → `{accountId: null, grants: []}`, i.e. default-deny everywhere.
 */
export declare function loadPrincipalGrants(pool: Queryable, username: string): Promise<Principal>;
/**
 * Load a principal by stable {@link fcr_core.account} **id** — the id-keyed twin of
 * {@link loadPrincipalGrants}, same grant union, only the WHERE differs. Use this where
 * the authz principal must survive a username change (e.g. a session that stores the
 * account id, so renaming the account does NOT detach its live authorization). An
 * unknown/inactive/deleted id → `{username: "", accountId: null, grants: []}`, i.e.
 * default-deny everywhere, exactly like the by-username miss. NO memoization (caller adds it).
 */
export declare function loadPrincipalGrantsById(pool: Queryable, accountId: string): Promise<Principal>;
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