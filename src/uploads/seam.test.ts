import { describe, it, expect } from "vitest";
import { sanitizeFilename, rowsOf } from "./seam";

describe("sanitizeFilename", () => {
  it("preserves spaces so a shop naming convention survives verbatim (#38)", () => {
    expect(sanitizeFilename("Invoice - RO-1234.pdf")).toBe("Invoice - RO-1234.pdf");
    expect(sanitizeFilename("RO-1234 Estimate-Pre.pdf")).toBe("RO-1234 Estimate-Pre.pdf");
    expect(sanitizeFilename("RO-1234 Revised Parts Order List.pdf")).toBe("RO-1234 Revised Parts Order List.pdf");
    expect(sanitizeFilename("RO-1234-Final.pdf")).toBe("RO-1234-Final.pdf");
  });

  it("collapses any whitespace run (tabs/newlines/multiple spaces) to one space, and trims", () => {
    expect(sanitizeFilename("  a   b  ")).toBe("a b");
    expect(sanitizeFilename("a\tb\nc")).toBe("a b c");
  });

  it("still collapses unsafe characters to underscore (quotes/slashes/parens that could break a header or path)", () => {
    expect(sanitizeFilename('a"b')).toBe("a_b");
    expect(sanitizeFilename("a/b\\c")).toBe("a_b_c");
    expect(sanitizeFilename("Prelim (HTL)")).toBe("Prelim _HTL_");
  });
});

describe("rowsOf", () => {
  it("normalizes a pg {rows} result and a bare-array (neon) result", () => {
    expect(rowsOf<number>({ rows: [1, 2] })).toEqual([1, 2]);
    expect(rowsOf<number>([3, 4])).toEqual([3, 4]);
  });
});
