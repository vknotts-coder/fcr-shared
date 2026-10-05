import { describe, it, expect } from "vitest";
import { reconcileUnitFileBlobs, reconcileUnitPhotoBlobs, type ListedBlob } from "./gc";

// Pure unit test of the orphan-blob reconciliation (#170) with injected list/del/db fakes — no Blob,
// no DB. Proves: a blob with a live row is kept; an orphan past the grace window is deleted; an
// orphan INSIDE the grace window (a possible in-flight upload) is kept; a soft-deleted row's blob
// (no live row) is deleted; and pagination is followed. Negative control: shrink the grace window to
// 0 and the just-uploaded orphan flips to deleted — proving the grace guard is what protected it.

const NOW = Date.parse("2026-09-21T12:00:00Z");
const old = new Date(NOW - 3 * 60 * 60 * 1000); // 3h ago — well past a 1h grace
const recent = new Date(NOW - 2 * 60 * 1000); //   2m ago — inside grace (in-flight)

function blob(pathname: string, uploadedAt: Date): ListedBlob {
  return { pathname, url: `https://blob.test/${pathname}`, uploadedAt };
}

// db fake: answers the "which of these pathnames have a live (deleted_at IS NULL) row?" query with
// the pathnames in `livePathnames`.
function fakeDb(livePathnames: string[]) {
  return {
    query: async (_text: string, params: unknown[]) => {
      const asked = (params[0] as string[]) ?? [];
      const rows = asked.filter((p) => livePathnames.includes(p)).map((p) => ({ blob_pathname: p }));
      return { rows };
    },
  };
}

async function run(opts: {
  pages: ListedBlob[][];
  live: string[];
  graceMs?: number;
}) {
  const deleted: string[] = [];
  const res = await reconcileUnitFileBlobs({
    list: async ({ cursor }) => {
      const i = cursor ? Number(cursor) : 0;
      return { blobs: opts.pages[i] ?? [], cursor: String(i + 1), hasMore: i + 1 < opts.pages.length };
    },
    del: async (urls) => { deleted.push(...urls); },
    db: fakeDb(opts.live),
    now: NOW,
    graceMs: opts.graceMs ?? 60 * 60 * 1000,
  });
  return { res, deleted };
}

describe("reconcileUnitFileBlobs (#170)", () => {
  it("keeps blobs with a live row, deletes old orphans, keeps in-grace orphans", async () => {
    const { res, deleted } = await run({
      pages: [[
        blob("unit-files/truck/A/keep1.pdf", old),      // live → keep
        blob("unit-files/truck/A/keep2.pdf", old),      // live → keep
        blob("unit-files/truck/A/orphan.pdf", old),     // no row, old → delete
        blob("unit-files/truck/A/inflight.pdf", recent), // no row, recent → keep (grace)
      ]],
      live: ["unit-files/truck/A/keep1.pdf", "unit-files/truck/A/keep2.pdf"],
    });
    expect(deleted).toEqual(["https://blob.test/unit-files/truck/A/orphan.pdf"]);
    expect(res).toEqual({ scanned: 4, live: 2, orphaned: 1, deleted: 1 });
  });

  it("deletes a soft-deleted row's blob (no live row for it, but other live rows exist)", async () => {
    const { deleted } = await run({
      pages: [[
        blob("unit-files/trailer/B/kept.pdf", old),    // live
        blob("unit-files/trailer/B/removed.pdf", old), // row soft-deleted → not live → delete
      ]],
      live: ["unit-files/trailer/B/kept.pdf"],
    });
    expect(deleted).toEqual(["https://blob.test/unit-files/trailer/B/removed.pdf"]);
  });

  it("follows pagination across pages (orphan on page 1, live rows across both)", async () => {
    const { res, deleted } = await run({
      pages: [
        [blob("unit-files/truck/C/orphan.pdf", old), blob("unit-files/truck/C/keep1.pdf", old)],
        [blob("unit-files/truck/C/keep2.pdf", old)],
      ],
      live: ["unit-files/truck/C/keep1.pdf", "unit-files/truck/C/keep2.pdf"],
    });
    expect(res.scanned).toBe(3); // proves page 2 was fetched
    expect(deleted).toEqual(["https://blob.test/unit-files/truck/C/orphan.pdf"]);
  });

  it("negative control: grace=0 makes the in-flight orphan deletable (proves the grace guard)", async () => {
    const { deleted } = await run({
      pages: [[blob("unit-files/truck/A/keep.pdf", old), blob("unit-files/truck/A/inflight.pdf", recent)]],
      live: ["unit-files/truck/A/keep.pdf"],
      graceMs: 0,
    });
    expect(deleted).toEqual(["https://blob.test/unit-files/truck/A/inflight.pdf"]);
  });

  it("blast-radius guard: live===0 with blobs present → aborts, deletes NOTHING", async () => {
    const { res, deleted } = await run({
      pages: [[blob("unit-files/truck/D/a.pdf", old), blob("unit-files/truck/D/b.pdf", old)]],
      live: [], // wrong/empty DB target — the catastrophe case
    });
    expect(deleted).toEqual([]);
    expect(res.aborted).toBe("live-zero");
    expect(res.deleted).toBe(0);
  });

  it("blast-radius guard: would delete >50% of scanned → aborts, deletes NOTHING", async () => {
    const { res, deleted } = await run({
      pages: [[
        blob("unit-files/truck/E/live.pdf", old),   // 1 live
        blob("unit-files/truck/E/o1.pdf", old),     // 3 orphans of 4 = 75% > 50%
        blob("unit-files/truck/E/o2.pdf", old),
        blob("unit-files/truck/E/o3.pdf", old),
      ]],
      live: ["unit-files/truck/E/live.pdf"],
    });
    expect(deleted).toEqual([]);
    expect(res.aborted).toBe("over-fraction");
  });

  it("no blobs → nothing deleted (no false live-zero abort)", async () => {
    const { res, deleted } = await run({ pages: [[]], live: [] });
    expect(deleted).toEqual([]);
    expect(res).toEqual({ scanned: 0, live: 0, orphaned: 0, deleted: 0 });
  });
});

describe("reconcileUnitPhotoBlobs (#48 S4)", () => {
  it("defaults to the unit-photos/ prefix and reconciles against fcr_core.unit_photo (NOT unit_file)", async () => {
    const listPrefixes: string[] = [];
    const queries: string[] = [];
    const deleted: string[] = [];
    const NOW = Date.parse("2026-10-05T12:00:00Z");
    const old = new Date(NOW - 3 * 60 * 60 * 1000);
    const res = await reconcileUnitPhotoBlobs({
      list: async ({ prefix }) => {
        listPrefixes.push(prefix);
        return {
          blobs: [
            { pathname: "unit-photos/trailer/A/keep.jpg", url: "https://blob.test/unit-photos/trailer/A/keep.jpg", uploadedAt: old },
            { pathname: "unit-photos/trailer/A/orphan.jpg", url: "https://blob.test/unit-photos/trailer/A/orphan.jpg", uploadedAt: old },
          ],
          hasMore: false,
        };
      },
      del: async (urls) => { deleted.push(...urls); },
      db: {
        query: async (text: string, params: unknown[]) => {
          queries.push(text);
          const asked = (params[0] as string[]) ?? [];
          // only the "keep" photo is live
          return { rows: asked.filter((p) => p.endsWith("keep.jpg")).map((p) => ({ blob_pathname: p })) };
        },
      },
      now: NOW,
    });
    expect(listPrefixes).toEqual(["unit-photos/"]); // not unit-files/
    expect(queries[0]).toContain("fcr_core.unit_photo"); // owning table, not unit_file
    expect(queries[0]).not.toContain("unit_file");
    expect(deleted).toEqual(["https://blob.test/unit-photos/trailer/A/orphan.jpg"]);
    expect(res).toEqual({ scanned: 2, live: 1, orphaned: 1, deleted: 1 });
  });
});
