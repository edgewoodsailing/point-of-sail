import { describe, expect, it } from "vitest";

import { HULL, JIB, MAIN } from "./boat.ts";
import { depoweringFactor, optimalTrim } from "./sail.ts";
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
 * in about 9% light, and that one is structural rather than a matter of turning
 * something harder. §3.6 puts a beam reach and a broad reach 0.2 kt apart while
 * the driving force at 135° is barely half what it is at 90°, which needs a
 * resistance curve going as `v¹⁰`; §3.5's is a square under a fourth power and
 * tops out at `v⁶`. Both figures are inside the quoted tolerance, so the model
 * is calibrated, but no amount of further tuning closes that particular gap.
 *
 * **pos-lcz sharpened what "structural" means here, and cost this figure two
 * more points.** It used to read as needing a different resistance *curve*, and
 * a steeper wall does close some of it — at a sixth power the broad reach was
 * 7% light and at a twentieth it is only 1%. What that reading missed is the
 * price: the wall is the model's only wind-scale, so steepening it to buy the
 * broad reach sends the pointing angle through the floor as the breeze fills
 * in. Softening it to hold the pointing, which is what pos-lcz did, spends this
 * figure instead — from 7% to 9% light, against a 10% tolerance.
 *
 * **`pos-d7u` has now landed, and it did not buy this figure back — which is
 * worth recording, because the paragraph above used to say it would.** The
 * hope was that a term acting on the drive rather than on the speed could move
 * a broad reach relative to a beam reach. §3.2's depowering is exactly such a
 * term and it cannot, for the reason that makes it useful everywhere else: it
 * is a single factor multiplying the whole rig, so at any one wind it scales a
 * broad reach and a beam reach by precisely the same amount and their ratio
 * does not move at all. It also sits at 1.000 in 10 kt by construction, so it
 * is not even present in this table.
 *
 * So the 9% stands, and it stands for good unless something changes the *shape*
 * of the force curve rather than its scale — the sails' own coefficients, or a
 * resistance curve steeper than §3.5 can afford. This is the tightest the broad
 * reach gets, and it has about a point of margin left.
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
    //
    // pos-lcz took the deep-reach allowance from 0.4 to 0.5, and the reason is
    // the softer wall rather than a worse rig. The stall is the same stall; the
    // boat is simply going faster through it now that the wall holds it down
    // less hard, so the same proportional loss is more knots. The worst single
    // degree went from 0.365 kt to 0.447 kt, at 141°→142°.
    //
    // The bound below is not what guards against a genuine cliff — a cliff
    // would be the optimal trim jumping between two peaks, and what catches
    // that is the monotonicity sweep underneath, which is unchanged and which
    // no widening here weakens.
    const DEEP_REACH = (twa: number) => twa >= 138 && twa <= 148;

    for (let twa = 10; twa < 180; twa += 1) {
      const drop = Math.abs(speedAt(twa + 1) - speedAt(twa));
      const allowed = DEEP_REACH(twa) ? 0.5 : 0.2;
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
 * opens the simulator anywhere in **6–14 kt**, though, and §5 gives the wind a
 * slider without saying where it stops — the scaffolding in `main.ts` currently
 * offers 0–30 kt, and that is a placeholder rather than a decision. So the
 * lessons the table exists to protect have to survive a range the table says
 * nothing about, and it is worth knowing how well.
 *
 * **These bounds are tight because pos-lcz tightened them, and pos-d7u is what
 * finally made them comfortable.** What they used to say was that the lessons
 * weakened with the wind and by how much: the closest useful angle ran from 49°
 * at 6 kt to 39° at 14 kt, so the bound had to be 35–55°. pos-lcz brought it to
 * 40–50° across the opening range by softening the wall, at the price of a boat
 * that ran away above it. §3.2's depowering pays that price off. Measured, well
 * trimmed:
 *
 * ```text
 * wind      4     6     8    10    12    14    16    20    30    45
 * angle    51°   49°   47°   44°   41°   41°   41°   41°   42°   42°
 * run/beam 0.53  0.57  0.62  0.67  0.71  0.74  0.76  0.79  0.84  0.87
 * beam kt  2.91  4.05  4.90  5.55  6.07  6.31  6.33  6.34  6.36  6.37
 * k        1.00  1.00  1.00  1.00  0.995 0.857 0.660 0.422 0.188 0.083
 * ```
 *
 * The bottom row is {@link depoweringFactor}, and the shape of the table is its
 * doing: through 10 kt it is 1 to five decimal places and every figure is
 * pos-lcz's unchanged, at 12 kt it has taken a tenth of a percent (a beam reach
 * of 6.072 kt against an undepowered 6.079), and from 14 kt the rig stops
 * collecting force and the boat stops accelerating. The closest useful angle
 * then stops drifting altogether — 41° or 42° at every wind from 12 kt to
 * 45 kt, where it used to run down to 30°.
 *
 * **The 14 kt knife edge is gone, and that is the clearest thing depowering
 * bought.** This block used to carry a warning: the peak is a discrete argmax
 * over a very flat maximum, the winning degree beats its runner-up by a few
 * hundredths of a percent, and at 14 kt the peak sat on 40° with the runner-up
 * at 39° — *outside* the bound. So any sub-percent numerical difference, a
 * platform's `Math.pow` or a `Math.cos` a few ulp out, could turn this file red
 * with nothing having changed.
 *
 * The flatness is unchanged and always will be — re-measured here, the winner
 * beats the runner-up by 0.09% at 6 kt, 0.02% at 8, 0.06% at 10, 0.01% at 12
 * and 0.04% at 14. What changed is where the pair sits. At 14 kt it is now 41°
 * winning from 40°, so **both** are inside 40–50°, as they already were at every
 * other wind in the range. A flip is now invisible everywhere rather than
 * everywhere but one. If this block ever does go red, that is the physics
 * having moved and not the arithmetic.
 *
 * **Why the wall could not do this.** Every force in the model is homogeneous
 * of degree two in speed, so scaling the wind and the boat speed together leaves
 * the polar's shape alone; the single exception was §3.5's wall, whose `v_hull`
 * is an absolute speed. Zero the wall and re-solve the quadratic to hold the
 * 10 kt beam reach and the polar is *exactly* scale-invariant — a 45° peak and a
 * 0.58 run/beam ratio at every wind from 4 to 30 kt. So the wall was the sole
 * source of wind-dependence here, and once the 10 kt beam reach was pinned it
 * was a one-parameter family: softening it held the angle and the run/beam ratio
 * together and let the boat run away in a breeze, and sharpening it capped the
 * breeze and sent the pointing through the floor, because the wall clips a reach
 * harder than it clips close hauled and clipping the fast angles is what slides
 * the VMG peak lower. There was no setting that did both. pos-lcz measured both
 * directions and §3.5 records the choice; pos-d7u added the second term that
 * makes it a choice no longer.
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
    // 0.67 at 10 kt against 0.74 at 14 kt, where before pos-lcz it was 0.68
    // against 0.78. The lesson holds everywhere in the range; how loudly it is
    // taught still varies, but the whole opening range now clears the same
    // 0.75 the 10 kt test asserts, so this is no longer a looser bound than
    // that one — it is the same bound, applied over a wider range.
    for (const wind of OPENING_RANGE) {
      const ratio = speedAt(180, true, 0, kt(wind)) / speedAt(90, true, 0, kt(wind));
      expect(ratio, `${wind} kt`).toBeLessThan(0.75);
    }

    // And the direction of the drift, pinned so that it is a known property
    // rather than a surprise: more wind always narrows the gap.
    expect(speedAt(180, true, 0, kt(14)) / speedAt(90, true, 0, kt(14))).toBeGreaterThan(
      speedAt(180, true, 0, kt(6)) / speedAt(90, true, 0, kt(6)),
    );
  });

  it("keeps the closest useful angle in the range a keelboat sails", () => {
    // 49° in 6 kt down to 41° in 14 kt — the same 40–50° the 10 kt test pins,
    // now held across the whole opening range rather than the 35–55° this used
    // to need. The 14 kt end used to sit on the bound exactly, at 40°, with its
    // runner-up degree outside; §3.2's depowering moved the pair to 41°/40° and
    // this block's docblock has the measurement.
    for (const wind of OPENING_RANGE) {
      expect(vmgPeak(wind), `${wind} kt`).toBeGreaterThanOrEqual(40);
      expect(vmgPeak(wind), `${wind} kt`).toBeLessThanOrEqual(50);
    }

    // The drift is smaller than it was but it has not gone, and the direction
    // is still worth pinning as a known property rather than a surprise.
    expect(vmgPeak(14)).toBeLessThan(vmgPeak(6));
  });

  it("stays a boat rather than a machine in a wind nobody would sail in", () => {
    // Not a calibration claim — §5 does not say where the wind slider stops,
    // and today's scaffolding offers 30 kt, so this is the floor under what
    // happens past the range anyone tuned. The speeds stay finite and bounded,
    // and the boat never sails dead upwind however hard it blows, which is the
    // one lesson that must not break at any wind.
    //
    // This bound has stopped doing much work, and the history is worth keeping
    // because it ran both ways. pos-lcz's softer wall took a beam reach in
    // 45 kt from 8.88 kt to 10.31 and left this bound close enough to matter;
    // §3.2's depowering brought it to 6.37, which is a boat by any reading. The
    // bound stays where it is precisely because it is not a calibration claim —
    // it is the floor under a wind nobody tuned for, and it should keep holding
    // whatever the next pass does above the range that is tuned.
    for (const wind of [20, 30, 45]) {
      expect(speedAt(0, true, 0, kt(wind)), `${wind} kt`).toBe(0);
      expect(speedAt(90, true, 0, kt(wind)), `${wind} kt`).toBeLessThan(12);
      expect(vmgPeak(wind), `${wind} kt`).toBeGreaterThan(20);
    }
  });

  it("keeps a beam reach near hull speed at the top of the wind range", () => {
    // The promise §3.5's wall was originally there to keep — "no amount of sail
    // area gets a Rhodes 19 to 9 knots in the wind it is actually sailed in" —
    // and could not, being a function of speed when the problem was a function
    // of the wind. §3.2's depowering keeps it instead.
    //
    // This test replaces one that pinned the *cost* of not keeping it: 7.59 kt
    // at 20 and 8.88 kt at 30, which is 34% and 57% over hull speed and a boat
    // a Rhodes 19 is not. Those are the figures to compare the ones below with.
    const HULL_SPEED_KT = metersPerSecondToKnots(HULL.hullSpeed);
    expect(HULL_SPEED_KT).toBeCloseTo(5.65, 2);

    const beamAt20 = speedAt(90, true, 0, kt(20));
    const beamAt30 = speedAt(90, true, 0, kt(30));

    // Bounded above because that is the point, and below because a beam reach
    // that came out *under* hull speed in 20 kt would be a different failure —
    // a boat that had been capped so hard it no longer sails — and a pass that
    // produced one should have to say so rather than find the suite still green.
    expect(beamAt20).toBeGreaterThan(6.0);
    expect(beamAt20).toBeLessThan(6.7);
    expect(beamAt30).toBeGreaterThan(6.0);
    expect(beamAt30).toBeLessThan(6.7);

    // 12% and 13% over hull speed, against 34% and 57% before. Not *at* hull
    // speed: a beam reach in a breeze is the one point of sail a displacement
    // boat can hold a little past it, and §3.6's own 10 kt figure is already
    // 5.55 kt against a 5.65 kt hull speed, so there was never room for the
    // cap to buy much more than this without taking the 10 kt table with it.
    expect(beamAt20 / HULL_SPEED_KT).toBeLessThan(1.2);
    expect(beamAt30 / HULL_SPEED_KT).toBeLessThan(1.2);

    // And the wind slider's whole top end is one speed, which is what a capped
    // rig means: ten more knots of wind is worth two hundredths of a knot.
    expect(Math.abs(beamAt30 - beamAt20)).toBeLessThan(0.1);
  });

  it("stops accelerating above the wind it is fully powered up in", () => {
    // The mechanism, separated from the polar figures above so that a failure
    // says which of the two moved. Below `DEPOWERING.fullPowerWind` the rig is
    // untouched and the boat behaves exactly as it did before pos-d7u; above
    // it the rig holds its force and the boat holds its speed.
    //
    // Never *exactly* 1 below the knee, and deliberately not asserted as such:
    // the factor is smooth, so it approaches full power without arriving, and
    // at 10 kt it is 0.99999. A test demanding equality would be pinning the
    // shape of the corner rather than the behaviour, and the table quotes these
    // as 1.000 because that is what they are to every digit anyone reads.
    expect(depoweringFactor(kt(4))).toBeGreaterThan(0.9999);
    expect(depoweringFactor(kt(10))).toBeGreaterThan(0.9999);
    expect(depoweringFactor(kt(12))).toBeGreaterThan(0.99);

    // Which is what leaves §3.6's table alone. Measured against the same model
    // with the factor disabled, 6 kt and 8 kt are identical to six decimal
    // places, and 10 kt differs in the fifth — 4.179710 kt close hauled against
    // 4.179732. The table is not approximately preserved, it is preserved.
    expect(speedAt(90, true, 0, kt(10))).toBeCloseTo(5.5486, 3);
    expect(speedAt(135, true, 0, kt(10))).toBeCloseTo(4.7273, 3);

    // Past the knee the force is capped rather than merely slowed, so `k·q` —
    // the pressure the rig is allowed to convert — is flat. Checked as a ratio
    // so it pins the shape and not the constant.
    const carriedPressure = (windKt: number) =>
      depoweringFactor(kt(windKt)) * kt(windKt) ** 2;
    expect(carriedPressure(45) / carriedPressure(20)).toBeCloseTo(1, 2);

    // Monotone, so more wind is never more power.
    for (let wind = 1; wind < 60; wind += 1) {
      expect(depoweringFactor(kt(wind + 1)), `${wind} kt`).toBeLessThanOrEqual(
        depoweringFactor(kt(wind)),
      );
    }

    // Saturating rather than breaking: the wind slider has no stated ceiling
    // (§5), and a factor that returned `NaN` at some wind would poison the
    // speed permanently, which is the failure `clampStep` exists to prevent.
    expect(depoweringFactor(Infinity)).toBe(0);
    expect(depoweringFactor(0)).toBe(1);
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
