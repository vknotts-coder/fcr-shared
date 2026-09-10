// Unit tests for @fcr/core/events — the extraction must preserve the shipped behavior of the
// diff, the gated-statement builder, the fail-closed validator wrap, and the injected commit.

import { describe, it, expect, beforeAll } from "vitest";
import {
  diffChanges,
  eventInsert,
  commitWithEvent,
  registerEventValidator,
  EventValidationError,
} from "./index.js";
import type { EventInput } from "../contracts/index.js";

const mutation = {
  text: "UPDATE fcr_core.truck SET status = $1 WHERE id = $2",
  params: ["x", "00000000-0000-0000-0000-000000000001"],
};
const base = (action: string): EventInput => ({ source: "app", resourceType: "truck", resourceKey: "k", action });

beforeAll(() => {
  registerEventValidator((e) => {
    if (e.action === "reject-typed") throw new EventValidationError("deliberately blocked");
    if (e.action === "reject-raw") throw new Error("validator DB lookup failed");
  });
});

describe("diffChanges", () => {
  it("ignores excluded + unchanged, reports a real string change", () => {
    const out = diffChanges({ a: "1", b: "keep", u: "old" }, { a: "2", b: "keep", u: "new" }, { exclude: new Set(["u"]) });
    expect(out).toEqual([{ field: "a", before: "1", after: "2" }]);
  });
  it("numericCols compare + store by number (no spurious '90.00' vs 90 change)", () => {
    const out = diffChanges({ cost: "90.00" }, { cost: 90 }, { numericCols: new Set(["cost"]) });
    expect(out).toEqual([]);
  });
  it("dateCols compare by calendar day", () => {
    const out = diffChanges({ d: new Date("2026-09-10T23:00:00Z") }, { d: "2026-09-10" }, { dateCols: new Set(["d"]) });
    expect(out).toEqual([]);
  });
});

describe("eventInsert — gated statement + validator gate", () => {
  it("builds the gated mutation+event statement", async () => {
    const out = await eventInsert(base("ok"), mutation);
    expect(out.text).toMatch(/WITH upd AS/);
    expect(out.text).toMatch(/INSERT INTO fcr_core\.event_log/);
    expect(out.text).toMatch(/WHERE EXISTS \(SELECT 1 FROM upd\)/);
    expect(out.correlationId).toBeTruthy();
    expect(out.params.slice(0, 2)).toEqual(mutation.params); // caller params come first
  });
  it("requires a resourceId or resourceKey", async () => {
    const err = await eventInsert({ source: "app", resourceType: "truck", action: "x" }, mutation).then(() => null, (e) => e);
    expect((err as Error).message).toMatch(/resourceId .* or resourceKey/);
  });
  it("wraps a raw validator Error into EventValidationError (fail-closed), preserving cause", async () => {
    const err = await eventInsert(base("reject-raw"), mutation).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(EventValidationError);
    expect((err as Error).message).toBe("validator DB lookup failed");
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });
  it("passes an EventValidationError through unchanged (no double-wrap)", async () => {
    const err = await eventInsert(base("reject-typed"), mutation).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(EventValidationError);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe("commitWithEvent — injected executor", () => {
  it("runs the built statement through the injected exec and returns the correlation id", async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const exec = async (text: string, params: unknown[]) => {
      calls.push({ text, params });
    };
    const { correlationId } = await commitWithEvent(base("ok"), mutation, exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/INSERT INTO fcr_core\.event_log/);
    expect(correlationId).toBeTruthy();
  });
});
