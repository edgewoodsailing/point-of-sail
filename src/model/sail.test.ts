import { describe, expect, it } from "vitest";

import { JIB, MAIN, SWING_LIMIT } from "./boat.ts";
import {
  angleOfAttack,
  dynamicPressure,
  luffFraction,
  optimalTrim,
  rigForce,
  sailForce,
} from "./sail.ts";
import { FOIL, LUFF } from "./tuning.ts";
import type { ApparentWind } from "./wind.ts";
import type { Radians } from "./units.ts";
import { degreesToRadians, normalizeSigned, radiansToDegrees, TAU } from "./units.ts";

const deg = degreesToRadians;

const AR = MAIN.aspectRatio;
const SWING_LIMIT_DEGREES = radiansToDegrees(SWING_LIMIT);

/** A stock breeze. Nothing here depends on the figure; it just has to be nonzero. */
const BREEZE = 6;

function wind(awaDegrees: number, speed = BREEZE): ApparentWind {
  return { speed, angle: deg(awaDegrees) };
}

function driving(sailAngleDegrees: number, apparent: ApparentWind, sail = MAIN): number {
  return sailForce(sail, deg(sailAngleDegrees), apparent).driving;
}

// --- The force curve, written out independently of the implementation -------
//
// The module builds the force as vectors: lift 90° clockwise of the flow, drag
// along it, then the along-heading component. Resolving that by hand collapses
// to a scalar in the apparent wind angle,
//
//     driving = q · A · (1 − luff) · (Cl·sin(AWA) − Cd·cos(AWA))
//
// which is a genuinely different route to the same number — no vectors, no
// `perpendicular`, no sign convention borrowed from the code under test.

/** The attached-flow limb of §3.2, for angles of attack below the stall. */
function attachedCl(alphaDegrees: number, aspectRatio = AR): number {
  return ((TAU * aspectRatio) / (aspectRatio + 2)) * deg(alphaDegrees);
}

function attachedCd(alphaDegrees: number, aspectRatio = AR): number {
  const lift = attachedCl(alphaDegrees, aspectRatio);
  return FOIL.profileDrag + (lift * lift) / (Math.PI * aspectRatio * FOIL.spanEfficiency);
}

/** The flat-plate limb of §3.2, which stands alone past stall + blend. */
function plateCl(alphaDegrees: number): number {
  return 2 * Math.sin(deg(alphaDegrees)) * Math.cos(deg(alphaDegrees));
}

function plateCd(alphaDegrees: number): number {
  return FOIL.profileDrag + 2 * Math.sin(deg(alphaDegrees)) ** 2;
}

function expectedDriving(
  cl: number,
  cd: number,
  awaDegrees: number,
  sail = MAIN,
  speed = BREEZE,
): number {
  const scaling = dynamicPressure(speed) * sail.area;
  return scaling * (cl * Math.sin(deg(awaDegrees)) - cd * Math.cos(deg(awaDegrees)));
}

describe("angle of attack (DESIGN.md §3.2)", () => {
  /**
   * The module builds α out of `sailChordBearing`, `oppositeAngle` and
   * `angleBetween` so the geometry reads at the call site. All three cancel:
   * α = normalizeSigned(AWA + sailAngle). Pin the identity so a future edit to
   * any of the three helpers cannot quietly change what a trim means.
   */
  it("reduces to normalizeSigned(AWA + sailAngle)", () => {
    for (let awa = -180; awa <= 180; awa += 7) {
      for (let sailAngle = -90; sailAngle <= 90; sailAngle += 11) {
        expect(angleOfAttack(deg(sailAngle), wind(awa))).toBeCloseTo(
          normalizeSigned(deg(awa + sailAngle)),
          12,
        );
      }
    }
  });

  /**
   * The sign says which face the flow strikes, not whether the trim is any
   * good: a well-trimmed sail runs positive on starboard tack and negative on
   * port, and both are drawing perfectly.
   */
  it("gives the same magnitude on both tacks for a mirrored trim", () => {
    expect(radiansToDegrees(angleOfAttack(deg(-15), wind(30)))).toBeCloseTo(15, 10);
    expect(radiansToDegrees(angleOfAttack(deg(15), wind(-30)))).toBeCloseTo(-15, 10);
  });

  it("matches hand-worked cases", () => {
    // Close hauled on starboard, main eased 15° to leeward.
    expect(radiansToDegrees(angleOfAttack(deg(-15), wind(30)))).toBeCloseTo(15, 10);
    // Beam reach, main eased 60°: the sail sits at 30° to the flow.
    expect(radiansToDegrees(angleOfAttack(deg(-60), wind(90)))).toBeCloseTo(30, 10);
    // Dead run, boom against the shrouds: square to the wind, on the far side
    // of the wrap.
    expect(radiansToDegrees(angleOfAttack(deg(90), wind(180)))).toBeCloseTo(-90, 10);
  });
});

describe("force assembly (DESIGN.md §3.2)", () => {
  /**
   * The case the module's comment works through: AWA +30°, main eased 15° to
   * port, α = +15°. Lift comes out bearing 300° — forward and to port — and
   * drag bearing 210°, netting ≈ 0.48·qA of drive.
   */
  it("drives forward close hauled on starboard tack", () => {
    const cl = attachedCl(15);
    const cd = attachedCd(15);
    expect(cl).toBeCloseTo(1.165, 3);
    expect(cd).toBeCloseTo(0.1189, 4);

    const force = driving(-15, wind(30));
    expect(force).toBeCloseTo(expectedDriving(cl, cd, 30), 9);
    expect(force / (dynamicPressure(BREEZE) * MAIN.area)).toBeCloseTo(0.48, 2);
    expect(force).toBeCloseTo(116.5, 1);
  });

  /** Past stall the plate limb stands alone, and it is what makes a run work. */
  it("is pure drag square to the wind on a dead run", () => {
    const force = driving(90, wind(-180));
    expect(angleOfAttack(deg(90), wind(-180))).toBeCloseTo(deg(-90), 10);
    expect(force).toBeCloseTo(expectedDriving(plateCl(-90), plateCd(-90), -180), 9);
    expect(force / (dynamicPressure(BREEZE) * MAIN.area)).toBeCloseTo(2.02, 6);
  });

  it("scales with the square of the apparent wind speed", () => {
    expect(driving(-15, wind(30, 12))).toBeCloseTo(4 * driving(-15, wind(30, 6)), 9);
  });

  it("has no force at all in a flat calm", () => {
    for (const sailAngle of [-90, -45, 0, 45, 90]) {
      expect(Math.abs(driving(sailAngle, wind(30, 0)))).toBe(0);
    }
  });

  it("charges the jib's own area and aspect ratio", () => {
    // Same trim, same α — so what differs is the sail: a third less area, and
    // a slightly higher aspect ratio, which `foil.ts` takes as a parameter.
    const jib = sailForce(JIB, deg(-15), wind(30));
    expect(jib.angleOfAttack).toBeCloseTo(deg(15), 10);
    expect(jib.driving).toBeCloseTo(
      expectedDriving(attachedCl(15, JIB.aspectRatio), attachedCd(15, JIB.aspectRatio), 30, JIB),
      9,
    );
    expect(jib.driving).toBeGreaterThan(0);
    expect(jib.driving).toBeLessThan(driving(-15, wind(30)));
  });
});

describe("acceptance: drive is positive outside the no-go zone", () => {
  /**
   * The boat is at rest here, so the apparent wind *is* the true wind and the
   * apparent wind angle is the point of sail. Once `simulation.ts` exists
   * (pos-fo1.3) the wind draws forward, which only tightens the trims — it does
   * not change the sign of anything below.
   */
  it("finds a trim that drives forward from a close reach to a dead run", () => {
    for (let twa = 40; twa <= 180; twa += 5) {
      for (const tack of [1, -1]) {
        const apparent = wind(tack * twa);
        const best = optimalTrim(MAIN, apparent);
        expect(best.driving).toBeGreaterThan(0);
        expect(driving(radiansToDegrees(best.angle), apparent)).toBeCloseTo(best.driving, 9);
      }
    }
  });

  /** Head to wind there is nothing to be had, and the module says so. */
  it("reports a non-positive best in irons", () => {
    expect(optimalTrim(MAIN, wind(0)).driving).toBeLessThanOrEqual(0);
  });
});

describe("acceptance: drive goes negative when a sail is backed (DESIGN.md §3.4)", () => {
  /**
   * The boom held out on the *windward* side, which is a state a hand is
   * holding rather than a trim. The last case is the mooring departure itself:
   * lying head to wind, boom pushed square across, the boat gathers sternway.
   */
  const backed: [awa: number, sailAngle: number][] = [
    [0, 90],
    [15, 75],
    [30, 45],
    [60, 60],
    [90, 60],
  ];

  it("pushes the boat backwards", () => {
    for (const [awa, sailAngle] of backed) {
      expect(driving(sailAngle, wind(awa))).toBeLessThan(0);
      // And the mirror of it, on the other tack.
      expect(driving(-sailAngle, wind(-awa))).toBeLessThan(0);
    }
  });

  /**
   * A backed sail sits at a large |α|, so it must be *fully drawing* — in
   * reverse. Zeroing its force would take the mooring departure with it, which
   * is why §3.3's thresholds are magnitudes.
   */
  it("leaves a backed sail fully drawing", () => {
    for (const [awa, sailAngle] of backed) {
      expect(sailForce(MAIN, deg(sailAngle), wind(awa)).luffFraction).toBe(0);
    }
  });
});

describe("acceptance: luff fraction moves smoothly from 0 to 1 (DESIGN.md §3.3)", () => {
  const collapsed = radiansToDegrees(LUFF.collapsedBelow);
  const drawing = radiansToDegrees(LUFF.drawingAbove);

  it("is wholly collapsed at zero incidence and wholly full past the threshold", () => {
    expect(luffFraction(0)).toBe(1);
    expect(luffFraction(deg(collapsed))).toBe(1);
    expect(luffFraction(deg(drawing))).toBe(0);
    expect(luffFraction(deg(15))).toBe(0);
    expect(luffFraction(deg(90))).toBe(0);
  });

  it("passes through the middle of the transition halfway across", () => {
    expect(luffFraction(deg((collapsed + drawing) / 2))).toBeCloseTo(0.5, 12);
  });

  it("falls monotonically with |α|", () => {
    let previous = luffFraction(0);
    for (let degrees = 0; degrees <= 180; degrees += 0.05) {
      const current = luffFraction(deg(degrees));
      expect(current).toBeLessThanOrEqual(previous + 1e-15);
      previous = current;
    }
  });

  /**
   * Swept finely enough that a discontinuity cannot hide between samples. The
   * bound is set by what a *failure* looks like, not by the true slope: the
   * transition is 5° wide, so a hard threshold would jump the full 1.0 in a
   * single step — two and a half orders of magnitude past this.
   */
  it("is continuous across the whole range", () => {
    let previous = luffFraction(deg(-180));
    let worst = 0;
    for (let degrees = -180; degrees <= 180; degrees += 0.01) {
      const current = luffFraction(deg(degrees));
      worst = Math.max(worst, Math.abs(current - previous));
      previous = current;
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("scales the force it reduces", () => {
    // Mid-transition the sail carries half its load, and the reduction applies
    // to the whole force rather than to lift alone.
    const alpha = (collapsed + drawing) / 2;
    const awa = 45;
    const force = driving(alpha - awa, wind(awa));
    expect(force).toBeCloseTo(expectedDriving(attachedCl(alpha), attachedCd(alpha), awa) * 0.5, 9);
  });
});

describe("mirror symmetry (DESIGN.md §3.3)", () => {
  /**
   * The test that would have caught the bug §3.3's original wording invited.
   * Keying the luff to *signed* α — drawing above +2°, luffing below −5° —
   * reads fine until you mirror it: `foil.ts` is odd in α, so port tack runs
   * negative α throughout and the whole tack would luff exactly where starboard
   * draws. Folding the thresholds about zero is what makes this pass.
   */
  it("gives the two tacks the same forces and the mirrored trims", () => {
    for (let awa = 5; awa <= 175; awa += 5) {
      for (let sailAngle = -90; sailAngle <= 90; sailAngle += 15) {
        const starboard = sailForce(MAIN, deg(sailAngle), wind(awa));
        const port = sailForce(MAIN, deg(-sailAngle), wind(-awa));

        expect(port.driving).toBeCloseTo(starboard.driving, 9);
        expect(port.luffFraction).toBeCloseTo(starboard.luffFraction, 12);
        // Equal and opposite, compared across the seam: `normalizeSigned` folds
        // exactly −180° onto +180°, so a mirrored pair there sums to a turn
        // rather than to zero.
        expect(normalizeSigned(port.angleOfAttack + starboard.angleOfAttack)).toBeCloseTo(0, 12);
      }
    }
  });

  it("mirrors the optimal trim too", () => {
    // Dead downwind is left out on purpose: there the two mirrored trims are an
    // exact tie, so which one the search returns is a coin toss it settles
    // deterministically rather than symmetrically.
    for (let awa = 5; awa <= 175; awa += 5) {
      const starboard = optimalTrim(MAIN, wind(awa));
      const port = optimalTrim(MAIN, wind(-awa));

      expect(port.angle).toBeCloseTo(-starboard.angle, 9);
      expect(port.driving).toBeCloseTo(starboard.driving, 9);
    }
  });
});

describe("optimal trim (DESIGN.md §3.2)", () => {
  /** What the search is checked against: every legal trim, at 0.01°. */
  function bruteForceOptimum(apparent: ApparentWind): { angle: Radians; driving: number } {
    let bestAngle = -SWING_LIMIT;
    let bestDriving = -Infinity;
    for (let degrees = -SWING_LIMIT_DEGREES; degrees <= SWING_LIMIT_DEGREES; degrees += 0.01) {
      const force = driving(degrees, apparent);
      if (force > bestDriving) {
        bestDriving = force;
        bestAngle = deg(degrees);
      }
    }
    return { angle: bestAngle, driving: bestDriving };
  }

  /**
   * The acceptance criterion. Agreement is asserted in *driving force* as well
   * as in angle: near a run the optimum is flat, so an angle-only comparison
   * would fail on a difference the boat cannot feel.
   */
  it("lands within a degree of an exhaustive search", () => {
    for (const awa of [-150, -120, -90, -70, -45, -20, 20, 45, 70, 90, 120, 150]) {
      const apparent = wind(awa);
      const found = optimalTrim(MAIN, apparent);
      const brute = bruteForceOptimum(apparent);

      // The criterion is "within a degree"; the search in fact lands inside a
      // sixth of one, which is the half-step its final refinement leaves.
      expect(Math.abs(radiansToDegrees(found.angle - brute.angle))).toBeLessThan(1);
      expect(Math.abs(found.driving / brute.driving - 1)).toBeLessThan(1e-3);
    }
  });

  it("finds nothing better than an exhaustive search on a run either", () => {
    for (const awa of [175, 180, -175]) {
      const found = optimalTrim(MAIN, wind(awa));
      const brute = bruteForceOptimum(wind(awa));
      expect(Math.abs(radiansToDegrees(found.angle - brute.angle))).toBeLessThan(1);
      expect(Math.abs(found.driving / brute.driving - 1)).toBeLessThan(1e-3);
    }
  });

  /**
   * Hand-worked: on a beam reach the drag term drops out entirely — it acts
   * dead abeam — so the best trim is simply the one with the most lift, which
   * `tuning.ts` puts at α ≈ 19.7° and Cl ≈ 1.46.
   */
  it("trims for peak lift on a beam reach", () => {
    const best = optimalTrim(MAIN, wind(90));
    expect(radiansToDegrees(best.angle)).toBeCloseTo(-70.3, 0);

    const alpha = radiansToDegrees(angleOfAttack(best.angle, wind(90)));
    expect(alpha).toBeCloseTo(19.7, 0);
    expect(best.driving / (dynamicPressure(BREEZE) * MAIN.area)).toBeCloseTo(1.461, 2);
  });

  /**
   * On a dead run there is no lift to be had at any trim, so the optimum runs
   * to the widest ease the shrouds allow and the drive is pure drag.
   */
  it("pins to the swing limit on a dead run", () => {
    const best = optimalTrim(MAIN, wind(180));
    expect(Math.abs(best.angle)).toBeCloseTo(SWING_LIMIT, 12);
    expect(Math.abs(angleOfAttack(best.angle, wind(180)))).toBeCloseTo(deg(90), 12);
    expect(best.driving / (dynamicPressure(BREEZE) * MAIN.area)).toBeCloseTo(2.02, 6);
  });

  it("stays inside the legal range at every point of sail", () => {
    for (let awa = -180; awa <= 180; awa += 3) {
      expect(Math.abs(optimalTrim(MAIN, wind(awa)).angle)).toBeLessThanOrEqual(SWING_LIMIT + 1e-12);
    }
  });

  it("returns zero force in a flat calm rather than diverging", () => {
    const best = optimalTrim(MAIN, wind(45, 0));
    expect(best.driving).toBe(0);
    expect(Math.abs(best.angle)).toBeLessThanOrEqual(SWING_LIMIT);
  });
});

describe("the rig as a whole", () => {
  const trim = { mainAngle: deg(-15), jibAngle: deg(-20), jibSet: true };

  it("sums the two sails", () => {
    const rig = rigForce(trim, wind(30));
    expect(rig.jib).not.toBeNull();
    expect(rig.driving).toBeCloseTo(rig.main.driving + (rig.jib?.driving ?? NaN), 12);
    expect(rig.main.driving).toBeCloseTo(driving(-15, wind(30)), 12);
    expect(rig.jib?.driving).toBeCloseTo(sailForce(JIB, deg(-20), wind(30)).driving, 12);
  });

  it("drops the jib entirely when it is struck (§3.7)", () => {
    const rig = rigForce({ ...trim, jibSet: false }, wind(30));
    expect(rig.jib).toBeNull();
    expect(rig.driving).toBe(rig.main.driving);
    expect(rig.driving).toBeCloseTo(driving(-15, wind(30)), 12);
  });

  /** The main is about twice the jib — 118.6 sq ft against 56.5. */
  it("lets the main dominate roughly two to one", () => {
    const rig = rigForce({ ...trim, jibAngle: trim.mainAngle }, wind(30));
    const ratio = rig.main.driving / (rig.jib?.driving ?? NaN);
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.3);
  });
});

describe("dynamic pressure", () => {
  it("is ½ρV² at sea-level air density", () => {
    expect(dynamicPressure(6)).toBeCloseTo(0.5 * 1.225 * 36, 12);
    expect(dynamicPressure(0)).toBe(0);
  });
});
