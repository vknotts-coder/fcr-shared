// @fcr/core/events — the event-log write chokepoint, lifted from the byte-identical copies
// in fcr-dispatch/fcr-trailers src/lib/events/* (fcr-dispatch#59 Slice 5). This is the ONE
// shared definition of: the before/after field diff, the gated mutation+event statement
// builder, and the commit helper. The event CONTRACT lives in ../contracts.
//
// Deliberately DB-agnostic: `commitWithEvent` takes the SQL executor injected (same pattern
// as @fcr/core/rbac's injected pool), so this package never imports an app's db module.

import { randomUUID } from "node:crypto";
import type { EventInput, FieldChange } from "../contracts/index.js";

// ── field diff ──────────────────────────────────────────────────────────────────────
// The "which fields changed, and their old/new values" logic, in one place so every
// mutator that writes through commitWithEvent diffs the same way.
//  • Numeric columns compare AND store by numeric value — neon() returns `numeric` columns
//    as strings while formatters produce JS numbers, so a plain string compare flags a
//    spurious change. List them in `numericCols`.
//  • Every OTHER column compares by exact normalized string, so "007" → "7" isn't swallowed.
// Bookkeeping columns (updated_by, local_edit_at, …) go in `exclude` so a re-save is quiet.

export function normStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function toNum(v: unknown): number | null {
  if (v == null) return null;
  // Number("") === 0, so guard empty/whitespace before coercing.
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Date/datetime helpers (used when a caller lists dateCols/datetimeCols) — needed for the
// forward sync, which compares SF ISO strings against core values neon returns as Date or
// string. A `date` compares/stores by calendar day; a `datetime` compares by instant.
function toDateOnly(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : String(v);
}
function toInstantMs(v: unknown): number | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}
function toIso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(v);
}

export interface DiffOptions {
  /** Columns compared and stored as numbers on both sides (symmetric JSON). */
  numericCols?: Set<string>;
  /** Columns compared and stored by calendar day (YYYY-MM-DD). */
  dateCols?: Set<string>;
  /** Columns compared by instant (epoch) and stored as a full ISO string. */
  datetimeCols?: Set<string>;
  /** Bookkeeping columns not treated as business-fact changes. */
  exclude?: Set<string>;
}

/**
 * Diff the columns in `after` (about to be written) against `before` (the pre-read row).
 * One FieldChange per genuinely-changed, non-excluded column, before/after stored in a
 * consistent JSON type per column. Unlisted columns compare/store by exact normalized string.
 */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  opts: DiffOptions = {},
): FieldChange[] {
  const numericCols = opts.numericCols ?? new Set<string>();
  const dateCols = opts.dateCols ?? new Set<string>();
  const datetimeCols = opts.datetimeCols ?? new Set<string>();
  const exclude = opts.exclude ?? new Set<string>();

  const keyAndPayload = (field: string, v: unknown): { key: unknown; payload: unknown } => {
    if (numericCols.has(field)) return { key: toNum(v), payload: toNum(v) };
    if (dateCols.has(field)) return { key: toDateOnly(v), payload: toDateOnly(v) };
    if (datetimeCols.has(field)) return { key: toInstantMs(v), payload: toIso(v) };
    return { key: normStr(v), payload: normStr(v) };
  };

  const changes: FieldChange[] = [];
  for (const field of Object.keys(after)) {
    if (exclude.has(field)) continue;
    const b = keyAndPayload(field, before[field]);
    const a = keyAndPayload(field, after[field]);
    if (b.key === a.key) continue;
    changes.push({ field, before: b.payload, after: a.payload });
  }
  return changes;
}

// ── record: build the gated mutation+event statement ─────────────────────────────────
// Builds ONE SQL statement that runs the caller's mutation and its event-log row(s)
// together, GATED so the event is written only if the mutation affected a row:
//   WITH upd AS ( <caller UPDATE> RETURNING 1 )
//   INSERT INTO fcr_core.event_log (...) SELECT ... WHERE EXISTS (SELECT 1 FROM upd)
// A single statement is atomic, so mutation + event commit/roll back together, and a
// zero-row mutation writes no phantom audit entry.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Pre-write validation hook — SF validation rules attach here later. A validator throws to
// reject the write before the statement runs. FAIL-CLOSED: eventInsert wraps every validator
// throw as EventValidationError so a caller's durability fallback re-throws rather than
// bypassing the gate. (See the frozen posture notes in the original for the I/O caveat.)
export type EventValidator = (e: EventInput) => void | Promise<void>;
const validators: EventValidator[] = [];
export function registerEventValidator(v: EventValidator): void {
  validators.push(v);
}

/** A write was DELIBERATELY rejected by a registered validator (vs a transport/DB failure).
 *  Callers with a durability fallback must re-throw this, or the fallback would silently
 *  bypass the validation/authz gate the chokepoint exists to enforce. */
export class EventValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EventValidationError";
  }
}

const jsonb = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

// DB columns are `uuid`. Blank/whitespace → NULL; a present-but-non-uuid value throws a
// CLEAR error here rather than a cryptic Postgres error that would abort the statement.
function asUuid(name: string, v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (!t) return null;
  if (!UUID_RE.test(t)) throw new Error(`eventInsert: ${name} must be a uuid, got ${JSON.stringify(v)}`);
  return t;
}

/** The caller's mutation: an UPDATE (no trailing `RETURNING`/`;`) plus its params. Wrapped
 *  in `WITH upd AS ( … RETURNING 1 )`, so it must be a single row-affecting statement whose
 *  "affected a row" is what gates the event. */
export interface Mutation {
  text: string;
  params: unknown[];
}

/**
 * Build the gated mutation+event statement for `input`. One event row per field change
 * (grouped by a shared correlation_id), or one action-only row when there are no changes —
 * all conditional on the mutation affecting a row.
 *
 * @returns the SQL `text` + `params` (run with your executor) and the correlation id.
 */
export async function eventInsert(
  input: EventInput,
  mutation: Mutation,
): Promise<{ text: string; params: unknown[]; correlationId: string }> {
  // A validator throw is a DELIBERATE rejection — tag it so a caller with a durability
  // fallback re-throws it instead of falling back (which would bypass the gate).
  for (const v of validators) {
    try {
      await v(input);
    } catch (e) {
      throw e instanceof EventValidationError
        ? e
        : new EventValidationError((e as Error)?.message ?? "event rejected by validator", { cause: e });
    }
  }

  const correlationId = asUuid("correlationId", input.correlationId) ?? randomUUID();
  const actorId = asUuid("actor.id", input.actor?.id);
  const resourceId = asUuid("resourceId", input.resourceId);
  const resourceKey = (input.resourceKey ?? "").trim() || null;
  if (resourceId === null && resourceKey === null) {
    throw new Error("eventInsert: at least one of resourceId (uuid) or resourceKey (text) is required");
  }
  const metadata = jsonb(input.metadata);

  const rows = input.changes && input.changes.length > 0
    ? input.changes
    : [{ field: null as string | null, before: undefined, after: undefined }];

  // Caller's mutation params come first ($1..$base); the event params follow.
  const params: unknown[] = [...mutation.params];
  const base = mutation.params.length;
  const p = (n: number) => `$${base + n}`;
  params.push(correlationId, actorId, input.actor?.label ?? null, input.source, input.resourceType, resourceId, resourceKey, input.action, metadata);
  const shared = `${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}`;
  const metaParam = p(9);
  let next = 10;

  const tuples = rows.map((c) => {
    const f = p(next++), b = p(next++), a = p(next++);
    params.push(c.field ?? null, jsonb(c.before), jsonb(c.after));
    return `(${f}, ${b}::jsonb, ${a}::jsonb)`;
  });

  const text =
    `WITH upd AS (\n  ${mutation.text}\n  RETURNING 1\n)\n` +
    `INSERT INTO fcr_core.event_log\n` +
    `  (correlation_id, actor_id, actor_label, source, resource_type, resource_id, resource_key, action, field, before, after, metadata)\n` +
    `SELECT ${shared}, v.field, v.before, v.after, ${metaParam}::jsonb\n` +
    `FROM (VALUES ${tuples.join(", ")}) AS v(field, before, after)\n` +
    `WHERE EXISTS (SELECT 1 FROM upd)`;

  return { text, params, correlationId };
}

// ── commit: run the built statement through an INJECTED executor ──────────────────────

/** Runs the built (text, params) statement. Inject the app's query fn — e.g. neon's
 *  `(t, p) => sql().query(t, p)`. The package stays DB-agnostic; the return is ignored. */
export type SqlExecutor = (text: string, params: unknown[]) => Promise<unknown>;

/**
 * The sanctioned way to write through the event-log chokepoint: build the gated
 * mutation+event statement and run it via `exec` as ONE atomic statement, so the mutation
 * and its event commit or roll back together. Do any read-then-decide (the before-image)
 * BEFORE calling this — the statement itself is not interactive.
 */
export async function commitWithEvent(
  input: EventInput,
  mutation: Mutation,
  exec: SqlExecutor,
): Promise<{ correlationId: string }> {
  const { text, params, correlationId } = await eventInsert(input, mutation);
  await exec(text, params);
  return { correlationId };
}
