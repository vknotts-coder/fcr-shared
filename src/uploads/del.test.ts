import { describe, it, expect } from "vitest";
import { softDeleteUnitFile } from "./del";

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

  it("returns null when no live row matched (already deleted / bad id) — no double-fire", async () => {
    const db = fakeDb([]);
    const res = await softDeleteUnitFile(db, "deadbeef");
    expect(res).toBeNull();
  });
});
