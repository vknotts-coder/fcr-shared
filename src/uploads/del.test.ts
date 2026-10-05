import { describe, it, expect } from "vitest";
import { softDeleteUnitFile, softDeleteUnitPhoto } from "./del";

// Pure unit test of the soft-delete core with an injected db fake. Proves: a live row is soft-deleted
// (deleted_at = NOW(), WHERE deleted_at IS NULL) and its cleanup fields returned; a no-match (already
// deleted / bad id) returns null so the caller can't double-fire blob/SF deletes.

function fakeDb(returnRows: Record<string, unknown>[]) {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: returnRows };
    },
  };
}

const ROW = {
  blob_url: "https://blob.test/unit-files/trailer/u/doc.pdf",
  unit_type: "trailer",
  unit_id: "11111111-1111-1111-1111-111111111111",
  sf_content_document_id: null,
  sf_content_version_id: null,
};

describe("softDeleteUnitFile", () => {
  it("soft-deletes a live row and returns its cleanup fields", async () => {
    const db = fakeDb([ROW]);
    const res = await softDeleteUnitFile(db, ROW.unit_id);
    expect(res).toEqual(ROW);
    const { text, params } = db.calls[0]!;
    expect(text).toContain("SET deleted_at = NOW()");
    expect(text).toContain("deleted_at IS NULL"); // live-only
    expect(params[0]).toBe(ROW.unit_id);
  });

  it("a valid uuid with no live row returns null (already deleted) — no double-fire", async () => {
    const db = fakeDb([]);
    const res = await softDeleteUnitFile(db, "33333333-3333-3333-3333-333333333333");
    expect(res).toBeNull();
    expect(db.calls).toHaveLength(1); // a valid id DOES hit the UPDATE (which matched nothing)
  });

  it("a NON-uuid id returns null WITHOUT touching the db (the 22P02 guard, not an unhandled throw)", async () => {
    // A real pg/neon driver throws `22P02 invalid input syntax for type uuid` on a bad cast. Model
    // that: a db that THROWS if queried. The guard must return null before we ever reach it.
    const throwingDb = {
      calls: [] as unknown[],
      query: async () => { throw new Error("22P02 invalid input syntax for type uuid"); },
    };
    const res = await softDeleteUnitFile(throwingDb, "deadbeef");
    expect(res).toBeNull();
    expect(throwingDb.calls).toHaveLength(0); // never queried — guard short-circuited
  });
});

describe("softDeleteUnitPhoto", () => {
  const PHOTO = {
    url: "https://blob.test/unit-photos/trailer/u/shot.jpg",
    unit_type: "trailer",
    unit_id: "11111111-1111-1111-1111-111111111111",
  };

  it("soft-deletes a live unit_photo row and returns url + unit ref (no SF fields)", async () => {
    const db = fakeDb([PHOTO]);
    const res = await softDeleteUnitPhoto(db, PHOTO.unit_id);
    expect(res).toEqual(PHOTO);
    const { text } = db.calls[0]!;
    expect(text).toContain("fcr_core.unit_photo");
    expect(text).toContain("SET deleted_at = NOW()");
    expect(text).toContain("deleted_at IS NULL");
  });

  it("a non-uuid id returns null WITHOUT touching the db", async () => {
    const throwingDb = {
      calls: [] as unknown[],
      query: async () => { throw new Error("22P02"); },
    };
    const res = await softDeleteUnitPhoto(throwingDb, "nope");
    expect(res).toBeNull();
    expect(throwingDb.calls).toHaveLength(0);
  });
});
