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
}): Promise<OfficeAuthResult>;
//# sourceMappingURL=index.d.ts.map