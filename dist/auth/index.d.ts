export type { Queryable } from "../rbac/index.js";
import type { Queryable } from "../rbac/index.js";
export declare const PASSWORD_MIN_LENGTH = 10;
/** An admin-set temporary password (must_change) is only valid for this long after it was set. */
export declare const TEMP_PASSWORD_TTL_MS: number;
/** Lock the account after this many consecutive failed logins. */
export declare const LOCKOUT_THRESHOLD = 10;
/** How long a lockout lasts once the threshold is hit (duration unspecified in policy — 15 min default). */
export declare const LOCKOUT_DURATION_MS: number;
export interface PasswordHash {
    hash: string;
    salt: string;
    algo: "scrypt";
}
/** Hash a plaintext password with a fresh random salt. Use when an admin sets a temp password or a user
 *  changes their own. Validation (length) is the caller's job — see passwordMeetsPolicy. */
export declare function hashPassword(password: string): Promise<PasswordHash>;
/** Constant-time scrypt verify. Returns false (never throws) on any missing/garbled stored credential, so a
 *  credential-less row (PIN/kiosk account, or office row not yet provisioned) simply fails to authenticate.
 *  Buffer.from(…, "hex") truncates bad input rather than throwing, so the length guard — not a try/catch — is
 *  what rejects a garbled hash. */
export declare function verifyPassword(password: string, salt: string | null, hash: string | null): Promise<boolean>;
/** True when a plaintext password meets policy. Caller gates set/change on this (not authenticate — an
 *  existing weaker password still logs in; policy applies to NEW passwords). */
export declare function passwordMeetsPolicy(password: string): boolean;
export interface OfficeUser {
    username: string;
    name: string;
    /** Office logins are always "staff" role (kiosk/driver are separate paths, not this module). */
    role: "staff";
    /** Admin-set temp password → the caller must route to the change-password screen before granting access. */
    mustChange: boolean;
}
export type AuthFailure = "invalid" | "locked" | "temp_expired" | "no_app_access";
export type OfficeAuthResult = {
    ok: true;
    user: OfficeUser;
} | {
    ok: false;
    reason: AuthFailure;
};
/** The outcome kinds auth_event records. authenticateOffice emits the first five; the
 *  rest are written by their own call sites — `throttled` by the login route when
 *  checkLoginThrottle blocks an attempt BEFORE authenticateOffice runs (so the audit
 *  isn't blind during an active brute-force), the others by logout / password flows. */
export type AuthEventType = "login" | "login_failed" | "locked" | "temp_expired" | "no_app_access" | "throttled" | "logout" | "password_changed" | "temp_set";
/** Request context the login ACTION has (the verify fn does not) — the trusted client
 *  IP (same proxy-verified source the throttle uses) and user-agent. Optional: an app
 *  that has not wired it yet records the event with null ip/ua rather than nothing. */
export interface AuthEventContext {
    ip?: string | null;
    userAgent?: string | null;
}
export interface AuthEvent {
    accountId?: string | null;
    username: string;
    appKey: string;
    event: AuthEventType;
    authPath?: "office" | "pin" | "kiosk";
    reason?: string | null;
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
export declare function recordAuthEvent(pool: Queryable, evt: AuthEvent): Promise<void>;
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
export declare function authenticateOffice(pool: Queryable, args: {
    username: string;
    password: string;
    appKey: string;
    context?: AuthEventContext;
}): Promise<OfficeAuthResult>;
export declare const PAIR_FAIL_THRESHOLD = 5;
export declare const IP_FAIL_THRESHOLD = 50;
export declare const THROTTLE_BACKOFF_BASE_MS = 15000;
export declare const THROTTLE_BACKOFF_CAP_MS: number;
export declare const THROTTLE_WINDOW_MS: number;
export interface ThrottleResult {
    allowed: boolean;
    /** When !allowed, how long until the soonest lock (pair or ip) expires. */
    retryAfterMs: number;
}
/**
 * May this (ip, username) attempt a login right now? Reads BOTH scopes; blocked if
 * EITHER is locked, returning the longest remaining lock. Pure read, no write. An
 * empty/unknown ip collapses to the "" bucket, so a missing X-Forwarded-For can't
 * silently bypass the ip ceiling. Call BEFORE verifying the password.
 */
export declare function checkLoginThrottle(pool: Queryable, args: {
    ip: string;
    username: string;
}): Promise<ThrottleResult>;
/**
 * Record a failed login against BOTH scopes, applying exponential backoff once each
 * passes its threshold. Call on an auth MISS (wrong password / invalid). Fire it even
 * when the password was wrong for an unknown username, so spray is counted.
 */
export declare function recordLoginFailure(pool: Queryable, args: {
    ip: string;
    username: string;
}): Promise<void>;
/**
 * Relieve throttle state after a SUCCESSFUL login. The (ip, username) PAIR is cleared
 * outright — the user proved themselves. The ip-scope counter is DECREMENTED by one
 * (floor 0), and its lock lifted once it drops below the ceiling, so steady legitimate
 * office traffic keeps a shared NAT's ip counter low (the self-DoS fix, #366 S6 review)
 * WITHOUT a single lucky guess wiping all spray evidence — a burst of failures with no
 * successes still climbs to the ceiling.
 */
export declare function clearLoginThrottle(pool: Queryable, args: {
    ip: string;
    username: string;
}): Promise<void>;
//# sourceMappingURL=index.d.ts.map