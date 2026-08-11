import { describe, expect, it } from "vitest";

import { formatNumber } from "./svg.ts";

describe("attribute number formatting", () => {
  it("drops the noise without dropping the boat", () => {
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(3)).toBe("3");
    expect(formatNumber(1200)).toBe("1200");
    expect(formatNumber(-2.1336)).toBe("-2.1336");
    expect(formatNumber(1.06680000001)).toBe("1.0668");
  });

  it("never emits exponent notation, which is what a bare String() would", () => {
    // SVG's grammar does accept exponents, but they are a needless trap and
    // `String(1e-7)` produces them from perfectly ordinary rounding residue.
    // (`toFixed` itself gives up above 1e21, which no dimension of a boat, a
    // wind speed or a force will ever approach.)
    expect(String(1e-7)).toContain("e");
    expect(formatNumber(1e-7)).toBe("0");
    expect(formatNumber(1e6)).toBe("1000000");
  });

  it("folds negative zero, so an attribute compares equal to its positive twin", () => {
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(-1e-9)).toBe("0");
  });

  it("refuses a value that would silently break a path", () => {
    expect(() => formatNumber(Number.NaN)).toThrow(/NaN/);
    expect(() => formatNumber(Number.POSITIVE_INFINITY)).toThrow(/Infinity/);
  });
});
