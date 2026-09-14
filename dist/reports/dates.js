// @fcr/core/reports — relative-date boundary helpers for AUTHORING report definitions.
//
// The engine has no relative-date TOKENS and no range/`between` operator: validateDefinition rejects a
// non-parseable date value, and one date filter leaf yields exactly one comparison. So a "this year" /
// "last month" / "trailing 12 months" window is authored as TWO concrete filter leaves — `gte start` +
// `lt end` — with the boundaries resolved HERE, in America/Chicago wall-calendar terms, at
// definition-build time. Resolving on each run keeps canned reports current (a saved definition would
// otherwise freeze a concrete date and go stale next period).
//
// Boundaries are 'yyyy-mm-dd' strings; ranges are HALF-OPEN [gte, lt) so a day-granular date column falls
// in exactly one bucket. Pair with a date field: filters [{field, op:"gte", value:gte}, {field, op:"lt",
// value:lt}] under filterLogic "N AND M".
const CHICAGO = "America/Chicago";
/** The wall-clock calendar date in America/Chicago for `now`, as integer {y, m (1-12), d}. */
function chicagoParts(now) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: CHICAGO,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return { y: get("year"), m: get("month"), d: get("day") };
}
const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
/** Shift a y/m/d by `days` via UTC midnight (no DST at midnight-UTC) → 'yyyy-mm-dd'. Calendar-correct. */
function addDays(y, m, d, days) {
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
/** Days in a 1-indexed month (JS `Date(y, M, 0)` where M is 1-based gives the last day of month M). */
function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Today's Chicago calendar date, 'yyyy-mm-dd'. */
export function today(now = new Date()) {
    const { y, m, d } = chicagoParts(now);
    return ymd(y, m, d);
}
/** [today, tomorrow) — the single Chicago day containing `now`. */
export function todayRange(now = new Date()) {
    const { y, m, d } = chicagoParts(now);
    return { gte: ymd(y, m, d), lt: addDays(y, m, d, 1) };
}
/** The current calendar year: [Jan 1 this year, Jan 1 next year). */
export function thisYear(now = new Date()) {
    const { y } = chicagoParts(now);
    return { gte: ymd(y, 1, 1), lt: ymd(y + 1, 1, 1) };
}
/** The previous calendar month: [first of last month, first of this month). */
export function lastMonth(now = new Date()) {
    const { y, m } = chicagoParts(now);
    const startY = m === 1 ? y - 1 : y;
    const startM = m === 1 ? 12 : m - 1;
    return { gte: ymd(startY, startM, 1), lt: ymd(y, m, 1) };
}
/** A rolling window of the last `n` days ending TODAY inclusive: [today - (n-1), tomorrow). */
export function trailingDays(n, now = new Date()) {
    const { y, m, d } = chicagoParts(now);
    return { gte: addDays(y, m, d, -(n - 1)), lt: addDays(y, m, d, 1) };
}
/** A rolling window of the last `n` months ending TODAY inclusive: [same-day-of-month n months ago,
 *  tomorrow). The start day is clamped to the target month's length (e.g. trailing from the 31st into a
 *  30-day month lands on the 30th). */
export function trailingMonths(n, now = new Date()) {
    const { y, m, d } = chicagoParts(now);
    const total = y * 12 + (m - 1) - n;
    const startY = Math.floor(total / 12);
    const startM = (total % 12) + 1;
    const startD = Math.min(d, daysInMonth(startY, startM));
    return { gte: ymd(startY, startM, startD), lt: addDays(y, m, d, 1) };
}
