// @fcr/core/auth — the shared OFFICE-staff credential path (Module 1, auth half; epic fcr-dispatch#366).
//
// Today every app authenticates office staff against a hardcoded plaintext list in its own
// src/lib/users.ts (DEFAULT_USERS) — 9 drifted copies, weak shared passwords, nothing to reset. This module
// is the one place the office password path lives, backed by fcr_core.account (the unified identity row that
// already holds driver/kiosk PIN creds) + fcr_core.app_access (per-app grant). Each app calls
// authenticateOffice() behind its own AUTH_STORE_LIVE flag, falling back to the hardcoded list until cutover.
//
// SCOPE BOUNDARY (deliberate): this module owns ONLY the office password path + the scrypt primitives. The
// driver-PIN path (fcr_core.driver_account) and the kiosk/device logins stay in each app for now — the
// "merge the 19 driver accounts into the user table?" question is an open SCOPE §1.4 arrow (Robert's).
//
// Mirrors @fcr/core/rbac's design: an INJECTED Queryable pool (no DB-driver dependency), case-INSENSITIVE
// username (lower(username) functional unique index), fail-closed. scrypt is the same primitive the driver
// PIN path already uses, so the fleet keeps one hash scheme.

import { scrypt as _scrypt, scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Queryable lives in one place (rbac) — re-export it so auth's consumers still import it from here, but there
// is a single definition to keep in step (a second copy drifts). Type-only: erased at build, no runtime coupling.
export type { Queryable } from "../rbac/index.js";
import type { Queryable } from "../rbac/index.js";

// Async scrypt over the libuv threadpool — NEVER the sync form. This is the one shared office-login path for
// all 9 FCR apps; a synchronous scrypt (~tens of ms) would block the Node event loop on every attempt and
// serialize concurrent logins / wrong-password bursts into a self-inflicted DoS.
const scrypt = promisify(_scrypt);

// ── password policy (Van, 2026-10-28: 10 / 72h / 10) ─────────────────────────────────
export const PASSWORD_MIN_LENGTH = 10;
/** An admin-set temporary password (must_change) is only valid for this long after it was set. */
export const TEMP_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
/** Lock the account after this many consecutive failed logins. */
export const LOCKOUT_THRESHOLD = 10;
/** How long a lockout lasts once the threshold is hit (duration unspecified in policy — 15 min default). */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const SCRYPT_KEYLEN = 64;

// Fixed decoy credential for the no-row path: verifying against it spends the same ~scrypt time as a real
// user, so an unknown username is NOT distinguishable by response latency from a known one (the enumeration
// oracle the "do NOT leak existence" comment promises to avoid). Computed once at load.
const DECOY_SALT = "0".repeat(32);
// scryptSync here is a deliberate one-time module-load cost (not a per-request call), so it never touches the
// hot path the async-scrypt fix protects.
const DECOY_HASH = scryptSync("decoy", DECOY_SALT, SCRYPT_KEYLEN).toString("hex");

export interface PasswordHash {
  hash: string; // hex scrypt digest
  salt: string; // hex random salt
  algo: "scrypt";
}

/** Hash a plaintext password with a fresh random salt. Use when an admin sets a temp password or a user
 *  changes their own. Validation (length) is the caller's job — see passwordMeetsPolicy. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString("hex");
  const hash = ((await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer).toString("hex");
  return { hash, salt, algo: "scrypt" };
}

/** Constant-time scrypt verify. Returns false (never throws) on any missing/garbled stored credential, so a
 *  credential-less row (PIN/kiosk account, or office row not yet provisioned) simply fails to authenticate.
 *  Buffer.from(…, "hex") truncates bad input rather than throwing, so the length guard — not a try/catch — is
 *  what rejects a garbled hash. */
export async function verifyPassword(password: string, salt: string | null, hash: string | null): Promise<boolean> {
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const computed = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return timingSafeEqual(computed, expected);
}

/** True when a plaintext password meets policy. Caller gates set/change on this (not authenticate — an
 *  existing weaker password still logs in; policy applies to NEW passwords). */
export function passwordMeetsPolicy(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH;
}

export interface OfficeUser {
  username: string;
  name: string;
  /** Office logins are always "staff" role (kiosk/driver are separate paths, not this module). */
  role: "staff";
  /** Admin-set temp password → the caller must route to the change-password screen before granting access. */
  mustChange: boolean;
}

export type AuthFailure =
  | "invalid" // no such office account, or wrong password
  | "locked" // too many failed attempts; locked_until in the future
  | "temp_expired" // must_change password older than the 72h TTL — admin must re-issue
  | "no_app_access"; // valid credential, but not granted access to THIS app

export type OfficeAuthResult = { ok: true; user: OfficeUser } | { ok: false; reason: AuthFailure };

// ── login-history / security auditing (epic fcr-dispatch#408) ─────────────────
// A durable record of each authentication outcome, written to fcr_core.auth_event —
// a DEDICATED table (NOT event_log, which is resource-centric change-audit with a
// 200-row read cap). App-owned, no sf_id, NEVER a sync target → no DISPATCH_PUSH_LIVE
// exposure. The emit lives HERE (the one office-auth chokepoint) so it covers every
// app as it flips AUTH_STORE_LIVE; pre-cutover legacy (users.ts) logins are captured
// by the per-app wrapper instrument (S2), driver-PIN/kiosk at their own verify points.

/** The outcome kinds auth_event records. authenticateOffice emits the first five; the
 *  rest are written by their own call sites — `throttled` by the login route when
 *  checkLoginThrottle blocks an attempt BEFORE authenticateOffice runs (so the audit
 *  isn't blind during an active brute-force), the others by logout / password flows. */
export type AuthEventType =
  | "login" // successful office login
  | "login_failed" // bad credential / unknown username
  | "locked" // attempt while locked_until is in the future
  | "temp_expired" // correct temp password past its 72h TTL
  | "no_app_access" // valid credential, no grant for THIS app
  | "throttled" // per-source rate-limit blocked the attempt before the credential check
  | "logout"
  | "password_changed"
  | "temp_set";

/** Request context the login ACTION has (the verify fn does not) — the trusted client
 *  IP (same proxy-verified source the throttle uses) and user-agent. Optional: an app
 *  that has not wired it yet records the event with null ip/ua rather than nothing. */
export interface AuthEventContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthEvent {
  accountId?: string | null; // resolved account.id, or null for an unknown-username attempt
  username: string; // the username attempted (lower-compared downstream)
  appKey: string;
  event: AuthEventType;
  authPath?: "office" | "pin" | "kiosk"; // defaults to "office"
  reason?: string | null; // typed enum only — NEVER credential material
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Write one authentication event. AWAITED (one DB round-trip per outcome) but
 * error-SWALLOWED: auditing is best-effort and login is critical-path, so an audit-write
 * failure can never block or fail a login. (This is the module's ONLY swallowed write —
 * the failed_attempts/lockout counters deliberately propagate, fail-closed; the swallow
 * here is justified by audit being best-effort, not by any counter-write precedent.)
 *
 * Observability: the deploy-before-migration window (undefined_table `42P01`) is EXPECTED
 * and swallowed silently; ANY OTHER error is durable drift (a missing column, an enum/
 * CHECK rejection, an overflow) that would otherwise silently disable auditing fleet-wide,
 * so it is logged (credential-free — event kind + SQLSTATE only, never the payload) to
 * surface it, while STILL not failing the login.
 *
 * ⚠ NEVER pass a password or any credential material — `reason` is the typed enum only,
 * and callers must keep `metadata` credential-free.
 */
export async function recordAuthEvent(pool: Queryable, evt: AuthEvent): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO fcr_core.auth_event
         (account_id, username, app_key, event, auth_path, reason, ip, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        evt.accountId ?? null,
        evt.username,
        evt.appKey,
        evt.event,
        evt.authPath ?? "office",
        evt.reason ?? null,
        evt.ip ?? null,
        evt.userAgent ?? null,
        evt.metadata ? JSON.stringify(evt.metadata) : null,
      ],
    );
  } catch (err) {
    // Never surface to the login flow. 42P01 (undefined_table) is the expected pre-migration
    // window → stay silent. Anything else is durable drift that would silently drop audit
    // rows, so log it — credential-free: event kind + SQLSTATE only, never the payload.
    const code = (err as { code?: string } | null)?.code;
    if (code !== "42P01") {
      console.error(
        `[auth_event] durable audit-write failure (event=${evt.event}, code=${code ?? "unknown"}) — login auditing may be dropping rows`,
      );
    }
  }
}

interface AccountRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string | null;
  password_salt: string | null;
  password_set_at: string | null; // ::text (neon hydrates timestamptz → JS Date otherwise; we compare in ms)
  must_change: boolean;
  failed_attempts: number;
  locked_until: string | null; // ::text
}

/**
 * Authenticate an OFFICE user against the shared store for a specific app.
 *
 * Flow (fail-closed): resolve the active, non-deleted `office` account by case-insensitive username — on no
 * row, spend a decoy verify (so an unknown username is not a timing oracle) and return "invalid" → if locked
 * (locked_until in the future) return "locked" → verify the scrypt password; on miss, atomically increment
 * failed_attempts (and set locked_until once the threshold is hit, computed SQL-side so concurrent misses
 * can't lose the update) and return "invalid" → the password is now proven, so clear any stale counter/lock →
 * on a temp (must_change) password past its 72h TTL return "temp_expired" → confirm an active app_access grant
 * for `appKey`, else "no_app_access" → return the user (carrying mustChange so the caller forces a change).
 *
 * ⚠ Per-account lockout here has no per-source/IP dimension or backoff, so it is also a targeted DoS vector
 * against a known username (10 wrong guesses → 15-min lock). Accepted interim tradeoff; S6 adds per-source
 * rate-limiting / exponential backoff / admin unlock (epic #366).
 *
 * Writes failed_attempts/locked_until on the injected pool — app-owned columns, no SF exposure.
 */
export async function authenticateOffice(
  pool: Queryable,
  args: { username: string; password: string; appKey: string; context?: AuthEventContext },
): Promise<OfficeAuthResult> {
  const username = args.username.trim();
  // One audit event per outcome (epic #408). Awaited but error-swallowed inside
  // recordAuthEvent — adds one DB round-trip per outcome but can never change or fail
  // the login.
  const emit = (event: AuthEventType, accountId: string | null, reason: string | null) =>
    recordAuthEvent(pool, {
      accountId, username, appKey: args.appKey, event, reason,
      authPath: "office", ip: args.context?.ip, userAgent: args.context?.userAgent,
    });
  const { rows } = await pool.query<AccountRow>(
    `SELECT id, username, display_name, password_hash, password_salt,
            password_set_at::text AS password_set_at, must_change, failed_attempts,
            locked_until::text AS locked_until
       FROM fcr_core.account
      WHERE lower(username) = lower($1) AND kind = 'office'
        AND active = TRUE AND deleted_at IS NULL`,
    [username],
  );
  const acct = rows[0];
  // Default-deny: unknown username is "invalid" (do NOT leak existence). Spend a decoy verify so the no-row
  // path takes ~the same time as a real one, then emit the audit event (account_id null) and return — the
  // decoy verify + emit are the only work, no account mutation.
  if (!acct) {
    await verifyPassword(args.password, DECOY_SALT, DECOY_HASH);
    await emit("login_failed", null, "invalid");
    return { ok: false, reason: "invalid" };
  }

  const now = Date.now();
  if (acct.locked_until && Date.parse(acct.locked_until) > now) {
    await emit("locked", acct.id, "locked");
    return { ok: false, reason: "locked" };
  }

  if (!(await verifyPassword(args.password, acct.password_salt, acct.password_hash))) {
    // Atomic SQL increment + threshold lock in ONE statement — the counter advances from the DB's current
    // value, not a stale SELECT, so N concurrent wrong-password requests advance it by N (not a lost update
    // that leaves the lockout unarmed).
    await pool.query(
      `UPDATE fcr_core.account
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= $2
                                  THEN now() + ($3 || ' milliseconds')::interval
                                  ELSE locked_until END,
              updated_at = now()
        WHERE id = $1`,
      [acct.id, LOCKOUT_THRESHOLD, String(LOCKOUT_DURATION_MS)],
    );
    await emit("login_failed", acct.id, "invalid");
    return { ok: false, reason: "invalid" };
  }

  // Password is correct → clear any stale failed-attempt counter / lock NOW, before the remaining gates. A
  // user who proves the password but is then gated by temp-expiry or no-grant must not keep a primed counter
  // (which a single later wrong attempt would immediately re-lock).
  if (acct.failed_attempts !== 0 || acct.locked_until) {
    await pool.query(
      `UPDATE fcr_core.account SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [acct.id],
    );
  }

  // A temp (must_change) password expires 72h after it was set.
  if (acct.must_change && acct.password_set_at && now - Date.parse(acct.password_set_at) > TEMP_PASSWORD_TTL_MS) {
    await emit("temp_expired", acct.id, "temp_expired");
    return { ok: false, reason: "temp_expired" };
  }

  // The per-app gate: one active grant for THIS app, else no access.
  const access = await pool.query<{ one: number }>(
    `SELECT 1 AS one FROM fcr_core.app_access
      WHERE account_id = $1 AND lower(app_key) = lower($2) AND active = TRUE AND deleted_at IS NULL
      LIMIT 1`,
    [acct.id, args.appKey],
  );
  if (access.rows.length === 0) {
    await emit("no_app_access", acct.id, "no_app_access");
    return { ok: false, reason: "no_app_access" };
  }

  await emit("login", acct.id, null);
  return {
    ok: true,
    user: {
      username: acct.username,
      name: acct.display_name ?? acct.username,
      role: "staff",
      mustChange: acct.must_change,
    },
  };
}

// ── login SOURCE throttle (epic fcr-dispatch#366 S6) ─────────────────────────
// Per-source rate-limiting + exponential backoff — the dimension the per-account
// lockout above lacks. Backed by fcr_core.auth_throttle (created by the consuming
// app's migration). The login ACTION (which has the request headers) reads the
// source IP and calls these; authenticateOffice itself has no request context.
//
// Two scopes, both checked on every attempt:
//   • "pair" — key = lower(username)+"|"+ip. SURGICAL: one user fumbling their own
//     password on a shared office NAT does NOT throttle colleagues behind that IP.
//   • "ip"   — key = ip. A higher CEILING catching username-SPRAY from one source
//     (many usernames, each with too few pair-failures to trip the pair backoff).
// Counters DECAY: a failure after THROTTLE_WINDOW_MS of quiet resets the counter to
// 1, so a slow trickle never accumulates a lock. Backoff + the window reset are
// computed SQL-side in one statement, so concurrent misses can't lose an update
// (same discipline as authenticateOffice's atomic lockout). All columns app-owned,
// no SF exposure. These constants are tunable security params (Van, 2026-11-06).
//
// ⚠ TRUSTED IP REQUIRED — the caller MUST pass a proxy-VERIFIED client IP (on Vercel:
// the platform-set `x-vercel-forwarded-for`, or `ipAddress(request)` from
// @vercel/functions / `request.ip`), NEVER a raw client-settable `X-Forwarded-For`/
// `X-Real-Ip`. With a spoofable ip, every request lands in a unique bucket, `failed`
// never climbs, and BOTH scopes become a silent no-op — total bypass. This is a HARD
// contract on every consumer's login action (#366 S6 review).

export const PAIR_FAIL_THRESHOLD = 5; // pair backoff begins after this many fails
// Raised 20 → 50 (#366 S6 review): an FCR office shares one NAT public IP, so the ip
// ceiling must sit well ABOVE plausible concurrent legit fumbling or it becomes an
// office-wide self-DoS. 50 fails inside the 1 h window from one source is spray, not
// a few people mistyping; a successful login also relieves the ip counter (see
// clearLoginThrottle). Still catches username-spray (per-account lockout handles
// per-username brute force; this is the cross-username ceiling).
export const IP_FAIL_THRESHOLD = 50; // ip ceiling begins after this many fails (across usernames)
export const THROTTLE_BACKOFF_BASE_MS = 15_000; // first backoff step (×2 each step past the threshold)
export const THROTTLE_BACKOFF_CAP_MS = 15 * 60_000; // max backoff (15 min)
export const THROTTLE_WINDOW_MS = 60 * 60_000; // quiet period that resets a counter (1 h)

export interface ThrottleResult {
  allowed: boolean;
  /** When !allowed, how long until the soonest lock (pair or ip) expires. */
  retryAfterMs: number;
}

function pairKey(ip: string, username: string): string {
  return `${username.trim().toLowerCase()}|${ip}`;
}

/**
 * May this (ip, username) attempt a login right now? Reads BOTH scopes; blocked if
 * EITHER is locked, returning the longest remaining lock. Pure read, no write. An
 * empty/unknown ip collapses to the "" bucket, so a missing X-Forwarded-For can't
 * silently bypass the ip ceiling. Call BEFORE verifying the password.
 */
export async function checkLoginThrottle(
  pool: Queryable,
  args: { ip: string; username: string },
): Promise<ThrottleResult> {
  const ip = args.ip || "";
  const { rows } = await pool.query<{ ms: string | number | null }>(
    `SELECT COALESCE(MAX(EXTRACT(epoch FROM (locked_until - now())) * 1000), 0) AS ms
       FROM fcr_core.auth_throttle
      WHERE locked_until IS NOT NULL AND locked_until > now()
        AND ((scope = 'pair' AND key = $1) OR (scope = 'ip' AND key = $2))`,
    [pairKey(ip, args.username), ip],
  );
  const ms = Number(rows[0]?.ms ?? 0);
  return ms > 0 ? { allowed: false, retryAfterMs: ms } : { allowed: true, retryAfterMs: 0 };
}

// Atomic failure-bump for one scope/key: increment (or reset after the quiet window)
// and set the exponential-backoff lock once the count reaches the threshold — all in
// ONE statement so N concurrent misses advance the counter by N. In ON CONFLICT DO
// UPDATE the existing row is referenced by the unqualified relation name.
//
// ⚠ The "next count" expression (`CASE WHEN window-elapsed THEN 1 ELSE failed+1 END`)
// appears THREE times below — once for `failed`, twice inside `locked_until`. Postgres
// can't reference one SET target's new value from another in ON CONFLICT DO UPDATE, so
// they can't be deduped; if the decay rule changes, edit all three in lockstep.
// The backoff EXPONENT is clamped (LEAST(…, 30)) — NOT just the result — so `power(2,…)`
// can't overflow float8 on a long-attacked key (2^30 × base already dwarfs the cap).
async function bumpThrottle(pool: Queryable, scope: "pair" | "ip", key: string, threshold: number): Promise<void> {
  await pool.query(
    `INSERT INTO fcr_core.auth_throttle (scope, key, failed, first_at, last_at, locked_until)
     VALUES ($1, $2, 1, now(), now(), NULL)
     ON CONFLICT (scope, key) DO UPDATE SET
       failed = CASE WHEN now() - auth_throttle.last_at > ($6 || ' milliseconds')::interval
                     THEN 1 ELSE auth_throttle.failed + 1 END,
       last_at = now(),
       locked_until = CASE
         WHEN (CASE WHEN now() - auth_throttle.last_at > ($6 || ' milliseconds')::interval
                    THEN 1 ELSE auth_throttle.failed + 1 END) >= $3
         THEN now() + (LEAST($5::float8,
                $4::float8 * power(2, LEAST((CASE WHEN now() - auth_throttle.last_at > ($6 || ' milliseconds')::interval
                                            THEN 1 ELSE auth_throttle.failed + 1 END) - $3, 30))) || ' milliseconds')::interval
         ELSE NULL END`,
    [scope, key, threshold, THROTTLE_BACKOFF_BASE_MS, THROTTLE_BACKOFF_CAP_MS, THROTTLE_WINDOW_MS],
  );
}

/**
 * Record a failed login against BOTH scopes, applying exponential backoff once each
 * passes its threshold. Call on an auth MISS (wrong password / invalid). Fire it even
 * when the password was wrong for an unknown username, so spray is counted.
 */
export async function recordLoginFailure(pool: Queryable, args: { ip: string; username: string }): Promise<void> {
  const ip = args.ip || "";
  await bumpThrottle(pool, "pair", pairKey(ip, args.username), PAIR_FAIL_THRESHOLD);
  await bumpThrottle(pool, "ip", ip, IP_FAIL_THRESHOLD);
}

/**
 * Relieve throttle state after a SUCCESSFUL login. The (ip, username) PAIR is cleared
 * outright — the user proved themselves. The ip-scope counter is DECREMENTED by one
 * (floor 0), and its lock lifted once it drops below the ceiling, so steady legitimate
 * office traffic keeps a shared NAT's ip counter low (the self-DoS fix, #366 S6 review)
 * WITHOUT a single lucky guess wiping all spray evidence — a burst of failures with no
 * successes still climbs to the ceiling.
 */
export async function clearLoginThrottle(pool: Queryable, args: { ip: string; username: string }): Promise<void> {
  const ip = args.ip || "";
  await pool.query(
    `DELETE FROM fcr_core.auth_throttle WHERE scope = 'pair' AND key = $1`,
    [pairKey(ip, args.username)],
  );
  await pool.query(
    `UPDATE fcr_core.auth_throttle
        SET failed = GREATEST(0, failed - 1),
            locked_until = CASE WHEN GREATEST(0, failed - 1) < $2 THEN NULL ELSE locked_until END,
            last_at = now()
      WHERE scope = 'ip' AND key = $1`,
    [ip, IP_FAIL_THRESHOLD],
  );
}
