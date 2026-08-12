import { describe, expect, it } from "vitest";

import { HULL } from "./boat.ts";
import { EFFECTIVE_MASS, hullResistance, hullResistanceSlope } from "./hull.ts";
import { ACCELERATION, RESISTANCE } from "./tuning.ts";
import type { MetersPerSecond, Newtons, Seconds } from "./units.ts";

/** ≈ 2.90 m/s. */
const V_HULL = HULL.hullSpeed;

/**
 * §3.5's curve, written out from the design document rather than shared with the
 * implementation, so that a typo in `hull.ts` cannot agree with itself.
 */
function designCurve(speed: MetersPerSecond): Newtons {
  return (
    RESISTANCE.quadratic * speed ** 2 +
    RESISTANCE.hullSpeedWall * speed ** 2 * (speed / V_HULL) ** 6
  );
}

describe("hull resistance (DESIGN.md §3.5)", () => {
  it("is zero at rest", () => {
    expect(hullResistance(0)).toBe(0);
  });

  it("follows the design document's curve going forward", () => {
    for (const speed of [0.25, 1, 2, V_HULL, 3.5, 5]) {
      expect(hullResistance(speed)).toBeCloseTo(designCurve(speed), 9);
    }
  });

  it("opposes the motion, whichever way the boat is moving", () => {
    expect(hullResistance(2)).toBeGreaterThan(0);
    expect(hullResistance(-2)).toBeLessThan(0);
  });

  it("costs the astern factor to go backwards", () => {
    for (const speed of [0.3, 1, 2, V_HULL]) {
      expect(hullResistance(-speed)).toBeCloseTo(-RESISTANCE.asternFactor * designCurve(speed), 9);
    }
  });

  it("rises strictly with speed, both ways", () => {
    let previous = 0;
    for (let speed = 0.1; speed <= 6; speed += 0.1) {
      const resistance = hullResistance(speed);
      expect(resistance).toBeGreaterThan(previous);
      expect(hullResistance(-speed)).toBeLessThan(-previous);
      previous = resistance;
    }
  });
});

describe("the hull-speed wall (DESIGN.md §3.5)", () => {
  it("is barely there at half hull speed", () => {
    const half = V_HULL / 2;
    const wallShare = 1 - (RESISTANCE.quadratic * half ** 2) / hullResistance(half);
    expect(wallShare).toBeLessThan(0.02);
  });

  it("has doubled the resistance by hull speed", () => {
    // Which is what makes `hullSpeedWall` readable as "the extra resistance at
    // hull speed": the sixth-power factor is exactly 1 there.
    expect(hullResistance(V_HULL)).toBeCloseTo(
      (RESISTANCE.quadratic + RESISTANCE.hullSpeedWall) * V_HULL ** 2,
      9,
    );
  });

  it("makes the last fraction of a knot cost far more than a quadratic hull would", () => {
    // 20% more speed. A purely quadratic hull would charge 1.2² = 1.44× for it;
    // this one charges nearly three times as much, which is the wall the boat
    // cannot sail through however much sail area it carries.
    const ratio = hullResistance(1.2 * V_HULL) / hullResistance(V_HULL);
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio / 1.44).toBeGreaterThan(1.9);
  });
});

describe("the resistance slope", () => {
  it("is the derivative of the curve it comes from", () => {
    // Against a central difference, which is independent of how the slope is
    // written — the wall term gathers its powers differently in the two.
    const h = 1e-6;
    for (const speed of [0.4, 1, 2, V_HULL, 3.5, -0.4, -2, -V_HULL]) {
      const numerical = (hullResistance(speed + h) - hullResistance(speed - h)) / (2 * h);
      expect(hullResistanceSlope(speed)).toBeCloseTo(numerical, 4);
    }
  });

  it("never goes negative, whichever way the boat is moving", () => {
    // The integrator divides by `m + slope·dt` and relies on the result staying
    // positive: a negative slope there would let a step run away rather than
    // damp. Both limbs of an even curve slope the same way, so it cannot.
    for (let speed = -6; speed <= 6; speed += 0.25) {
      expect(hullResistanceSlope(speed)).toBeGreaterThanOrEqual(0);
    }
  });

  it("is steeper astern by the same factor the curve is", () => {
    for (const speed of [0.5, 2, V_HULL]) {
      expect(hullResistanceSlope(-speed)).toBeCloseTo(
        RESISTANCE.asternFactor * hullResistanceSlope(speed),
        9,
      );
    }
  });
});

describe("effective mass (DESIGN.md §3.5)", () => {
  it("lands near the boat, crew and added mass the design document reasons out", () => {
    // §3.5 arrives at ≈ 880 kg by adding up a 601 kg boat, two crew and ~15%
    // added mass; this module gets there from the acceleration lag instead. The
    // two agreeing is a check on both.
    //
    // The mass is proportional to the resistance coefficient, so a pinned value
    // here would be a pinned `RESISTANCE.quadratic` in disguise — and pos-fo1.4
    // exists to move that. Hence a band wide enough to calibrate inside, which
    // still catches a tuning pass that has produced a barge or a dinghy, over a
    // closed form written out independently of `hull.ts`.
    expect(EFFECTIVE_MASS).toBeGreaterThan(600);
    expect(EFFECTIVE_MASS).toBeLessThan(1200);
    expect(EFFECTIVE_MASS).toBeCloseTo(
      (ACCELERATION.timeToTerminal * RESISTANCE.quadratic * V_HULL) / Math.atanh(1 - 1 / Math.E),
      9,
    );
  });

  it("delivers the acceleration lag it was derived from", () => {
    // The mapping's own terms: a steady drive whose terminal speed is exactly
    // the reference speed the derivation uses, against the smooth limb of the
    // curve alone. Integrated here at a step far finer than the simulator's, so
    // that what is being checked is the algebra and not the integrator.
    const drive: Newtons = RESISTANCE.quadratic * V_HULL ** 2;
    const dt: Seconds = 1e-4;
    const target = (1 - 1 / Math.E) * V_HULL;

    let speed: MetersPerSecond = 0;
    let elapsed: Seconds = 0;
    while (speed < target && elapsed < 10 * ACCELERATION.timeToTerminal) {
      speed += ((drive - RESISTANCE.quadratic * speed ** 2) / EFFECTIVE_MASS) * dt;
      elapsed += dt;
    }

    expect(elapsed).toBeCloseTo(ACCELERATION.timeToTerminal, 2);
  });
});
