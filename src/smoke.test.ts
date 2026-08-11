// Placeholder toolchain smoke test — superseded by the units tests in
// pos-t9w.2. Exercises the §2 angle convention: zero is screen-up, positive
// is clockwise, so a heading θ maps to the screen vector (sin θ, −cos θ).
import { describe, expect, it } from "vitest";

describe("toolchain smoke test (§2 angle convention)", () => {
  it("maps heading 0 to screen-up", () => {
    const theta = 0;
    expect(Math.sin(theta)).toBeCloseTo(0);
    expect(-Math.cos(theta)).toBeCloseTo(-1); // up is −y in SVG
  });

  it("maps heading +90° (east) to screen-right", () => {
    const theta = Math.PI / 2;
    expect(Math.sin(theta)).toBeCloseTo(1);
    expect(-Math.cos(theta)).toBeCloseTo(0);
  });
});
