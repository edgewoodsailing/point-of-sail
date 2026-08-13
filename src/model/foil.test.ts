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

/**
 * The lift thin-aerofoil theory asks for, before the sail's own maximum. Not a
 * lift the sail ever makes at large incidence — it passes 4 by 55° — but it is
 * what the drag is charged against, so the tests need to name it.
 */
function demandedLift(degrees: number, aspectRatio = AR): number {
  return liftCurveSlope(aspectRatio) * deg(degrees);
}

/**
 * The attached limb, written out independently of the implementation: the
 * linear limb bent over towards {@link FOIL.maxLift} by a rounded-corner `min`.
 */
function attachedLift(degrees: number, aspectRatio = AR): number {
  const demanded = demandedLift(degrees, aspectRatio);
  const p = FOIL.saturationSharpness;
  return demanded / (1 + Math.abs(demanded / FOIL.maxLift) ** p) ** (1 / p);
}

function attachedDrag(degrees: number, aspectRatio = AR): number {
  const demanded = demandedLift(degrees, aspectRatio);
  return FOIL.profileDrag + (demanded * demanded) / (Math.PI * aspectRatio * FOIL.spanEfficiency);
}

/**
 * The flat-plate limb, written out independently of the implementation: a
 * normal force `Cn = k·sinα` resolved along and across the flow.
 */
function plateLift(degrees: number): number {
  return FOIL.plateNormalForce * Math.sin(deg(degrees)) * Math.cos(deg(degrees));
}

function plateDrag(degrees: number): number {
  return FOIL.profileDrag + FOIL.plateNormalForce * Math.sin(deg(degrees)) ** 2;
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
  it("is the attached limb below the stall, with nothing of the plate in it", () => {
    for (const degrees of [0.5, 5, 10, 15, 17.9]) {
      expect(cl(degrees)).toBeCloseTo(attachedLift(degrees), 12);
    }
  });

  /**
   * And that limb is still the straight line §3.2 quotes over the range the
   * polar is actually fitted in. {@link FOIL.maxLift} bends the top over, but
   * {@link FOIL.saturationSharpness} keeps the bend near the top: a quarter of a
   * percent by the stall angle, and a tenth of that by 10°. Pinned because the
   * softening reaching further down is exactly how this constant would go wrong
   * — at a sharpness of 6 it costs 4.4% at the stall, which is thin-aerofoil
   * theory quietly stopping being thin-aerofoil theory.
   */
  it("still tracks the linear limb over the range §3.2 quotes", () => {
    expect(Math.abs(cl(10) / demandedLift(10) - 1)).toBeLessThan(0.0003);
    expect(Math.abs(cl(STALL_DEGREES) / demandedLift(STALL_DEGREES) - 1)).toBeLessThan(0.005);
  });

  /**
   * **Charged against the lift demanded, not the lift delivered.** Below the
   * maximum those are the same number and this is ordinary induced drag; past
   * it, the incidence the sail cannot turn into lift goes into separated flow,
   * which costs drag and pays nothing. Removing that asymmetry is what brings
   * the §3.5 bistability back, so it is pinned here rather than left to read as
   * an oversight — see `foil.ts` for the measurement.
   */
  it("charges induced drag on the incidence asked for, not the lift delivered", () => {
    expect(cd(12)).toBeCloseTo(attachedDrag(12), 12);

    // Past the maximum the two readings genuinely differ, which is the point.
    const delivered = cl(30);
    const cheaper = FOIL.profileDrag + (delivered * delivered) / (Math.PI * AR * FOIL.spanEfficiency);
    expect(attachedDrag(30)).toBeGreaterThan(2 * cheaper);
  });

  it("is profile drag alone, and no lift, at zero incidence", () => {
    expect(cl(0)).toBe(0);
    expect(cd(0)).toBeCloseTo(FOIL.profileDrag, 12);
  });

  /**
   * §3.2 calls this out as the check that the stall angle and the slope are
   * consistent with a soft sail: lift at the stall ≈ 1.4, not a rigid wing's
   * 1.8.
   */
  it("reaches a realistic Cl at the stall for a soft sail", () => {
    expect(cl(STALL_DEGREES)).toBeCloseTo(1.4, 1);
    expect(cl(STALL_DEGREES, JIB.aspectRatio)).toBeCloseTo(1.4, 1);
  });

  /**
   * The *true* maximum, which sits past the stall angle rather than at it, and
   * which since pos-i4o is a quantity this model states rather than one it
   * stumbles into. It used to be neither: nothing bounded the attached limb, so
   * the peak was wherever the crossfade happened to catch a ramp still
   * climbing, and it could not be moved without moving the post-stall falloff
   * with it. {@link FOIL.maxLift} is the stated figure now and the peak sits a
   * little under it, because the blend starts pulling the curve down before it
   * has finished approaching.
   *
   * It matters because every point of sail in §3.6's table trims to within a
   * degree or two of this peak, so it sets the whole force scale of the model.
   */
  it("tops out past the stall, at a lift a soft sail could still hold", () => {
    let peak = 0;
    let peakAt = 0;
    for (let degrees = 0; degrees <= 90; degrees += 0.05) {
      if (cl(degrees) > peak) {
        peak = cl(degrees);
        peakAt = degrees;
      }
    }

    expect(peakAt).toBeGreaterThan(STALL_DEGREES);
    expect(peakAt).toBeLessThan(FULLY_STALLED_DEGREES);
    expect(peak).toBeCloseTo(1.63, 2);

    // Under the asymptote it is approaching, and inside what a soft sail can
    // hold. A rigid wing's 1.8 is out of bounds here.
    expect(peak).toBeLessThan(FOIL.maxLift);
    expect(peak).toBeLessThan(1.7);
  });
});

describe("the flat-plate limb", () => {
  it("stands alone once the blend has finished", () => {
    for (const degrees of [FULLY_STALLED_DEGREES, 75, 90, 120, 150, 179]) {
      expect(cl(degrees)).toBeCloseTo(plateLift(degrees), 12);
      expect(cd(degrees)).toBeCloseTo(plateDrag(degrees), 12);
    }
  });

  /**
   * The dead run. Lift is gone and drag is the whole story — the boat is being
   * pushed, which is what makes downwind sailing work at all. Square to the
   * wind is where {@link FOIL.plateNormalForce} *is* the drag coefficient, and
   * so where §3.6's run speed is decided.
   */
  it("is pure drag with the sail square to the wind", () => {
    expect(cl(90)).toBeCloseTo(0, 12);
    expect(cd(90)).toBeCloseTo(FOIL.plateNormalForce + FOIL.profileDrag, 12);
  });

  /**
   * The coefficient itself, held to the range a stalled sail can argue for. A
   * rigid plate of infinite span gives 2.0 and one at a sail's aspect ratio
   * about 1.2; a soft sail, twisted and with the jib in the main's shadow on a
   * run, comes in under that. What this rules out is a calibration pass that
   * reached for the one constant the run responds to and pushed it somewhere a
   * sail could not go — which, given the run wants slowing, means downwards.
   */
  it("keeps the plate's normal force in the range a stalled sail can make", () => {
    expect(FOIL.plateNormalForce).toBeGreaterThan(0.9);
    expect(FOIL.plateNormalForce).toBeLessThanOrEqual(2);
  });

  /**
   * Flow arriving at the leech — a boom eased to starboard with the wind on the
   * starboard beam. Lift reverses past 90° and drag falls away as the sail
   * comes edge-on again; no reversed attached limb is invented near 180°.
   */
  it("reverses lift past 90° and goes quiet edge-on", () => {
    expect(cl(135)).toBeCloseTo(-FOIL.plateNormalForce / 2, 12);
    expect(cd(135)).toBeCloseTo(FOIL.plateNormalForce / 2 + FOIL.profileDrag, 12);
    expect(cl(180)).toBeCloseTo(0, 12);
    expect(cd(180)).toBeCloseTo(FOIL.profileDrag, 12);
    expect(Math.abs(cl(170))).toBeLessThan(0.4);
  });

  it("drops lift sharply through the stall, as a stall should", () => {
    expect(cl(FULLY_STALLED_DEGREES)).toBeLessThan(0.7 * cl(STALL_DEGREES));
    expect(cd(FULLY_STALLED_DEGREES)).toBeGreaterThan(cd(STALL_DEGREES));
  });

  /**
   * **How much lift survives *inside* the blend, which nothing here used to
   * check.** The test above reads both its samples at exactly
   * `stallAngle + stallBlendWidth`, where the curve is pure plate by
   * construction — so it holds for any blend width whatever and constrains
   * nothing. That gap is how `Cl` at 40° of incidence moved from 0.542 to 1.225
   * in pos-i4o with no test in this file noticing; it was `src/render`'s §4.2
   * tests that caught it, two layers away from the constant that moved.
   *
   * This is the model layer's own statement of that. The fractions are what
   * §4.2's "a sail sheeted flat is a mistake" is spent out of: an oversheeted
   * sail sits at large α, and the more lift the blend leaves it, the less of a
   * mistake the model says it is. Widening {@link FOIL.stallBlendWidth} spends
   * this account, and it should fail here — where the cause is — rather than
   * only in the renderer.
   */
  it("keeps the blend's falloff where §4.2 is priced against it", () => {
    let peak = 0;
    for (let degrees = 0; degrees <= 90; degrees += 0.01) peak = Math.max(peak, cl(degrees));

    // Monotone down from the peak to the end of the blend: no shelf, no second
    // hump for the optimal-trim search to find.
    for (let degrees = 26; degrees < FULLY_STALLED_DEGREES; degrees += 0.5) {
      expect(cl(degrees + 0.5), `${degrees}°`).toBeLessThan(cl(degrees));
    }

    // And the shape of it, as a fraction of peak lift so that a calibration
    // pass moving `maxLift` does not have to touch these.
    expect(cl(30) / peak).toBeCloseTo(0.935, 2);
    expect(cl(40) / peak).toBeCloseTo(0.752, 2);
    expect(cl(50) / peak).toBeCloseTo(0.543, 2);
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
    expect(cl(STALL_DEGREES - 1e-6)).toBeCloseTo(attachedLift(STALL_DEGREES), 5);
    expect(cl(FULLY_STALLED_DEGREES + 1e-6)).toBeCloseTo(plateLift(FULLY_STALLED_DEGREES), 5);
  });

  it("stays between the two limbs while blending", () => {
    // Against the *saturated* attached limb, which is a far tighter fence than
    // the linear one it replaced: the linear limb passes 4 by the end of the
    // blend, so bounding against it barely constrained anything up there.
    for (let degrees = STALL_DEGREES; degrees <= FULLY_STALLED_DEGREES; degrees += 0.1) {
      expect(cl(degrees)).toBeLessThanOrEqual(attachedLift(degrees) + 1e-12);
      expect(cl(degrees)).toBeGreaterThanOrEqual(plateLift(degrees) - 1e-12);
    }
  });
});
