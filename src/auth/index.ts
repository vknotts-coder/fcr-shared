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
// "merge the 19 driver accounts into the user table?" question is an open SCOPE §1.4 arrow (Robert's), so we
// don't prejudge it here. Office auth is the bulk (all 9 apps) and unifies cleanly today.
//
// Mirrors @fcr/core/rbac's design: an INJECTED Queryable pool (no DB-driver dependency), case-INSENSITIVE
// username (lower(username) functional unique index), fail-closed. scrypt is the same primitive the driver
// PIN path already uses (account.pin_hash / src/lib/users.ts verifyPin), so the fleet keeps one hash scheme.

import crypto from "node:crypto";

/** Minimal query surface — structurally satisfied by node-postgres `Pool` and
 *  `@neondatabase/serverless`'s `Pool`. Kept local so this package needs no DB driver
 *  (identical to @fcr/core/rbac's Queryable). */
export interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

// ── password policy (Van, 2026-10-28: 10 / 72h / 10) ─────────────────────────────────
export const PASSWORD_MIN_LENGTH = 10;
/** An admin-set temporary password (must_change) is only valid for this long after it was set. */
export const TEMP_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;
/** Lock the account after this many consecutive failed logins. */
export const LOCKOUT_THRESHOLD = 10;
/** How long a lockout lasts once the threshold is hit (duration unspecified in policy — 15 min default). */
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

const SCRYPT_KEYLEN = 64;

export interface PasswordHash {
  hash: string; // hex scrypt digest
  salt: string; // hex random salt
  algo: "scrypt";
}

/** Hash a plaintext password with a fresh random salt. Use when an admin sets a temp password or a user
 *  changes their own. Validation (length) is the caller's job — see assertPasswordPolicy. */
export function hashPassword(password: string): PasswordHash {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt, algo: "scrypt" };
}

/** Constant-time scrypt verify. Returns false (never throws) on any missing/garbled stored credential, so a
 *  credential-less row (PIN/kiosk account, or office row not yet provisioned) simply fails to authenticate. */
export function verifyPassword(password: string, salt: string | null, hash: string | null): boolean {
  if (!salt || !hash) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hash, "hex");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const computed = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(computed, expected);
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
 * Flow (fail-closed): resolve the active, non-deleted `office` account by case-insensitive username → if
 * locked (locked_until in the future) return "locked" → verify the scrypt password; on miss, increment
 * failed_attempts (and set locked_until once the threshold is hit) and return "invalid" → on a temp
 * (must_change) password past its 72h TTL return "temp_expired" → confirm an active app_access grant for
 * `appKey`, else "no_app_access" → on success reset failed_attempts and return the user (carrying mustChange
 * so the caller forces a change before granting access).
 *
 * Writes failed_attempts/locked_until/failed-reset on the injected pool — app-owned columns, no SF exposure.
 */
export async function authenticateOffice(
  pool: Queryable,
  args: { username: string; password: string; appKey: string },
): Promise<OfficeAuthResult> {
  const username = args.username.trim();
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
  // Default-deny: unknown username is "invalid" (do NOT leak existence). No DB write on a miss.
  if (!acct) return { ok: false, reason: "invalid" };

  const now = Date.now();
  if (acct.locked_until && Date.parse(acct.locked_until) > now) {
    return { ok: false, reason: "locked" };
  }

  if (!verifyPassword(args.password, acct.password_salt, acct.password_hash)) {
    const attempts = acct.failed_attempts + 1;
    const lockUntil = attempts >= LOCKOUT_THRESHOLD ? new Date(now + LOCKOUT_DURATION_MS).toISOString() : null;
    await pool.query(
      `UPDATE fcr_core.account
          SET failed_attempts = $2,
              locked_until = CASE WHEN $3::timestamptz IS NULL THEN locked_until ELSE $3::timestamptz END,
              updated_at = now()
        WHERE id = $1`,
      [acct.id, attempts, lockUntil],
    );
    return { ok: false, reason: "invalid" };
  }

  // Password is correct. A temp (must_change) password expires 72h after it was set.
  if (acct.must_change && acct.password_set_at && now - Date.parse(acct.password_set_at) > TEMP_PASSWORD_TTL_MS) {
    return { ok: false, reason: "temp_expired" };
  }

  // Valid credential — now the per-app gate. One active grant for THIS app, else no access.
  const access = await pool.query<{ one: number }>(
    `SELECT 1 AS one FROM fcr_core.app_access
      WHERE account_id = $1 AND lower(app_key) = lower($2) AND active = TRUE AND deleted_at IS NULL
      LIMIT 1`,
    [acct.id, args.appKey],
  );
  if (access.rows.length === 0) return { ok: false, reason: "no_app_access" };

  // Success: clear the failed-attempt counter (and any stale lock) if set.
  if (acct.failed_attempts !== 0 || acct.locked_until) {
    await pool.query(
      `UPDATE fcr_core.account SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [acct.id],
    );
  }

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
