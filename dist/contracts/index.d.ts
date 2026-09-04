/** Where a grant applies. `all` = platform-wide; the others narrow by the resource's
 *  context vs the assignment that granted the permission (department/shop) or the
 *  principal (self). */
export type Scope = "all" | "shop" | "department" | "self";
/** allow beats nothing; deny beats allow (deny-wins). */
export type Effect = "allow" | "deny";
/** A row of the policy matrix (fcr_core.permission), camelCase. `resourceType`/`action`
 *  may be the wildcard "*". `section`/`field` NULL = applies to the whole resource. */
export interface PermissionRow {
    roleId: string;
    resourceType: string;
    action: string;
    section: string | null;
    field: string | null;
    scope: Scope;
    effect: Effect;
}
/** A permission as loaded for evaluation: the matrix row PLUS the context of the
 *  assignment that granted it (used to evaluate `department`/`shop` scope). Both are
 *  NULL for a platform-wide assignment. */
export interface GrantedPermission extends PermissionRow {
    /** department_id of the granting assignment (NULL = platform-wide). */
    departmentId: string | null;
    /** shop_id of the granting assignment's department (NULL = none/spanning). */
    shopId: string | null;
}
/** The resolved actor: identity + the effective (unioned) permission set, loaded once
 *  per request. Carrying the grants makes can() a pure synchronous function. */
export interface Principal {
    username: string;
    /** fcr_core.account.id, or null when the logged-in username has no account row yet
     *  (→ default-deny everywhere). */
    accountId: string | null;
    grants: GrantedPermission[];
}
/** The resource a check is about, for scope evaluation. Omit for a scope-`all` check. */
export interface ResourceContext {
    shopId?: string | null;
    departmentId?: string | null;
    /** the account.id that "owns" the resource, for scope=self. */
    ownerAccountId?: string | null;
}
/** Options to a can() check. */
export interface CanOptions {
    section?: string;
    field?: string;
    resource?: ResourceContext;
}
/** The outcome of a check. `reason` is for logging/debugging, never for control flow. */
export interface Decision {
    allowed: boolean;
    reason: string;
}
//# sourceMappingURL=index.d.ts.map