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

import type {
  CanOptions,
  Decision,
  Effect,
  GrantedPermission,
  Principal,
  Scope,
} from "../contracts/index.js";

/** The minimal query surface loadPrincipalGrants needs — structurally satisfied by a
 *  node-postgres `Pool` and by `@neondatabase/serverless`'s `Pool`. Kept as a local
 *  interface so this package depends on no DB driver. */
export interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
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

interface GrantRow {
  account_id: string;
  username: string | null; // selected by the by-id loader; unused by the by-username one
  resource_type: string | null;
  action: string | null;
  section: string | null;
  field: string | null;
  scope: Scope | null;
  effect: Effect | null;
  department_id: string | null;
  shop_id: string | null;
}

/** The permission-union join, identical for both loaders — only the WHERE differs. The
 *  per-app fcr_core SQL is centralized here by design (see the file header), so the two
 *  sibling loaders share this SELECT rather than drifting. */
const GRANT_JOIN = `
       FROM fcr_core.account a
       LEFT JOIN fcr_core.assignment      asg  ON asg.account_id = a.id      AND asg.deleted_at  IS NULL
       LEFT JOIN fcr_core.assignment_role ar   ON ar.assignment_id = asg.id
       LEFT JOIN fcr_core.role            r    ON r.id = ar.role_id          AND r.deleted_at    IS NULL
       LEFT JOIN fcr_core.permission      p    ON p.role_id = r.id           AND p.deleted_at    IS NULL
       LEFT JOIN fcr_core.department      dept ON dept.id = asg.department_id AND dept.deleted_at IS NULL`;

const GRANT_COLS = `a.id AS account_id, a.username,
            p.resource_type, p.action, p.section, p.field, p.scope, p.effect,
            asg.department_id, dept.shop_id`;

/** Map the LEFT-JOIN rows to the camelCase grant list. A row with no matched permission
 *  has ALL permission columns NULL; a matched one has them all present (permission.
 *  resource_type/action/scope/effect are NOT NULL), so testing one column is sufficient
 *  to drop the grant-less rows. Pure — shared by both loaders. */
function mapGrants(rows: GrantRow[]): GrantedPermission[] {
  return rows
    .filter((r) => r.resource_type !== null)
    .map((r) => ({
      roleId: "", // not needed for evaluation; omit the join to role.id
      resourceType: r.resource_type as string,
      action: r.action as string,
      section: r.section,
      field: r.field,
      scope: r.scope as Scope,
      effect: r.effect as Effect,
      departmentId: r.department_id,
      shopId: r.shop_id,
    }));
}

/**
 * Load a logged-in username's {@link Principal}: the account id and the full unioned
 * permission set across all the account's (non-deleted) assignments. Pure data access
 * over the injected `pool` — NO memoization (the caller adds that). An unknown/inactive
 * username → `{accountId: null, grants: []}`, i.e. default-deny everywhere.
 */
export async function loadPrincipalGrants(
  pool: Queryable,
  username: string,
): Promise<Principal> {
  const { rows } = await pool.query<GrantRow>(
    `SELECT ${GRANT_COLS}${GRANT_JOIN}
      WHERE lower(a.username) = lower($1) AND a.deleted_at IS NULL AND a.active = TRUE`,
    // Case-INSENSITIVE match, backed by a lower(username) functional unique index.
    [username],
  );

  const first = rows[0];
  if (!first) return { username, accountId: null, grants: [] };
  // Echo the CALLER's username (unchanged behavior), not the stored casing.
  return { username, accountId: first.account_id, grants: mapGrants(rows) };
}

/**
 * Load a principal by stable {@link fcr_core.account} **id** — the id-keyed twin of
 * {@link loadPrincipalGrants}, same grant union, only the WHERE differs. Use this where
 * the authz principal must survive a username change (e.g. a session that stores the
 * account id, so renaming the account does NOT detach its live authorization). An
 * unknown/inactive/deleted/**malformed** id → `{username: "", accountId: null, grants: []}`,
 * i.e. default-deny everywhere, exactly like the by-username miss — a non-UUID id
 * short-circuits WITHOUT a query (it cannot match a uuid column). NO memoization (caller adds it).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadPrincipalGrantsById(
  pool: Queryable,
  accountId: string,
): Promise<Principal> {
  // Fail CLOSED on a malformed id without touching the DB. account.id is uuid, so the
  // query below binds `$1::uuid`; a non-UUID value (a stale/tampered/legacy session
  // cookie, a pre-migration id, cookie garbage) would make Postgres reject the bind
  // (SQLSTATE 22P02) and this function THROW — contradicting the documented default-deny.
  // Short-circuit to the same default-deny the DB miss returns, so the contract holds for
  // EVERY caller, not only those that wrap the call in try/catch.
  if (!UUID_RE.test(accountId)) return { username: "", accountId: null, grants: [] };

  const { rows } = await pool.query<GrantRow>(
    `SELECT ${GRANT_COLS}${GRANT_JOIN}
      WHERE a.id = $1::uuid AND a.deleted_at IS NULL AND a.active = TRUE`,
    [accountId],
  );

  const first = rows[0];
  if (!first) return { username: "", accountId: null, grants: [] };
  // Carry the STORED username (the id is authoritative; the name may have just changed).
  return { username: first.username ?? "", accountId: first.account_id, grants: mapGrants(rows) };
}

function scopeSatisfied(g: GrantedPermission, opts: CanOptions, principal: Principal): boolean {
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
export function can(
  principal: Principal,
  action: string,
  resourceType: string,
  opts: CanOptions = {},
): Decision {
  const wantSection = opts.section ?? null;
  const wantField = opts.field ?? null;

  const matches = principal.grants.filter(
    (g) =>
      (g.resourceType === resourceType || g.resourceType === "*") &&
      (g.action === action || g.action === "*") &&
      (g.section === null || g.section === wantSection) &&
      (g.field === null || g.field === wantField) &&
      scopeSatisfied(g, opts, principal),
  );

  if (matches.some((g) => g.effect === "deny")) return { allowed: false, reason: "deny-wins" };
  if (matches.some((g) => g.effect === "allow")) return { allowed: true, reason: "allow" };
  return { allowed: false, reason: "default-deny" };
}
