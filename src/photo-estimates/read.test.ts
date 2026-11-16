import { describe, it, expect } from "vitest";
import { getPhotoEstimate } from "./read.js";
import type { Queryable } from "../rbac/index.js";
import type { PhotoEstimateRow } from "./types.js";

// Regression guard (round-2 review, PR #42): getPhotoEstimate uses an explicit SELECT_COLS list, so a new
// column added to the table + createPhotoEstimate's INSERT is read back ONLY if it is also added here. The
// structured customer/contact carry-through (customer_sf_id / contact_ref / contact_name) is read by the
// convert page off getPhotoEstimate; if the SELECT drops them the prefill silently dies with green tsc/tests.
describe("getPhotoEstimate reads the structured customer/contact columns", () => {
  it("SELECTs customer_sf_id, contact_ref, contact_name and returns them", async () => {
    let seenText = "";
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      customer_name: "Ryder",
      customer_sf_id: "001AAA",
      contact_ref: "003BBB",
      contact_name: "Dana Dispatch",
    } as PhotoEstimateRow;
    const db: Queryable = {
      async query<T>(text: string) {
        seenText = text;
        return { rows: [row as unknown as T] };
      },
    };
    const got = await getPhotoEstimate(db, row.id);
    // The column list must carry all three, or the convert prefill reads undefined.
    expect(seenText).toMatch(/customer_sf_id/);
    expect(seenText).toMatch(/contact_ref/);
    expect(seenText).toMatch(/contact_name/);
    expect(got?.customer_sf_id).toBe("001AAA");
    expect(got?.contact_ref).toBe("003BBB");
    expect(got?.contact_name).toBe("Dana Dispatch");
  });
});
