import { describe, it, expect } from "vitest";
import type { Queryable } from "../rbac/index.js";
import {
  createPhotoEstimate,
  assignPhotoEstimate,
  completePhotoEstimate,
  acceptPhotoEstimate,
  declinePhotoEstimate,
} from "./write.js";
import type { PhotoEstimateRow, PhotoEstimateStatus } from "./types.js";

const ACTOR = { username: "kristen", name: "Kristen M" };

interface Call {
  text: string;
  params: unknown[];
}

/** A fake Queryable: SELECT * returns the supplied current row (loadRow); everything else returns []. */
function fakeDb(currentStatus: PhotoEstimateStatus | null, rowOverrides: Partial<PhotoEstimateRow> = {}) {
  const calls: Call[] = [];
  const row: PhotoEstimateRow | null =
    currentStatus === null
      ? null
      : {
          id: "11111111-1111-4111-8111-111111111111",
          customer_name: "Ryder",
          truck_number: "FL-2284",
          vin: "1FUJ",
          status: currentStatus,
          assigned_estimator: null,
          declined_reason: "",
          converted_truck_id: null,
          submitted_by: "kristen",
          submitted_by_name: "Kristen M",
          assigned_at: null,
          completed_at: null,
          accepted_at: null,
          declined_at: null,
          created_at: "2026-11-16",
          updated_at: "2026-11-16",
          created_by: "kristen",
          created_by_name: "Kristen M",
          updated_by: "kristen",
          updated_by_name: "Kristen M",
          deleted_at: null,
          ...rowOverrides,
        };
  const db: Queryable = {
    async query<T>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (text.includes("SELECT * FROM fcr_core.photo_estimate")) {
        return { rows: (row ? [row] : []) as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  return { db, calls };
}

describe("createPhotoEstimate", () => {
  it("requires customer, truck #, and VIN", async () => {
    const { db } = fakeDb("unassigned");
    const r = await createPhotoEstimate(db, { customerName: " ", truckNumber: "", vin: "" }, ACTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(["customer_name", "truck_number", "vin"]);
  });

  it("inserts an unassigned row through the event chokepoint", async () => {
    const { db, calls } = fakeDb("unassigned");
    const r = await createPhotoEstimate(db, { customerName: "Ryder", truckNumber: "FL-2284", vin: "1FUJ" }, ACTOR);
    expect(r.ok).toBe(true);
    const ins = calls.find((c) => c.text.includes("INSERT INTO fcr_core.photo_estimate"));
    expect(ins).toBeTruthy();
    // app-owned: never stamps the reverse-sync signals
    expect(ins!.text).not.toMatch(/dispatch_dirty_cols|local_edit_at/);
    expect(ins!.params).toContain("unassigned");
  });
});

describe("transitions enforce the status machine", () => {
  it("assign: unassigned → in_progress, pins observed status in WHERE", async () => {
    const { db, calls } = fakeDb("unassigned");
    const r = await assignPhotoEstimate(db, "11111111-1111-4111-8111-111111111111", "JR", ACTOR);
    expect(r.ok).toBe(true);
    const upd = calls.find((c) => c.text.includes("UPDATE fcr_core.photo_estimate"))!;
    expect(upd.text).toMatch(/status = \$2/);
    expect(upd.text).toMatch(/AND status = \$/); // optimistic guard
    expect(upd.params).toContain("in_progress");
    expect(upd.params).toContain("JR");
  });

  it("assign: refuses a resolved (terminal) request", async () => {
    const { db } = fakeDb("accepted");
    const r = await assignPhotoEstimate(db, "11111111-1111-4111-8111-111111111111", "JR", ACTOR);
    expect(r.ok).toBe(false);
  });

  it("complete: only from in_progress", async () => {
    expect((await completePhotoEstimate(fakeDb("unassigned").db, "11111111-1111-4111-8111-111111111111", ACTOR)).ok).toBe(false);
    expect((await completePhotoEstimate(fakeDb("in_progress").db, "11111111-1111-4111-8111-111111111111", ACTOR)).ok).toBe(true);
  });

  it("accept: only from completed; carries the converted truck id", async () => {
    expect((await acceptPhotoEstimate(fakeDb("in_progress").db, "11111111-1111-4111-8111-111111111111", ACTOR)).ok).toBe(false);
    const { db, calls } = fakeDb("completed");
    const r = await acceptPhotoEstimate(db, "11111111-1111-4111-8111-111111111111", ACTOR, "truck-123");
    expect(r.ok).toBe(true);
    const upd = calls.find((c) => c.text.includes("UPDATE fcr_core.photo_estimate"))!;
    expect(upd.params).toContain("accepted");
    expect(upd.params).toContain("truck-123");
  });

  it("decline: allowed from any active status; refused once terminal", async () => {
    expect((await declinePhotoEstimate(fakeDb("unassigned").db, "11111111-1111-4111-8111-111111111111", "cost", ACTOR)).ok).toBe(true);
    expect((await declinePhotoEstimate(fakeDb("completed").db, "11111111-1111-4111-8111-111111111111", "", ACTOR)).ok).toBe(true);
    expect((await declinePhotoEstimate(fakeDb("declined").db, "11111111-1111-4111-8111-111111111111", "x", ACTOR)).ok).toBe(false);
  });

  it("missing row → not found", async () => {
    expect((await assignPhotoEstimate(fakeDb(null).db, "nope", "JR", ACTOR)).ok).toBe(false);
  });
});
