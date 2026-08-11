import { describe, expect, it } from "vitest";

import { foilCoefficients, liftCurveSlope } from "./foil.ts";
import { JIB, MAIN } from "./boat.ts";
import { FOIL } from "./tuning.ts";
import { degreesToRadians, radiansToDegrees, TAU } from "./units.ts";

const deg = degreesToRadians;

/** The main's aspect ratio, ≈ 4.86 — the curve the design document quotes. */
const AR = MAIN.aspectRatio;

const STALL_DEGREES = radiansToDegrees(FOIL.stallAngle);
const BLEND_DEGREES = radiansToDegrees(FOIL.stallBlendWidth);
/** Past here the blend has completed and the plate limb stands alone. */
const FULLY_STALLED_DEGREES = STALL_DEGREES + BLEND_DEGREES;

function cl(degrees: number, aspectRatio = AR): number {
  return foilCoefficients(deg(degrees), aspectRatio).lift;
}

function cd(degrees: number, aspectRatio = AR): number {
  return foilCoefficients(deg(degrees), aspectRatio).drag;
}

/** The flat-plate limb, written out independently of the implementation. */
function plateLift(degrees: number): number {
  return 2 * Math.sin(deg(degrees)) * Math.cos(deg(degrees));
}

function plateDrag(degrees: number): number {
  return FOIL.profileDrag + 2 * Math.sin(deg(degrees)) ** 2;
}

describe("lift-curve slope (DESIGN.md §3.2)", () => {
  it("is 2π·AR/(AR+2)", () => {
    expect(liftCurveSlope(4)).toBeCloseTo((TAU * 4) / 6, 12);
    expect(liftCurveSlope(AR)).toBeCloseTo(4.45, 2);
    expect(liftCurveSlope(JIB.aspectRatio)).toBeCloseTo(4.52, 2);
  });

  it("approaches the thin-aerofoil 2π as span grows", () => {
    expect(liftCurveSlope(1e6)).toBeCloseTo(TAU, 4);
    expect(liftCurveSlope(AR)).toBeLessThan(TAU);
  });
});

describe("attached flow", () => {
  it("puts lift exactly on the linear limb below the stall", () => {
    for (const degrees of [0.5, 5, 10, 15, 17.9]) {
      expect(cl(degrees)).toBeCloseTo(liftCurveSlope(AR) * deg(degrees), 12);
    }
  });

  it("charges induced drag on top of profile drag", () => {
    const lift = cl(12);
    const induced = (lift * lift) / (Math.PI * AR * FOIL.spanEfficiency);
    expect(cd(12)).toBeCloseTo(FOIL.profileDrag + induced, 12);
  });

  it("is profile drag alone, and no lift, at zero incidence", () => {
    expect(cl(0)).toBe(0);
    expect(cd(0)).toBeCloseTo(FOIL.profileDrag, 12);
  });

  /**
   * §3.2 calls this out as the check that the stall angle and the slope are
   * consistent with a soft sail: peak lift ≈ 1.4, not a rigid wing's 1.8.
   */
  it("peaks at a realistic Cl_max for a soft sail", () => {
    expect(cl(STALL_DEGREES)).toBeCloseTo(1.4, 1);
    expect(cl(STALL_DEGREES, JIB.aspectRatio)).toBeCloseTo(1.4, 1);
  });
});

describe("the flat-plate limb", () => {
  it("stands alone once the blend has finished", () => {
    for (const degrees of [FULLY_STALLED_DEGREES, 40, 60, 90, 120, 150, 179]) {
      expect(cl(degrees)).toBeCloseTo(plateLift(degrees), 12);
      expect(cd(degrees)).toBeCloseTo(plateDrag(degrees), 12);
    }
  });

  /**
   * The dead run. Lift is gone and drag is the whole story at Cd ≈ 2 — the
   * boat is being pushed, which is what makes downwind sailing work at all.
   */
  it("is pure drag with the sail square to the wind", () => {
    expect(cl(90)).toBeCloseTo(0, 12);
    expect(cd(90)).toBeCloseTo(2 + FOIL.profileDrag, 12);
  });

  /**
   * Flow arriving at the leech — a boom eased to starboard with the wind on the
   * starboard beam. Lift reverses past 90° and drag falls away as the sail
   * comes edge-on again; no reversed attached limb is invented near 180°.
   */
  it("reverses lift past 90° and goes quiet edge-on", () => {
    expect(cl(135)).toBeCloseTo(-1, 12);
    expect(cd(135)).toBeCloseTo(1 + FOIL.profileDrag, 12);
    expect(cl(180)).toBeCloseTo(0, 12);
    expect(cd(180)).toBeCloseTo(FOIL.profileDrag, 12);
    expect(Math.abs(cl(170))).toBeLessThan(0.4);
  });

  it("drops lift sharply through the stall, as a stall should", () => {
    expect(cl(FULLY_STALLED_DEGREES)).toBeLessThan(0.7 * cl(STALL_DEGREES));
    expect(cd(FULLY_STALLED_DEGREES)).toBeGreaterThan(cd(STALL_DEGREES));
  });
});

describe("symmetry", () => {
  it("reverses lift and preserves drag on the other face", () => {
    for (let degrees = 0; degrees <= 180; degrees += 3) {
      expect(cl(-degrees)).toBeCloseTo(-cl(degrees), 12);
      expect(cd(-degrees)).toBeCloseTo(cd(degrees), 12);
    }
  });

  it("normalises angles outside (−180°, 180°]", () => {
    for (const degrees of [12, 95, 176]) {
      expect(cl(degrees + 360)).toBeCloseTo(cl(degrees), 12);
      expect(cd(degrees - 720)).toBeCloseTo(cd(degrees), 12);
    }
  });
});

describe("the stall blend", () => {
  /**
   * Swept finely enough that a discontinuity cannot hide between samples. The
   * bound is not derived from a slope — the blend is steeper than either limb
   * it joins, reaching ~7 /rad mid-blend, so 0.01° steps legitimately move Cl
   * by up to ~1.2e-3. It is set by what a *failure* looks like instead: the two
   * limbs are 0.8 apart in Cl at the stall, so any implementation that switches
   * between them rather than blending jumps two orders of magnitude past this.
   */
  it("is continuous in both Cl and Cd across the whole range", () => {
    let previous = foilCoefficients(deg(-180), AR);
    let worstLift = 0;
    let worstDrag = 0;
    for (let degrees = -180; degrees <= 180; degrees += 0.01) {
      const current = foilCoefficients(deg(degrees), AR);
      worstLift = Math.max(worstLift, Math.abs(current.lift - previous.lift));
      worstDrag = Math.max(worstDrag, Math.abs(current.drag - previous.drag));
      previous = current;
    }
    expect(worstLift).toBeLessThan(0.01);
    expect(worstDrag).toBeLessThan(0.01);
  });

  /**
   * Continuity is the floor; the blend is smoothstep so that the *slope* is
   * continuous too, at both ends of the blend. A linear ramp would pass the
   * test above and fail this one badly — its weight arrives at the stall with
   * slope 1/width, which would knock several units per radian off the lift
   * gradient in a single step.
   */
  it("joins both limbs without a kink in the slope", () => {
    const h = 1e-5; // radians

    for (const junction of [FOIL.stallAngle, FOIL.stallAngle + FOIL.stallBlendWidth]) {
      for (const sign of [1, -1]) {
        const at = (offset: number) => foilCoefficients(sign * (junction + offset), AR);
        const before = at(-h);
        const here = at(0);
        const after = at(h);

        expect((here.lift - before.lift) / h).toBeCloseTo((after.lift - here.lift) / h, 2);
        expect((here.drag - before.drag) / h).toBeCloseTo((after.drag - here.drag) / h, 2);
      }
    }
  });

  it("holds the attached limb right up to the stall and the plate right after", () => {
    expect(cl(STALL_DEGREES - 1e-6)).toBeCloseTo(liftCurveSlope(AR) * deg(STALL_DEGREES), 5);
    expect(cl(FULLY_STALLED_DEGREES + 1e-6)).toBeCloseTo(plateLift(FULLY_STALLED_DEGREES), 5);
  });

  it("stays between the two limbs while blending", () => {
    for (let degrees = STALL_DEGREES; degrees <= FULLY_STALLED_DEGREES; degrees += 0.1) {
      const attached = liftCurveSlope(AR) * deg(degrees);
      expect(cl(degrees)).toBeLessThanOrEqual(attached + 1e-12);
      expect(cl(degrees)).toBeGreaterThanOrEqual(plateLift(degrees) - 1e-12);
    }
  });
});
