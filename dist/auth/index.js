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
/** Hash a plaintext password with a fresh random salt. Use when an admin sets a temp password or a user
 *  changes their own. Validation (length) is the caller's job — see passwordMeetsPolicy. */
export async function hashPassword(password) {
    const salt = randomBytes(16).toString("hex");
    const hash = (await scrypt(password, salt, SCRYPT_KEYLEN)).toString("hex");
    return { hash, salt, algo: "scrypt" };
}
/** Constant-time scrypt verify. Returns false (never throws) on any missing/garbled stored credential, so a
 *  credential-less row (PIN/kiosk account, or office row not yet provisioned) simply fails to authenticate.
 *  Buffer.from(…, "hex") truncates bad input rather than throwing, so the length guard — not a try/catch — is
 *  what rejects a garbled hash. */
export async function verifyPassword(password, salt, hash) {
    if (!salt || !hash)
        return false;
    const expected = Buffer.from(hash, "hex");
    if (expected.length !== SCRYPT_KEYLEN)
        return false;
    const computed = (await scrypt(password, salt, SCRYPT_KEYLEN));
    return timingSafeEqual(computed, expected);
}
/** True when a plaintext password meets policy. Caller gates set/change on this (not authenticate — an
 *  existing weaker password still logs in; policy applies to NEW passwords). */
export function passwordMeetsPolicy(password) {
    return password.length >= PASSWORD_MIN_LENGTH;
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
export async function authenticateOffice(pool, args) {
    const username = args.username.trim();
    const { rows } = await pool.query(`SELECT id, username, display_name, password_hash, password_salt,
            password_set_at::text AS password_set_at, must_change, failed_attempts,
            locked_until::text AS locked_until
       FROM fcr_core.account
      WHERE lower(username) = lower($1) AND kind = 'office'
        AND active = TRUE AND deleted_at IS NULL`, [username]);
    const acct = rows[0];
    // Default-deny: unknown username is "invalid" (do NOT leak existence). Spend a decoy verify so the no-row
    // path takes ~the same time as a real one, then return — no DB write.
    if (!acct) {
        await verifyPassword(args.password, DECOY_SALT, DECOY_HASH);
        return { ok: false, reason: "invalid" };
    }
    const now = Date.now();
    if (acct.locked_until && Date.parse(acct.locked_until) > now) {
        return { ok: false, reason: "locked" };
    }
    if (!(await verifyPassword(args.password, acct.password_salt, acct.password_hash))) {
        // Atomic SQL increment + threshold lock in ONE statement — the counter advances from the DB's current
        // value, not a stale SELECT, so N concurrent wrong-password requests advance it by N (not a lost update
        // that leaves the lockout unarmed).
        await pool.query(`UPDATE fcr_core.account
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= $2
                                  THEN now() + ($3 || ' milliseconds')::interval
                                  ELSE locked_until END,
              updated_at = now()
        WHERE id = $1`, [acct.id, LOCKOUT_THRESHOLD, String(LOCKOUT_DURATION_MS)]);
        return { ok: false, reason: "invalid" };
    }
    // Password is correct → clear any stale failed-attempt counter / lock NOW, before the remaining gates. A
    // user who proves the password but is then gated by temp-expiry or no-grant must not keep a primed counter
    // (which a single later wrong attempt would immediately re-lock).
    if (acct.failed_attempts !== 0 || acct.locked_until) {
        await pool.query(`UPDATE fcr_core.account SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1`, [acct.id]);
    }
    // A temp (must_change) password expires 72h after it was set.
    if (acct.must_change && acct.password_set_at && now - Date.parse(acct.password_set_at) > TEMP_PASSWORD_TTL_MS) {
        return { ok: false, reason: "temp_expired" };
    }
    // The per-app gate: one active grant for THIS app, else no access.
    const access = await pool.query(`SELECT 1 AS one FROM fcr_core.app_access
      WHERE account_id = $1 AND lower(app_key) = lower($2) AND active = TRUE AND deleted_at IS NULL
      LIMIT 1`, [acct.id, args.appKey]);
    if (access.rows.length === 0)
        return { ok: false, reason: "no_app_access" };
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
