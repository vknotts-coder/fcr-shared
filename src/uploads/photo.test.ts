import { describe, it, expect } from "vitest";
import { recordUnitPhoto, MAX_PHOTO_BYTES, expectedPhotoPrefix, type RecordPhotoInput } from "./photo.js";
import type { BlobVerify } from "./write.js";

// Pure unit test of the unit_photo write core with injected db + verify fakes — mirrors write.test.ts.
// Proves the happy-path INSERT shape + column map (incl. caption, url=blobUrl), image-only type
// enforcement, and that every guard rejects BEFORE the blob lookup (negative controls), plus verify()
// re-confirming the real pathname.

const UNIT = "11111111-1111-1111-1111-111111111111";
const ACTOR = { username: "rt@example.com", name: "RT Runner" };
const PREFIX = expectedPhotoPrefix("trailer", UNIT);
const okSize = 2048;

function fakeDb() {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [{ id: "photo-id-1" }] };
    },
  };
}

function fakeVerify(contentType = "image/jpeg") {
  const state = { calls: 0 };
  const verify: BlobVerify = async (url) => {
    state.calls++;
    return { pathname: url.replace("https://blob.test/", ""), size: okSize, contentType };
  };
  return { state, verify };
}

function input(over: Partial<RecordPhotoInput> = {}): RecordPhotoInput {
  return {
    unitType: "trailer",
    unitId: UNIT,
    blobUrl: `https://blob.test/${PREFIX}1727-shot-Ab3xYz.jpg`,
    blobPathname: `${PREFIX}1727-shot-Ab3xYz.jpg`,
    contentType: "image/jpeg",
    byteSize: okSize,
    caption: "front left damage",
    ...over,
  };
}

describe("recordUnitPhoto", () => {
  it("records a photo into a unit_photo INSERT with url + caption", async () => {
    const db = fakeDb();
    const { verify } = fakeVerify();
    const res = await recordUnitPhoto(input(), ACTOR, { db, verify });
    expect(res).toEqual({ ok: true, id: "photo-id-1" });

    const { text, params } = db.calls[0]!;
    expect(text).toContain("INSERT INTO fcr_core.unit_photo");
    // [unitType, unitId, url, verified.pathname, contentType, byteSize, actorName, caption]
    expect(params[0]).toBe("trailer");
    expect(params[1]).toBe(UNIT);
    expect(params[2]).toBe(`https://blob.test/${PREFIX}1727-shot-Ab3xYz.jpg`); // url = blobUrl
    expect(params[4]).toBe("image/jpeg");
    expect(params[5]).toBe(okSize);
    expect(params[6]).toBe(ACTOR.name);
    expect(params[7]).toBe("front left damage");
  });

  it("trims a blank caption to null", async () => {
    const db = fakeDb();
    const { verify } = fakeVerify();
    await recordUnitPhoto(input({ caption: "   " }), ACTOR, { db, verify });
    expect(db.calls[0]!.params[7]).toBeNull();
  });

  it("rejects a PDF (photos are images only) BEFORE the blob lookup", async () => {
    const db = fakeDb();
    const { state, verify } = fakeVerify();
    const res = await recordUnitPhoto(input({ contentType: "application/pdf" }), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("JPEG, PNG, HEIC, or WebP");
    expect(state.calls).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it("rejects an over-cap size BEFORE the blob lookup (negative control)", async () => {
    const db = fakeDb();
    const { state, verify } = fakeVerify();
    const res = await recordUnitPhoto(input({ byteSize: MAX_PHOTO_BYTES + 1 }), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("too large");
    expect(state.calls).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it("rejects a blob pathname not under this unit's photo prefix (forged-attach)", async () => {
    const db = fakeDb();
    const { verify } = fakeVerify();
    const other = "22222222-2222-2222-2222-222222222222";
    const res = await recordUnitPhoto(
      input({
        blobPathname: `${expectedPhotoPrefix("trailer", other)}evil.jpg`,
        blobUrl: `https://blob.test/${expectedPhotoPrefix("trailer", other)}evil.jpg`,
      }),
      ACTOR,
      { db, verify },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("not attached to this unit");
    expect(db.calls).toHaveLength(0);
  });

  it("rejects a lying client whose REAL blob is over-cap (verified.size guard, AFTER the lookup)", async () => {
    const db = fakeDb();
    const verify: BlobVerify = async (url) => ({ pathname: url.replace("https://blob.test/", ""), size: MAX_PHOTO_BYTES + 1, contentType: "image/jpeg" });
    const res = await recordUnitPhoto(input({ byteSize: 1000 }), ACTOR, { db, verify });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors.join(" ")).toContain("too large");
    expect(db.calls).toHaveLength(0);
  });

  it("persists the VERIFIED size, not the client-claimed byteSize", async () => {
    const db = fakeDb();
    const verify: BlobVerify = async (url) => ({ pathname: url.replace("https://blob.test/", ""), size: 4096, contentType: "image/jpeg" });
    await recordUnitPhoto(input({ byteSize: 999 }), ACTOR, { db, verify });
    expect(db.calls[0]!.params[5]).toBe(4096);
  });

  it("uses a photo prefix distinct from the file prefix (no GC collision)", () => {
    expect(expectedPhotoPrefix("trailer", UNIT)).toBe(`unit-photos/trailer/${UNIT}/`);
    expect(expectedPhotoPrefix("trailer", UNIT)).not.toContain("unit-files/");
  });
});
