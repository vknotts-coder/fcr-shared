import { describe, it, expect } from "vitest";
import { today, todayRange, thisYear, lastMonth, trailingDays, trailingMonths } from "./dates.js";

// All boundaries are America/Chicago wall-calendar dates. We pin against a fixed `now` (a UTC instant) and
// assert the Chicago-local date, so a machine in any timezone gets the same answer. Ranges are half-open
// [gte, lt).

// 2026-09-14T18:00:00Z — Chicago is UTC-5 (CDT) in September, so local wall date is still 2026-09-14 13:00.
const SEP14 = new Date("2026-09-14T18:00:00Z");

describe("relative-date boundaries (America/Chicago)", () => {
  it("today / todayRange", () => {
    expect(today(SEP14)).toBe("2026-09-14");
    expect(todayRange(SEP14)).toEqual({ gte: "2026-09-14", lt: "2026-09-15" });
  });

  it("resolves the Chicago wall date across the UTC day boundary", () => {
    // 2026-09-15T02:00:00Z is still 2026-09-14 21:00 in Chicago (CDT) — NOT the 15th.
    expect(today(new Date("2026-09-15T02:00:00Z"))).toBe("2026-09-14");
    // 2026-09-15T06:00:00Z is 2026-09-15 01:00 Chicago — now the 15th.
    expect(today(new Date("2026-09-15T06:00:00Z"))).toBe("2026-09-15");
  });

  it("thisYear = [Jan 1, next Jan 1)", () => {
    expect(thisYear(SEP14)).toEqual({ gte: "2026-01-01", lt: "2027-01-01" });
  });

  it("lastMonth = [first of Aug, first of Sep)", () => {
    expect(lastMonth(SEP14)).toEqual({ gte: "2026-08-01", lt: "2026-09-01" });
  });

  it("lastMonth rolls the year back in January", () => {
    const jan = new Date("2026-01-10T18:00:00Z");
    expect(lastMonth(jan)).toEqual({ gte: "2025-12-01", lt: "2026-01-01" });
  });

  it("trailingDays(14) ends TOMORROW (today inclusive)", () => {
    // last 14 days ending 2026-09-14 inclusive → gte 2026-09-01, lt 2026-09-15
    expect(trailingDays(14, SEP14)).toEqual({ gte: "2026-09-01", lt: "2026-09-15" });
  });

  it("trailingMonths(12) is a rolling window ending tomorrow", () => {
    expect(trailingMonths(12, SEP14)).toEqual({ gte: "2025-09-14", lt: "2026-09-15" });
  });

  it("trailingMonths clamps the start day into a shorter month", () => {
    // From 2026-03-31, one month back is February → clamp to the 28th (2026 not a leap year).
    const mar31 = new Date("2026-03-31T18:00:00Z");
    expect(trailingMonths(1, mar31).gte).toBe("2026-02-28");
  });

  it("trailingMonths crosses the year boundary", () => {
    const feb = new Date("2026-02-10T18:00:00Z");
    expect(trailingMonths(3, feb)).toEqual({ gte: "2025-11-10", lt: "2026-02-11" });
  });
});
