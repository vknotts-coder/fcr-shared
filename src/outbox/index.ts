// @fcr/core/outbox — a small transactional email outbox: one app ENQUEUES an email as a row in
// `fcr_core.email_outbox`, and a single owner app (fcr-dispatch, which holds the Resend key) CLAIMS
// and sends it. This lets an app with no Resend credential (fcr-estimating's missing-truck email, #52)
// reuse dispatch's verified-domain key through the DB, honoring the platform rule that cross-app glue
// is DB-only (no app-to-app HTTP). Epic fcr-dispatch#458.
//
// Deliberately DB-agnostic: every function takes the SQL executor injected (same pattern as
// @fcr/core/events and @fcr/core/rbac), so this package imports no DB driver. The table is APP-OWNED —
// it has no sf_id, is absent from sync-targets.json, and is never read by the forward/reverse crons;
// enqueueing an email must never stamp any unit's local_edit_at / dispatch_dirty_cols.

import { randomUUID } from "node:crypto";
import type { Queryable } from "../rbac/index.js";

export type EmailStatus = "pending" | "sending" | "sent" | "failed";

const TABLE = "fcr_core.email_outbox";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_CLAIM_LIMIT = 20;
const DEFAULT_STALE_MINUTES = 10;

/** What a producer hands `enqueueEmail`. `to` must be non-empty; `from` is the full RFC-5322 sender
 *  identity (e.g. "FCR Estimating <estimating@fcrdispatch.com>") — the consumer sends it verbatim with
 *  dispatch's key, so the mail still reads as from the originating app (same verified fcrdispatch.com). */
export interface EmailOutboxInput {
  to: string[];
  cc?: string[];
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  /** Provenance, e.g. "estimating:missing_truck" — never the send mechanism. */
  source: string;
  createdBy?: string;
  /** Retry cap before the row dead-letters to 'failed'. Default 5. */
  maxAttempts?: number;
}

/** A claimed row the consumer sends. Addr arrays come back as Postgres text[] → JS string[]. */
export interface EmailOutboxRow {
  id: string;
  status: EmailStatus;
  to_addrs: string[];
  cc_addrs: string[] | null;
  from_addr: string;
  reply_to: string | null;
  subject: string;
  html: string;
  text: string | null;
  source: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_by: string | null;
}

function cleanList(xs: string[] | undefined): string[] {
  return (xs ?? []).map((s) => s.trim()).filter(Boolean);
}

/** Enqueue one email as a `pending` row. Validates a non-empty recipient list, a sender, and a subject
 *  (an empty-recipient send is a silent no-op at Resend and a wasted claim here). Returns the row id. */
export async function enqueueEmail(q: Queryable, input: EmailOutboxInput): Promise<{ id: string }> {
  const to = cleanList(input.to);
  if (to.length === 0) throw new Error("enqueueEmail: at least one recipient (to) is required");
  if (!input.from?.trim()) throw new Error("enqueueEmail: from is required");
  if (!input.subject?.trim()) throw new Error("enqueueEmail: subject is required");
  const cc = cleanList(input.cc);
  const id = randomUUID();
  await q.query(
    `INSERT INTO ${TABLE}
       (id, status, to_addrs, cc_addrs, from_addr, reply_to, subject, html, text, source, attempts, max_attempts, created_by)
     VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11)`,
    [
      id,
      to,
      cc.length ? cc : null,
      input.from.trim(),
      input.replyTo?.trim() || null,
      input.subject,
      input.html,
      input.text ?? null,
      input.source,
      Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      input.createdBy ?? null,
    ],
  );
  return { id };
}

/** Atomically claim up to `limit` sendable rows and flip them to 'sending' (incrementing `attempts`)
 *  in ONE statement, so two overlapping cron runs never grab the same row. Sendable = `pending`, OR a
 *  `sending` row stranded by a crashed run (`updated_at` older than `staleMinutes`). Uses
 *  FOR UPDATE SKIP LOCKED inside a single atomic UPDATE — NOT a held transaction + session advisory
 *  lock, which is unsafe over the Neon PgBouncer pooler (the receipt-sf-push discipline). The caller
 *  then sends each row and calls markSent / markFailed. */
export async function claimPendingEmails(
  q: Queryable,
  limit: number = DEFAULT_CLAIM_LIMIT,
  staleMinutes: number = DEFAULT_STALE_MINUTES,
): Promise<EmailOutboxRow[]> {
  const { rows } = await q.query<EmailOutboxRow>(
    `UPDATE ${TABLE} o
        SET status = 'sending', attempts = o.attempts + 1, updated_at = now()
       FROM (
         SELECT id FROM ${TABLE}
          WHERE attempts < max_attempts
            AND (status = 'pending'
                 OR (status = 'sending' AND updated_at < now() - make_interval(mins => $2::int)))
          ORDER BY created_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ) sel
      WHERE o.id = sel.id
      RETURNING o.id, o.status, o.to_addrs, o.cc_addrs, o.from_addr, o.reply_to, o.subject,
                o.html, o.text, o.source, o.attempts, o.max_attempts, o.last_error, o.created_by`,
    [Math.max(1, limit), Math.max(1, staleMinutes)],
  );
  return rows;
}

/** Mark a claimed row delivered. */
export async function markSent(q: Queryable, id: string): Promise<void> {
  await q.query(
    `UPDATE ${TABLE} SET status = 'sent', sent_at = now(), last_error = NULL, updated_at = now() WHERE id = $1`,
    [id],
  );
}

/** Record a failed send attempt. `attempts` was already incremented at claim time, so this returns the
 *  row to `pending` for another tick UNLESS it has hit `max_attempts`, in which case it dead-letters to
 *  `failed`. `error` is truncated so a huge provider payload can't bloat the row. */
export async function markFailed(q: Queryable, id: string, error: string): Promise<void> {
  await q.query(
    `UPDATE ${TABLE}
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
            last_error = $2,
            updated_at = now()
      WHERE id = $1`,
    [id, (error ?? "").slice(0, 2000)],
  );
}
