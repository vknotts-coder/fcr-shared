import { describe, it, expect } from "vitest";
import { makeBeforeGenerateToken } from "./token";
import { MAX_FILE_BYTES, ALLOWED_TYPES, expectedPrefix } from "./write";

// Pure unit test of the upload-token policy with an injected `authorize` seam — no @vercel/blob. Proves:
// the app's authorize runs FIRST and a throw rejects before anything else; a valid request pins the
// Blob-edge limits + the per-unit tokenPayload; and every unit/pathname guard rejects (bad type, bad
// id, a pathname not under this unit's prefix — the forged-attach case).

const UNIT = "11111111-1111-1111-1111-111111111111";
const payload = (over: Record<string, unknown> = {}) => JSON.stringify({ unitType: "trailer", unitId: UNIT, ...over });
const okPath = `${expectedPrefix("trailer", UNIT)}123-doc.pdf`;

const allow = async () => {};
const deny = async () => { throw new Error("Not authorized."); };

describe("makeBeforeGenerateToken", () => {
  it("runs authorize first — a rejecting authorize throws before any parsing", async () => {
    let parsed = false;
    const before = makeBeforeGenerateToken(deny);
    // A clientPayload that WOULD throw at JSON.parse if we reached it proves authorize gated first.
    await expect(before(okPath, "{not json")).rejects.toThrow("Not authorized.");
    expect(parsed).toBe(false);
  });

  it("returns the pinned Blob-edge limits + per-unit tokenPayload on a valid request", async () => {
    const before = makeBeforeGenerateToken(allow);
    const cfg = await before(okPath, payload());
    expect(cfg.allowedContentTypes).toEqual([...ALLOWED_TYPES]);
    expect(cfg.maximumSizeInBytes).toBe(MAX_FILE_BYTES);
    expect(cfg.addRandomSuffix).toBe(true);
    expect(JSON.parse(cfg.tokenPayload)).toEqual({ unitType: "trailer", unitId: UNIT });
  });

  it("rejects a bad unit type", async () => {
    const before = makeBeforeGenerateToken(allow);
    await expect(before(okPath, payload({ unitType: "spaceship" }))).rejects.toThrow("Bad unit reference");
  });

  it("rejects a bad unit id", async () => {
    const before = makeBeforeGenerateToken(allow);
    await expect(before(okPath, payload({ unitId: "nope" }))).rejects.toThrow("Bad unit reference");
  });

  it("rejects a pathname not under this unit's prefix (forged-attach)", async () => {
    const before = makeBeforeGenerateToken(allow);
    const evil = `${expectedPrefix("trailer", "22222222-2222-2222-2222-222222222222")}x.pdf`;
    await expect(before(evil, payload())).rejects.toThrow("not under this unit");
  });
});
