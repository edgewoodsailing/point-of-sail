import { describe, expect, it } from "vitest";

import { HULL } from "./boat.ts";
import {
  EFFECTIVE_MASS,
  hullResistance,
  hullResistanceSlope,
  keelInducedDrag,
} from "./hull.ts";
import { ACCELERATION, RESISTANCE } from "./tuning.ts";
import type { MetersPerSecond, Newtons, Seconds } from "./units.ts";

/** ≈ 2.90 m/s. */
const V_HULL = HULL.hullSpeed;

/**
 * §3.5's curve, written out from the design document rather than shared with the
 * implementation, so that a typo in `hull.ts` cannot agree with itself.
 *
 * The exponent is spelled out here rather than imported for that reason, so it
 * has to be edited by hand when the design document's exponent moves — pos-lcz
 * took it from 6 to 4. That is the cost of the independence and it is worth
 * paying: an exponent read from `hull.ts` would make this test agree with any
 * value that file happened to hold.
 */
function designCurve(speed: MetersPerSecond): Newtons {
  return (
    RESISTANCE.quadratic * speed ** 2 +
    RESISTANCE.hullSpeedWall * speed ** 2 * (speed / V_HULL) ** 4
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
    // What has to hold is that the wall is a *hull-speed* phenomenon and not a
    // general drag — a boat pottering at half hull speed should be paying the
    // quadratic term and essentially nothing else.
    //
    // pos-lcz moved this from 2% to 5%, and the widening is the change rather
    // than a slackening: at half hull speed the wall factor is 2^-n, so
    // softening the exponent from 6 to 4 multiplies the wall's contribution
    // there by four and this share by very nearly as much, 1.24% to 4.66%
    // (`hullSpeedWall` came down slightly at the same time, which is the rest
    // of the difference). That is the definition of a softer wall — the same total
    // resistance spread further down the speed range — and it is the cost §3.5
    // records for holding the pointing angle together across 6–14 kt. The bound
    // tracks the shape; what it still forbids is the wall leaking into ordinary
    // sailing, which 5% does not.
    const half = V_HULL / 2;
    const wallShare = 1 - (RESISTANCE.quadratic * half ** 2) / hullResistance(half);
    expect(wallShare).toBeLessThan(0.05);
  });

  it("has doubled the resistance by hull speed", () => {
    // Which is what makes `hullSpeedWall` readable as "the extra resistance at
    // hull speed": the wall factor is exactly 1 there, at any exponent.
    expect(hullResistance(V_HULL)).toBeCloseTo(
      (RESISTANCE.quadratic + RESISTANCE.hullSpeedWall) * V_HULL ** 2,
      9,
    );
  });

  it("makes the last fraction of a knot cost far more than a quadratic hull would", () => {
    // 20% more speed. A purely quadratic hull would charge 1.2² = 1.44× for it;
    // this one charges 2.12×, which is the wall the boat cannot sail through
    // however much sail area it carries.
    //
    // This bound has come down twice, and both times because the wall became a
    // smaller share of the whole rather than because the test got tired.
    // pos-fo1.4 raised the quadratic term by a quarter and left the wall alone,
    // taking the ratio from 2.9 to 2.7; pos-lcz softened the exponent from 6 to
    // 4, taking it to 2.12. What has to hold is that the last knot costs much
    // more than a quadratic hull would charge — it still costs 47% more — not
    // that the coefficients keep any particular proportion.
    //
    // It is worth knowing that this is the assertion which would notice the
    // wall being softened *again*. §3.5 explains why it should not be: the
    // exponent trades the high-wind speed against the pointing angle, and the
    // pointing side of that trade is already at its bound in `calibration.test.ts`.
    const ratio = hullResistance(1.2 * V_HULL) / hullResistance(V_HULL);
    expect(ratio).toBeGreaterThan(2.0);
    expect(ratio / 1.44).toBeGreaterThan(1.4);
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

describe("the keel's induced drag (DESIGN.md §3.5)", () => {
  /** The far-field limb the design document writes down, on its own. */
  function unstalled(speed: MetersPerSecond, sideForce: Newtons): Newtons {
    return (RESISTANCE.sideForce * sideForce ** 2) / speed ** 2;
  }

  /** A side force in the range the rig actually makes close hauled. */
  const LOADED: Newtons = 680;

  it("charges nothing when the sails are making no side force", () => {
    for (const speed of [-2, 0, 0.5, 2, V_HULL]) {
      expect(keelInducedDrag(speed, 0)).toBe(0);
    }
  });

  it("charges nothing at rest, however hard the rig is pulling sideways", () => {
    // The property the whole saturated limb exists for. A drag that survived at
    // zero speed would push a sheeted-in boat backwards out of the no-go zone
    // and then reverse the moment it did, leaving the speed chattering.
    expect(keelInducedDrag(0, LOADED)).toBe(0);
    expect(keelInducedDrag(0, -LOADED)).toBe(0);
  });

  it("opposes the motion, whichever way the boat is going", () => {
    expect(keelInducedDrag(2, LOADED)).toBeGreaterThan(0);
    expect(keelInducedDrag(-2, LOADED)).toBeLessThan(0);
    // And does not care which side the rig is pulling towards: port tack costs
    // exactly what starboard does.
    expect(keelInducedDrag(2, -LOADED)).toBe(keelInducedDrag(2, LOADED));
  });

  it("is the design document's induced drag once the boat is moving", () => {
    // Well clear of the keel's stall the saturation term fades and what is left
    // is `k·F²/v²` — written out here from §3.5 rather than shared with the
    // implementation. It approaches from below and never overshoots, which is
    // what says the stall only ever *reduces* the charge.
    const light: Newtons = 120;
    let previous = 0;

    for (const speed of [3, 4, 6]) {
      const share = keelInducedDrag(speed, light) / unstalled(speed, light);
      expect(share, `${speed} m/s`).toBeGreaterThan(0.98);
      expect(share, `${speed} m/s`).toBeLessThanOrEqual(1);
      expect(share, `${speed} m/s`).toBeGreaterThan(previous);
      previous = share;
    }
  });

  it("never charges more than the keel can hold", () => {
    // `keelStall` read literally: the drag can reach that fraction of the side
    // force and no more, at any speed and any load.
    for (const load of [50, 200, LOADED, 2000]) {
      for (let speed = 0; speed <= 8; speed += 0.05) {
        expect(keelInducedDrag(speed, load) / load, `${load} N at ${speed} m/s`).toBeLessThanOrEqual(
          RESISTANCE.keelStall + 1e-12,
        );
      }
    }
  });

  it("reaches that ceiling exactly where the two limbs cross", () => {
    // Which is what makes the constant readable. The crossing is at
    // `v² = k·F/(2·keelStall)`, and the peak of the blend sits on it.
    const saturation = (RESISTANCE.sideForce * LOADED) / (2 * RESISTANCE.keelStall);
    const speed = Math.sqrt(saturation);

    expect(keelInducedDrag(speed, LOADED)).toBeCloseTo(RESISTANCE.keelStall * LOADED, 9);
  });

  it("changes the sign of its slope at the stall, which is why it is taken explicitly", () => {
    // The reason `simulation.ts` keeps this term out of the linearised
    // denominator. It is not that the slope is negative — it is that the slope
    // is *both*: the drag climbs to the ceiling above and falls away after it,
    // so a boat below the keel's stall stiffens with speed and one above it
    // softens. Both halves are ordinary sailing, close hauled and reaching
    // respectively, so there is no regime the term could be safely folded into
    // a denominator that must stay positive.
    const h = 1e-6;
    const slopeAt = (speed: MetersPerSecond, load: Newtons) =>
      (keelInducedDrag(speed + h, load) - keelInducedDrag(speed - h, load)) / (2 * h);

    const peak = Math.sqrt((RESISTANCE.sideForce * LOADED) / (2 * RESISTANCE.keelStall));
    expect(slopeAt(peak / 2, LOADED)).toBeGreaterThan(0);
    expect(slopeAt(peak * 2, LOADED)).toBeLessThan(0);
  });

  it("stays gently sloped, which is what makes leaving it explicit safe", () => {
    // Omitting a term from the denominator costs whatever damping it would have
    // added, and that is only negligible if its slope is small next to the mass
    // over a step. Measured at `MAX_STEP` rather than at a frame: 0.1 s is the
    // longest step the clamp allows, and it is also the step `settle` runs at,
    // so a bound taken at 60 Hz would understate the worst case sixfold.
    //
    // The peak slope grows as the square root of the load — the ceiling rises
    // with `F` while the speed it is reached at rises with `√F` — so which
    // loads are sampled matters. 5000 N is far past anything a Rhodes 19's rig
    // makes in a wind a student would set, and it comes to 0.026.
    const dt: Seconds = 0.1;
    const h = 1e-6;
    let steepest = 0;

    for (const load of [50, 200, LOADED, 2000, 5000]) {
      for (let speed = 0.01; speed <= 8; speed += 0.01) {
        const slope =
          (keelInducedDrag(speed + h, load) - keelInducedDrag(speed - h, load)) / (2 * h);
        steepest = Math.max(steepest, Math.abs(slope));
      }
    }

    expect((steepest * dt) / EFFECTIVE_MASS).toBeLessThan(0.05);
  });
});

describe("effective mass (DESIGN.md §3.5)", () => {
  it("lands near the boat, crew and added mass the design document reasons out", () => {
    // §3.5 arrives at ≈ 880 kg by adding up a 601 kg boat, two crew and ~15%
    // added mass; this module gets there from the acceleration lag instead.
    //
    // The mass is proportional to the resistance coefficient, so a pinned value
    // here would be a pinned `RESISTANCE.quadratic` in disguise — and pos-fo1.4
    // moved that. Hence a band wide enough to calibrate inside, which still
    // catches a tuning pass that has produced a barge or a dinghy, over a
    // closed form written out independently of `hull.ts`.
    //
    // Calibration spent about half the headroom: the two routes agreed to
    // within 1% before that pass and differ by 24% after it, at ≈ 1092 kg. The
    // band stays where pos-fo1.3 put it. Its job is to make the next pass that
    // needs more room say so out loud — the answer then is to argue about the
    // band or to shorten the lag `ACCELERATION.timeToTerminal`, which is what
    // the mass is derived through, not to widen this quietly.
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
