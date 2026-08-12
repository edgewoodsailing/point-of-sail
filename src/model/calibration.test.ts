import { describe, expect, it } from "vitest";

import { JIB, MAIN } from "./boat.ts";
import { optimalTrim } from "./sail.ts";
import type { SimState } from "./simulation.ts";
import { settle } from "./simulation.ts";
import type { Knots, Radians } from "./units.ts";
import {
  cos,
  degreesToRadians,
  knotsToMetersPerSecond,
  metersPerSecondToKnots,
} from "./units.ts";
import { apparentWind } from "./wind.ts";

/**
 * The polar of DESIGN.md §3.6, locked in (pos-fo1.4).
 *
 * This file is the reason `tuning.ts` exists. Every other test in the model
 * checks that a piece computes what it says it computes; these check that the
 * pieces together make a boat that sails like a Rhodes 19, which is the only
 * question the constants in `tuning.ts` have an answer to. Break one of these
 * and the fix is a tuning pass, not a bug hunt.
 *
 * **They are meant to be sensitive.** The §3.6 targets are quoted to about 10%,
 * so that is the band, and the model sits inside it with a couple of percent to
 * spare at the tightest point. That is deliberate: a constant nudged carelessly
 * — the plate's normal force, the hull's quadratic term, the side-force
 * coefficient — will fail something here rather than drift quietly.
 *
 * **Where the model does not reach the table, and why.** The broad reach comes
 * in about 7% light, and that one is structural rather than a matter of turning
 * something harder. §3.6 puts a beam reach and a broad reach 0.2 kt apart while
 * the driving force at 135° is barely half what it is at 90°, which needs a
 * resistance curve going as `v¹⁰`; §3.5's is a square under a sixth power and
 * tops out at `v⁸`. Both figures are inside the quoted tolerance, so the model
 * is calibrated, but no amount of further tuning closes that particular gap —
 * it would take a different resistance curve.
 */

const deg = degreesToRadians;
const kt = knotsToMetersPerSecond;

/** The wind the §3.6 table is quoted in. */
const WIND_SPEED = kt(10);

/** How far from the table a figure may land: §3.6 quotes "roughly these marks". */
const TOLERANCE = 0.1;

/** A boat heading north with the true wind `twa` off the bow, at rest or moving. */
function boat(twa: Radians, jibSet: boolean, speed = 0, wind = WIND_SPEED): SimState {
  return {
    wind: { from: twa, speed: wind },
    motion: { heading: 0, speed },
    trim: { mainAngle: 0, jibAngle: 0, jibSet },
    mainHeld: false,
    jibHeld: false,
  };
}

/**
 * The boat sailed properly at this angle: both sails at the trim that extracts
 * the most drive from the wind it will actually feel once it is up to speed.
 *
 * Iterated, because the trim and the speed determine each other — the apparent
 * wind draws forward as the boat accelerates, so trimming for a standstill
 * leaves it badly overeased. The iteration **carries the speed forward** from
 * pass to pass rather than restarting from rest, which is a sailor getting
 * going and then trimming rather than setting the sails and hoping. The two
 * agree here, and one of the tests below insists on it; they have not always,
 * and the day they diverge again this helper is measuring the branch a polar
 * means.
 */
function wellTrimmed(twa: Radians, jibSet = true, from = 0, wind = WIND_SPEED): SimState {
  let state = boat(twa, jibSet, from, wind);

  for (let pass = 0; pass < 8; pass += 1) {
    const settled = settle(state);
    const apparent = apparentWind(state.wind, settled.motion);
    state = {
      ...state,
      motion: settled.motion,
      trim: {
        ...state.trim,
        mainAngle: optimalTrim(MAIN, apparent).angle,
        jibAngle: optimalTrim(JIB, apparent).angle,
      },
    };
  }

  return state;
}

/**
 * The steady speed at this true wind angle, in knots.
 *
 * Memoised, because settling a polar is not cheap — each call is eight `settle`
 * runs and each of those is a few hundred frames — and the sweeps below revisit
 * the same angles from both directions. Without it the smoothness sweep alone
 * spends half of vitest's default per-test timeout, and a slower machine starts
 * failing on the clock rather than on the physics.
 */
const cache = new Map<string, Knots>();

function speedAt(twaDegrees: number, jibSet = true, from = 0, wind = WIND_SPEED): Knots {
  const key = `${twaDegrees}|${jibSet}|${from}|${wind}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const speed = metersPerSecondToKnots(
    settle(wellTrimmed(deg(twaDegrees), jibSet, from, wind)).motion.speed,
  );
  cache.set(key, speed);
  return speed;
}

/** Progress made straight upwind: the number that decides how high to point. */
function upwindVmg(twaDegrees: number): Knots {
  return speedAt(twaDegrees) * cos(deg(twaDegrees));
}

/** DESIGN.md §3.6, sloop column, in 10 kt true. */
const POLAR: { point: string; twa: number; knots: Knots }[] = [
  { point: "head to wind", twa: 0, knots: 0 },
  { point: "close hauled", twa: 45, knots: 4.2 },
  { point: "beam reach", twa: 90, knots: 5.4 },
  { point: "broad reach", twa: 135, knots: 5.2 },
  { point: "run", twa: 180, knots: 3.5 },
];

describe("the calibration table (DESIGN.md §3.6)", () => {
  it.each(POLAR)("makes $knots kt on a $point ($twa°)", ({ twa, knots }) => {
    const speed = speedAt(twa);

    if (knots === 0) {
      // In irons is not "slow", it is stopped: head to wind the best trim is
      // inside `LUFF.collapsedBelow` and no sail carries any force at all, so
      // a boat that starts at rest never leaves it. Asserted from rest rather
      // than from way on, because a boat *carrying* speed head to wind is
      // asking a different question — how it comes to a stop — and `settle`
      // documents itself as unable to answer that one exactly: with no wind
      // force to balance, a coasting boat decays like 1/t and the iteration
      // runs out of budget at a few hundredths of a knot.
      expect(speed).toBe(0);
      return;
    }

    expect(Math.abs(speed - knots) / knots).toBeLessThan(TOLERANCE);
  });

  it("sails the same polar on either tack", () => {
    // The model is odd in the wind angle everywhere it should be, so this
    // should hold exactly rather than approximately. It catches a sign error in
    // the one place a sign error would otherwise look like a plausible boat.
    for (const twa of [15, 45, 90, 135, 175]) {
      expect(speedAt(-twa), `TWA ${twa}°`).toBeCloseTo(speedAt(twa), 9);
    }
  });
});

describe("the shape of the polar (DESIGN.md §3.6)", () => {
  it("is fastest on a reach, not upwind and not downwind", () => {
    // "Beam reach fastest" — the first of the three things §3.6 says matter
    // qualitatively. Asserted over the whole quarter rather than at 90° alone,
    // because the peak of a real polar is a broad plateau and lands wherever
    // the apparent wind puts it, which here is 95°.
    let fastest = 0;
    let fastestAt = 0;
    for (let twa = 0; twa <= 180; twa += 5) {
      const speed = speedAt(twa);
      if (speed > fastest) {
        fastest = speed;
        fastestAt = twa;
      }
    }

    expect(fastestAt).toBeGreaterThanOrEqual(75);
    expect(fastestAt).toBeLessThanOrEqual(110);
  });

  it("runs notably slower than it reaches", () => {
    // The second: a run has to be *visibly* the slow point of sail, not merely
    // a little off the pace. §3.6's own figures put it a third down on a beam
    // reach; before pos-fo1.4 the model had it 21% down, which read as "the
    // boat goes about the same speed everywhere" and taught nothing.
    expect(speedAt(180)).toBeLessThan(0.75 * speedAt(90));
  });

  it("falls away smoothly rather than stepping", () => {
    // No cliffs in the range the boat is actually sailing: turning it a degree
    // must not lose it a large fraction of its speed. A genuine step would mean
    // the optimal trim had jumped between two peaks and taken the polar with
    // it, which is what a stalling sail invites and what this would catch.
    //
    // Two bounds, because one part of the range legitimately needs more room.
    // Past about 140° the boom is on the shrouds and the main cannot be eased
    // enough to hold attached flow, so bearing away stalls it — and the stall
    // feeds itself, since a slower boat sees its apparent wind draw further
    // aft. The boat loses about three quarters of a knot over those ten
    // degrees. That is a real effect of a real rig, not an artefact, but it is
    // steeper than anywhere else on the polar and it is fenced off here rather
    // than averaged into a bound loose enough to hide a cliff elsewhere.
    const DEEP_REACH = (twa: number) => twa >= 138 && twa <= 148;

    for (let twa = 10; twa < 180; twa += 1) {
      const drop = Math.abs(speedAt(twa + 1) - speedAt(twa));
      const allowed = DEEP_REACH(twa) ? 0.4 : 0.2;
      expect(drop, `TWA ${twa}° → ${twa + 1}°`).toBeLessThan(allowed);
    }

    // And the deep reach loses its speed once, on the way down, rather than
    // hunting: no degree of it gains speed back.
    for (let twa = 136; twa < 152; twa += 1) {
      expect(speedAt(twa + 1), `TWA ${twa}° → ${twa + 1}°`).toBeLessThan(speedAt(twa) + 1e-9);
    }
  });

  it("leaves the no-go zone through a cusp, and a small one", () => {
    // The one place the polar genuinely is not smooth, fenced off from the
    // sweep above and asserted here so that it is described rather than
    // skipped. The edge of the no-go zone is where the drive at rest crosses
    // zero, and just outside it a drive rising linearly with the wind angle is
    // balanced against a drag rising with the square of the speed — so the
    // speed leaves zero like a square root, with an infinite slope that no
    // bound per degree could survive. It shows up as a quarter of a knot
    // appearing between 4° and 5°.
    //
    // What matters is that it is a cusp and not a step: the boat leaves the
    // no-go zone at a speed that is nothing, so there is no moment where it
    // lurches into motion. Inside the zone it is stopped to within a rounding
    // error of a knot, and the first speed on the far side is smaller than the
    // width of the speed arrow will be able to show.
    for (let twa = 0; twa <= 5; twa += 1) {
      expect(Math.abs(speedAt(twa)), `TWA ${twa}°`).toBeLessThan(0.3);
    }
    expect(speedAt(6)).toBeLessThan(0.5);
  });

  it("does not depend on how the boat got there", () => {
    // A polar is a property of the boat, not of its history. This can fail:
    // with a sharper stall the model was bistable across the whole reaching
    // quarter — at TWA 120, 3.7 kt from rest against 5.1 kt at the same trim
    // once moving — because the trim that suits the apparent wind at speed is
    // stalled at the apparent wind at rest, and the boat could not climb out.
    // `FOIL.stallBlendWidth` is what fixed it, and this is what would notice it
    // coming back.
    for (let twa = 10; twa <= 180; twa += 10) {
      expect(speedAt(twa), `TWA ${twa}°`).toBeCloseTo(speedAt(twa, true, kt(8)), 6);
    }
  });
});

describe("the no-go zone (DESIGN.md §3.6)", () => {
  /**
   * The third thing §3.6 says matters, and the one the model had most wrong:
   * "a no-go zone that simply *is* rather than being drawn on". Nothing here
   * draws it, forbids it, or special-cases it. It falls out of the keel being
   * charged for the side force the sails make — which is most of the rig's
   * force when the wind is anywhere near the bow, and which the boat is least
   * able to pay for when it is going slowly.
   */
  it("puts the closest useful angle at about 45°", () => {
    // The table's last row, read the way a sailor would: the angle that makes
    // the most progress straight upwind. Before pos-fo1.4 this sat at 30-35°,
    // which is a boat that points like nothing afloat.
    let best = 0;
    let bestAt = 0;
    for (let twa = 20; twa <= 70; twa += 1) {
      const vmg = upwindVmg(twa);
      if (vmg > best) {
        best = vmg;
        bestAt = twa;
      }
    }

    expect(bestAt).toBeGreaterThanOrEqual(40);
    expect(bestAt).toBeLessThanOrEqual(50);
  });

  it("gets nowhere useful inside it", () => {
    // Not "goes slowly" but "does not get there": twenty degrees off the wind
    // the boat makes well under half its reaching speed, and the progress it
    // makes to windward is worse than simply bearing away to 45° would be.
    expect(speedAt(20)).toBeLessThan(0.45 * speedAt(90));
    expect(upwindVmg(15)).toBeLessThan(0.6 * upwindVmg(45));
    expect(upwindVmg(30)).toBeLessThan(upwindVmg(45));
  });

  it("holds the boat still head to wind, whichever way the sails are set", () => {
    // Covered from the integrator's side in `simulation.test.ts`; asserted here
    // too because it is a row of the table.
    expect(speedAt(0)).toBe(0);
    expect(speedAt(0, false)).toBe(0);
  });
});

/**
 * Everything above is 10 kt, because that is the only wind §3.6 quotes. §2.1
 * opens the simulator anywhere in **6–14 kt**, though, and §5's slider has no
 * stated ceiling — so the lessons the table exists to protect have to survive a
 * range the table says nothing about, and it is worth knowing how well.
 *
 * They weaken with the wind, in one direction and for one reason. The keel's
 * charge for side force falls away as the boat speeds up — that is the `1/v²`
 * in it, and it is what a real keel does — but §3.5's hull wall is not sharp
 * enough to hold the speed down in reply, so above about 12 kt the boat gets
 * fast and its keel gets cheap together. Measured, well trimmed, at the best
 * upwind VMG angle and the run/beam ratio:
 *
 * ```text
 * wind      4     6     8    10    12    14    16    20    30
 * angle    49°   49°   47°   44°   41°   39°   37°   34°   30°
 * run/beam 0.52  0.55  0.62  0.68  0.74  0.78  0.81  0.85  0.89
 * ```
 *
 * Inside 6–14 kt this is defensible and largely real: boats do point higher and
 * do close the reach-to-run gap as the breeze fills in, since a displacement
 * hull runs into its wall on both points of sail. Past it the model drifts off
 * what a Rhodes 19 would do — 34° of pointing in 20 kt is nothing afloat, and
 * it goes with a beam reach at 7.1 kt, 25% over hull speed, which is the same
 * wall being too soft showing up in the other place.
 *
 * The bounds below are the ones that actually hold across the opening range,
 * not the ones that hold at 10 kt. They are deliberately looser than the 10 kt
 * assertions and are here to say where the calibration stops being calibration,
 * so that nobody reads the 10 kt tests as a claim about the model at large.
 * pos-lcz is the bead for narrowing it, and expects to tighten these.
 */
describe("how far the calibration reaches (DESIGN.md §2.1, §5)", () => {
  /** The wind speeds §2.1 opens on. */
  const OPENING_RANGE = [6, 8, 10, 12, 14];

  function vmgPeak(wind: number): number {
    let best = -Infinity;
    let at = 0;
    for (let twa = 15; twa <= 70; twa += 1) {
      const vmg = speedAt(twa, true, 0, kt(wind)) * cos(deg(twa));
      if (vmg > best) {
        best = vmg;
        at = twa;
      }
    }
    return at;
  }

  it("keeps a reach the fastest point of sail across the opening range", () => {
    // This one survives intact, at every wind tried.
    for (const wind of OPENING_RANGE) {
      const beam = speedAt(90, true, 0, kt(wind));
      expect(beam, `${wind} kt`).toBeGreaterThan(speedAt(45, true, 0, kt(wind)));
      expect(beam, `${wind} kt`).toBeGreaterThan(speedAt(135, true, 0, kt(wind)));
      expect(beam, `${wind} kt`).toBeGreaterThan(speedAt(180, true, 0, kt(wind)));
    }
  });

  it("keeps a run slower than a reach, but less so as the wind fills in", () => {
    // 0.68 at 10 kt against 0.78 at 14 kt. The lesson holds everywhere in the
    // range; how loudly it is taught does not. The 10 kt test asserts 0.75 —
    // this is the honest bound for the range as a whole.
    for (const wind of OPENING_RANGE) {
      const ratio = speedAt(180, true, 0, kt(wind)) / speedAt(90, true, 0, kt(wind));
      expect(ratio, `${wind} kt`).toBeLessThan(0.8);
    }

    // And the direction of the drift, pinned so that it is a known property
    // rather than a surprise: more wind always narrows the gap.
    expect(speedAt(180, true, 0, kt(14)) / speedAt(90, true, 0, kt(14))).toBeGreaterThan(
      speedAt(180, true, 0, kt(6)) / speedAt(90, true, 0, kt(6)),
    );
  });

  it("keeps the closest useful angle in the range a keelboat sails", () => {
    // 49° in 6 kt down to 39° in 14 kt. Wider than the 40–50° the 10 kt test
    // pins, and the widening is monotone in the wind.
    for (const wind of OPENING_RANGE) {
      expect(vmgPeak(wind), `${wind} kt`).toBeGreaterThanOrEqual(35);
      expect(vmgPeak(wind), `${wind} kt`).toBeLessThanOrEqual(55);
    }

    expect(vmgPeak(14)).toBeLessThan(vmgPeak(6));
  });

  it("stays a boat rather than a machine in a wind nobody would sail in", () => {
    // Not a calibration claim — §5's slider has no ceiling, and this is the
    // floor under what happens past the range anyone tuned. The speeds stay
    // finite and bounded, and the boat never sails dead upwind however hard it
    // blows, which is the one lesson that must not break at any wind.
    for (const wind of [20, 30, 45]) {
      expect(speedAt(0, true, 0, kt(wind)), `${wind} kt`).toBe(0);
      expect(speedAt(90, true, 0, kt(wind)), `${wind} kt`).toBeLessThan(12);
      expect(vmgPeak(wind), `${wind} kt`).toBeGreaterThan(20);
    }
  });
});

describe("what the traffic light will divide by (DESIGN.md §4.2)", () => {
  it("makes the most-drive trim also the fastest trim", () => {
    // `optimalTrim` maximises driving force at the apparent wind as it stands,
    // and §4.2 colours the sails against it. Since pos-fo1.4 the boat is also
    // charged for the *side* force a trim makes, so those are no longer the
    // same question, and a student sheeting to the green light could in
    // principle be sailing slower than one who ignored it.
    //
    // They come out together, near enough. Swept over every legal trim at one
    // degree, the fastest settled speed beats the drive-maximising trim by at
    // most 0.015 kt — measured across 4 to 45 kt of wind and the whole range of
    // angles, worst at 5 kt on a close reach. That is not luck: near the
    // optimum the drive is flat, and the side force varies far too gently
    // across that flat top to move the answer. But it is not zero either, so
    // the bound below is set above the largest gap found rather than at the
    // resolution of this sweep, which would be pinning the sampling.
    //
    // Worth pinning because the day it stops being true, §4.2 is lying to the
    // student — sheeting to the green light would be leaving speed behind.
    for (const twa of [30, 45, 60, 90, 135, 180]) {
      let fastest = -Infinity;
      for (let angle = -90; angle <= 90; angle += 1) {
        const swept = settle({
          ...boat(deg(twa), true),
          trim: { mainAngle: deg(angle), jibAngle: deg(angle), jibSet: true },
        });
        fastest = Math.max(fastest, metersPerSecondToKnots(swept.motion.speed));
      }

      expect(speedAt(twa), `TWA ${twa}°`).toBeGreaterThan(fastest - 0.03);
    }
  });
});
