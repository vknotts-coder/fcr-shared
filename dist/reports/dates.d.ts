export type DateRange = {
    gte: string;
    lt: string;
};
/** Today's Chicago calendar date, 'yyyy-mm-dd'. */
export declare function today(now?: Date): string;
/** [today, tomorrow) — the single Chicago day containing `now`. */
export declare function todayRange(now?: Date): DateRange;
/** The current calendar year: [Jan 1 this year, Jan 1 next year). */
export declare function thisYear(now?: Date): DateRange;
/** The previous calendar month: [first of last month, first of this month). */
export declare function lastMonth(now?: Date): DateRange;
/** A rolling window of the last `n` days ending TODAY inclusive: [today - (n-1), tomorrow). */
export declare function trailingDays(n: number, now?: Date): DateRange;
/** A rolling window of the last `n` months ending TODAY inclusive: [same-day-of-month n months ago,
 *  tomorrow). The start day is clamped to the target month's length (e.g. trailing from the 31st into a
 *  30-day month lands on the 30th). */
export declare function trailingMonths(n: number, now?: Date): DateRange;
//# sourceMappingURL=dates.d.ts.map