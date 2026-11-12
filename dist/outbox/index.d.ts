import type { Queryable } from "../rbac/index.js";
export type EmailStatus = "pending" | "sending" | "sent" | "failed";
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
/** Enqueue one email as a `pending` row. Validates a non-empty recipient list, a sender, and a subject
 *  (an empty-recipient send is a silent no-op at Resend and a wasted claim here). Returns the row id. */
export declare function enqueueEmail(q: Queryable, input: EmailOutboxInput): Promise<{
    id: string;
}>;
/** Atomically claim up to `limit` sendable rows and flip them to 'sending' (incrementing `attempts`)
 *  in ONE statement, so two overlapping cron runs never grab the same row. Sendable = `pending`, OR a
 *  `sending` row stranded by a crashed run (`updated_at` older than `staleMinutes`). Uses
 *  FOR UPDATE SKIP LOCKED inside a single atomic UPDATE — NOT a held transaction + session advisory
 *  lock, which is unsafe over the Neon PgBouncer pooler (the receipt-sf-push discipline). The caller
 *  then sends each row and calls markSent / markFailed. */
export declare function claimPendingEmails(q: Queryable, limit?: number, staleMinutes?: number): Promise<EmailOutboxRow[]>;
/** Mark a claimed row delivered. */
export declare function markSent(q: Queryable, id: string): Promise<void>;
/** Record a failed send attempt. `attempts` was already incremented at claim time, so this returns the
 *  row to `pending` for another tick UNLESS it has hit `max_attempts`, in which case it dead-letters to
 *  `failed`. `error` is truncated so a huge provider payload can't bloat the row. */
export declare function markFailed(q: Queryable, id: string, error: string): Promise<void>;
//# sourceMappingURL=index.d.ts.map