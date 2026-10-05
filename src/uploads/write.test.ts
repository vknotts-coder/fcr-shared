import { describe, it, expect } from "vitest";
import { recordUnitFile, MAX_FILE_BYTES, type BlobVerify, type RecordFileInput } from "./write";

// Pure unit test of the unit_file write core with injected db + verify fakes — no Blob, no DB (the
// dispatch runtime harness that drove this against a real CoW Neon branch stays in the app). Proves
// the happy-path INSERT shape + column mapping, filename sanitization (store the clean picked name),
// and that every guard rejects BEFORE the blob lookup — the negative controls: over-cap size,
// disallowed type, a forged prefix (a client can't attach an arbitrary blob to a unit), bad unit id,
// and the verify() re-confirming the blob's real pathname.

const UNIT = "11111111-1111-1111-1111-111111111111";
const ACTOR = { username: "rt@example.com", name: "RT Runner" };
const PREFIX = `unit-files/truck/${UNIT}/`;
const okSize = 1234;

// Capture the INSERT so we can assert the column mapping; return a synthetic id row.
function fakeDb() {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [{ id: "file-id-1" }] };
    },
  };
}

// Fake head(): the blob "exists" and reports back the pathname/size it was asked about. Counts calls
// so a negative control can prove the guard rejected BEFORE the blob lookup.
function fakeVerify() {
  const state = { calls: 0 };
  const verify: BlobVerify = async (url) => {
    state.calls++;
    const pathname = url.replace("https://blob.test/", "");
    return { pathname, size: okSize };
  };
  return { state, verify };
}

function input(over: Partial<RecordFileInput> = {}): RecordFileInput {
  return {
    unitType: "truck",
    unitId: UNIT,
    filename: "tow_bill.pdf",
    blobUrl: `https://blob.test/${PREFIX}1727-tow_bill-Ab3xYz.pdf`,
    blobPathname: `${PREFIX}1727-tow_bill-Ab3xYz.pdf`,
    contentType: "application/pdf",
    byteSize: okSize,
    purpose: "tow bill for accounting",
    ...over,
  };
}

describe("recordUnitFile", () => {
  it("records an uploaded blob into a unit_file INSERT with the right columns + purpose note", async () => {
    const db = fakeDb();
    const { verify } = fakeVerify();
    const res = await recordUnitFile(input(), ACTOR, { db, verify });
    expect(res).toEqual({ ok: true, id: "file-id-1" });

    expect(db.calls).toHaveLength(1);
    const { text, params } = db.calls[0]!;
    expect(text).toContain("INSERT INTO fcr_core.unit_file");
    // [unitType, unitId, filename, blobUrl, verified.pathname, contentType, byteSize, purpose, actorName]
    expect(params[0]).toBe("truck");
    expect(params[1]).toBe(UNIT);
    expect(params[2]).toBe("tow_bill.pdf"); // the clean picked name, not the ts/random storage key
    expect(params[5]).toBe("application/pdf");
    expect(params[6]).toBe(okSize);
    expect(params[7]).toBe("tow bill for accounting");
    expect(params[8]).toBe(ACTOR.name);
  });

  it("trims a blank purpose to null and sanitizes a dirty filename", async () => {
    const db = fakeDb();
    const { verify } = fakeVerify();
    await recordUnitFile(input({ purpose: "   ", filename: "../../etc/pa ss?.pdf" }), ACTOR, { db, verify });
    const { params } = db.calls[0]!;
    expect(params[7]).toBeNull();
    expect(String(params[2])).not.toMatch(/[/?\\ ]/); // slashes/spaces/queries stripped
  });

  it("rejects an over-cap size BEFORE the blob lookup (size guard negative control)", async () => {
    const db = fakeDb();
    const { state, verify } = fakeVerify();
    const res = await recordUnitFile(input({ byteSize: MAX_FILE_BYTES + 1 }), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("too large");
    expect(state.calls).toBe(0); // blob never looked up — guard rejected first
    expect(db.calls).toHaveLength(0); // and nothing written
  });

  it("rejects a disallowed content type BEFORE the blob lookup (type guard negative control)", async () => {
    const db = fakeDb();
    const { state, verify } = fakeVerify();
    const res = await recordUnitFile(input({ contentType: "text/html" }), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("PDF or an image");
    expect(state.calls).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it("rejects a blob pathname not under this unit's prefix (forged-attach negative control)", async () => {
    const db = fakeDb();
    const { verify } = fakeVerify();
    const other = "22222222-2222-2222-2222-222222222222";
    const res = await recordUnitFile(
      input({ blobPathname: `unit-files/truck/${other}/evil.pdf`, blobUrl: `https://blob.test/unit-files/truck/${other}/evil.pdf` }),
      ACTOR,
      { db, verify },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("not attached to this unit");
    expect(db.calls).toHaveLength(0);
  });

  it("rejects a bad unit id", async () => {
    const db = fakeDb();
    const { verify } = fakeVerify();
    const res = await recordUnitFile(input({ unitId: "not-a-uuid" }), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  it("rejects an unknown unit type BEFORE the blob lookup (type guard negative control)", async () => {
    const db = fakeDb();
    const { state, verify } = fakeVerify();
    const res = await recordUnitFile(input({ unitType: "spaceship" }), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("Unknown unit type");
    expect(state.calls).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it("rejects an empty file (byteSize <= 0) BEFORE the blob lookup (empty guard negative control)", async () => {
    const db = fakeDb();
    const { state, verify } = fakeVerify();
    const res = await recordUnitFile(input({ byteSize: 0 }), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("empty");
    expect(state.calls).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it("re-confirms the blob's REAL pathname via verify() — a lying client payload is caught", async () => {
    const db = fakeDb();
    // verify returns a pathname OUTSIDE this unit's prefix regardless of the (valid-looking) input.
    const verify: BlobVerify = async () => ({ pathname: "unit-files/truck/00000000-0000-0000-0000-000000000000/x.pdf", size: okSize });
    const res = await recordUnitFile(input(), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("not attached to this unit");
    expect(db.calls).toHaveLength(0);
  });

  it("returns a friendly error (does not throw) when the blob verify fails", async () => {
    const db = fakeDb();
    const verify: BlobVerify = async () => { throw new Error("head() 404"); };
    const res = await recordUnitFile(input(), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("not found");
    expect(db.calls).toHaveLength(0);
  });
});
