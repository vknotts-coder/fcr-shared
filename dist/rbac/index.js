// @fcr/core/rbac — the RBAC decision engine (Module 1), lifted from fcr-dispatch
// src/lib/rbac/can.ts. Two parts, by design:
//
//   • can(principal, action, resourceType, opts) — PURE, synchronous, ZERO I/O.
//     Depends only on the contracts types. Portable to every app unchanged.
//   • loadPrincipalGrants(pool, username) — the DB seam. Its fcr_core SQL is identical
//     across every app, so it lives here, but takes an INJECTED pool (any node-postgres
//     / @neondatabase/serverless-compatible `{ query }`), so this package needs no DB
//     driver dependency. Each app keeps its own pool() and wraps this in whatever
//     per-request memoization it uses (e.g. React cache()) — see fcr-dispatch's
//     resolvePrincipal shim.
//
// Semantics: DENY-WINS, DEFAULT-DENY. A grant matches when resourceType/action match
// (or the grant is the "*" wildcard), the grant's section/field are NULL (whole-
// resource) or equal the checked ones, and the grant's scope is satisfied by the
// resource context. v1 policy is section-level: all seeded permissions have field NULL.
/**
 * Load a logged-in username's {@link Principal}: the account id and the full unioned
 * permission set across all the account's (non-deleted) assignments. Pure data access
 * over the injected `pool` — NO memoization (the caller adds that). An unknown/inactive
 * username → `{accountId: null, grants: []}`, i.e. default-deny everywhere.
 */
export async function loadPrincipalGrants(pool, username) {
    const { rows } = await pool.query(`SELECT a.id AS account_id,
            p.resource_type, p.action, p.section, p.field, p.scope, p.effect,
            asg.department_id, dept.shop_id
       FROM fcr_core.account a
       LEFT JOIN fcr_core.assignment      asg  ON asg.account_id = a.id      AND asg.deleted_at  IS NULL
       LEFT JOIN fcr_core.assignment_role ar   ON ar.assignment_id = asg.id
       LEFT JOIN fcr_core.role            r    ON r.id = ar.role_id          AND r.deleted_at    IS NULL
       LEFT JOIN fcr_core.permission      p    ON p.role_id = r.id           AND p.deleted_at    IS NULL
       LEFT JOIN fcr_core.department      dept ON dept.id = asg.department_id AND dept.deleted_at IS NULL
      WHERE lower(a.username) = lower($1) AND a.deleted_at IS NULL AND a.active = TRUE`, 
    // Case-INSENSITIVE match, backed by a lower(username) functional unique index.
    [username]);
    const first = rows[0];
    if (!first)
        return { username, accountId: null, grants: [] };
    const accountId = first.account_id;
    const grants = rows
        // A LEFT-JOIN row with no matched permission has ALL permission columns NULL; a
        // matched one has them all present (permission.resource_type/action/scope/effect
        // are NOT NULL), so testing one column is sufficient to drop the grant-less rows.
        .filter((r) => r.resource_type !== null)
        .map((r) => ({
        roleId: "", // not needed for evaluation; omit the join to role.id
        resourceType: r.resource_type,
        action: r.action,
        section: r.section,
        field: r.field,
        scope: r.scope,
        effect: r.effect,
        departmentId: r.department_id,
        shopId: r.shop_id,
    }));
    return { username, accountId, grants };
}
function scopeSatisfied(g, opts, principal) {
    const res = opts.resource;
    switch (g.scope) {
        case "all":
            return true;
        case "department":
            return res?.departmentId != null && g.departmentId != null && res.departmentId === g.departmentId;
        case "shop":
            return res?.shopId != null && g.shopId != null && res.shopId === g.shopId;
        case "self":
            return res?.ownerAccountId != null && principal.accountId != null && res.ownerAccountId === principal.accountId;
        default:
            return false;
    }
}
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
export function can(principal, action, resourceType, opts = {}) {
    const wantSection = opts.section ?? null;
    const wantField = opts.field ?? null;
    const matches = principal.grants.filter((g) => (g.resourceType === resourceType || g.resourceType === "*") &&
        (g.action === action || g.action === "*") &&
        (g.section === null || g.section === wantSection) &&
        (g.field === null || g.field === wantField) &&
        scopeSatisfied(g, opts, principal));
    if (matches.some((g) => g.effect === "deny"))
        return { allowed: false, reason: "deny-wins" };
    if (matches.some((g) => g.effect === "allow"))
        return { allowed: true, reason: "allow" };
    return { allowed: false, reason: "default-deny" };
}
