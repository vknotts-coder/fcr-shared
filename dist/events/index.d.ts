import type { EventInput, FieldChange } from "../contracts/index.js";
import type { Queryable } from "../rbac/index.js";
export declare function normStr(v: unknown): string | null;
export declare function toNum(v: unknown): number | null;
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
export declare function diffChanges(before: Record<string, unknown>, after: Record<string, unknown>, opts?: DiffOptions): FieldChange[];
export type EventValidator = (e: EventInput) => void | Promise<void>;
export declare function registerEventValidator(v: EventValidator): void;
/** A write was DELIBERATELY rejected by a registered validator (vs a transport/DB failure).
 *  Callers with a durability fallback must re-throw this, or the fallback would silently
 *  bypass the validation/authz gate the chokepoint exists to enforce. */
export declare class EventValidationError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
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
export declare function eventInsert(input: EventInput, mutation: Mutation): Promise<{
    text: string;
    params: unknown[];
    correlationId: string;
}>;
/**
 * The sanctioned way to write through the event-log chokepoint: build the gated
 * mutation+event statement and run it via the injected `db` as ONE atomic statement, so the
 * mutation and its event commit or roll back together. Do any read-then-decide (the
 * before-image) BEFORE calling this — the statement itself is not interactive.
 *
 * `db` is the SAME `Queryable` seam @fcr/core/rbac + /reports inject — the app passes its
 * `pool()` (or neon `sql()`); the query result is ignored here.
 */
export declare function commitWithEvent(input: EventInput, mutation: Mutation, db: Queryable): Promise<{
    correlationId: string;
}>;
//# sourceMappingURL=index.d.ts.map