import { describe, expect, it } from "vitest";

import { JIB, MAIN } from "./boat.ts";
import { hullResistance, keelInducedDrag } from "./hull.ts";
import { depoweringFactor, optimalTrim, rigForce } from "./sail.ts";
import { FOIL } from "./tuning.ts";
import type { SimState } from "./simulation.ts";
import { settle } from "./simulation.ts";
import type { Knots, MetersPerSecond, Radians } from "./units.ts";
import { degreesToRadians, knotsToMetersPerSecond, metersPerSecondToKnots } from "./units.ts";
import { apparentWind } from "./wind.ts";

/**
 * **A polar is a property of the boat, not of its history** (DESIGN.md §3.5,
 * §3.6), enforced at every trim rather than only at the good ones.
 *
 * `calibration.test.ts` has asserted path-independence since pos-fo1.4, but only
 * along one line through the space: sloop rig, and the single trim
 * `wellTrimmed()` finds at each angle. pos-i4o was a bug living everywhere else
 * — a boat that settled 2.90 kt apart at the same trim in the same wind
 * depending on whether it started from rest, worst about 4° from the optimum,
 * which is ordinary trimming rather than a corner. The guard that existed could
 * not see it, because it tested the one trim per angle at which it was absent.
 *
 * **What this file measures, and why it is not a settling comparison.** Settling
 * from two speeds and comparing tells you the boat reached two answers; it does
 * not tell you the equation had two, and it costs a few hundred integration
 * steps per sample. The underlying fact is exact and cheap: speed is a
 * one-dimensional flow, so the settled speeds at a given trim are precisely the
 * downward zero crossings of the net force. Counting them is the same arithmetic
 * `simulation.ts` integrates, evaluated rather than iterated, and *more* than
 * two crossings is a fold whether or not any particular starting speed finds it.
 *
 * **The sweep looks for counterexamples; it cannot prove their absence.** A grid
 * that finds nothing has failed to find something, which is weaker than there
 * being nothing to find, and this is the exact shape of error that made the
 * first three passes at this bug report false clean results — a 1° trim grid
 * reported settings as fold-free that a 0.25° grid showed folding by 1.4 kt.
 * Two things follow, and both are load-bearing:
 *
 * - The resolution is stated below and is finer than the narrowest fold this
 *   model has been observed to make (about 1° of trim).
 * - `can see a fold that is really there` proves the instrument reaches what it
 *   measures, by running it against a curve that folds on purpose. Without that,
 *   "no fold found" and "the grid cannot see folds" are the same passing test.
 *
 * **The grid below was checked against a much finer one rather than argued for.**
 * Walking `stallBlendWidth` down until folds appear and running both grids at
 * every width, against a reference five times finer in trim, ten times in speed
 * and twice in TWA:
 *
 * ```text
 * blend    this grid          reference grid
 * 20°      2.400 kt, 58 hits  2.390 kt, 575 hits
 * 25°      2.000 kt,  9 hits  1.980 kt,  84 hits
 * 28°      1.500 kt,  3 hits  1.490 kt,  20 hits
 * 30°      1.000 kt,  1 hit   1.070 kt,   5 hits
 * 32°      none               none
 * ```
 *
 * It finds a fold at every width where the finer grid finds one, and sizes it to
 * within 0.07 kt. Read the third column rather than the second, though: at 30°
 * it is down to a **single** cell, so the margin is thin exactly where a fold is
 * about to become invisible. The shipped 50° is eighteen degrees clear of the
 * 32° threshold, so that thinness is about how small a regression this would
 * catch, not about whether it can see the boat it has.
 *
 * **On the equality tolerance.** Settled speeds are compared to four decimal
 * places rather than to machine precision, and that floor is `settle`'s own
 * convergence tolerance rather than anything physical: it stops when a step
 * moves the speed less than 1e-8 m/s, so approaching a balance point from above
 * and from below lands a few hundred-thousandths of a knot apart. A fold is
 * upwards of a knot — four orders of magnitude clear — so nothing this file
 * cares about can hide under it.
 */

const deg = degreesToRadians;
const kt = knotsToMetersPerSecond;

/**
 * The trim grid. The narrowest fold observed in this model is about 1° wide in
 * trim, so a quarter of a degree crosses the narrowest one four times.
 */
const TRIM_STEP_DEGREES = 0.25;

/**
 * The angle grid. Unlike the trim window, folds are broad in TWA — the one this
 * bead was filed for spanned 60°–110° at 10 kt and 50°–130° at 6 — so ten
 * degrees crosses the narrowest observed span five times.
 */
const TWA_STEP_DEGREES = 10;

/**
 * How finely the net force is sampled in speed when hunting for crossings.
 *
 * **This does bound what can be noticed, not merely how precisely it is
 * measured**, and it is worth being exact about why, because the comfortable
 * reading — "the two branches are more than a knot apart, so ten samples fall
 * between them" — is wrong. What has to be resolved is not the gap between the
 * stable branches but the *positive* stretch of net force between the unstable
 * root and the upper stable one. Step over both ends of that stretch and the
 * two crossings vanish together, leaving a fold reading as a single root. At a
 * saddle-node the branches are born coalescent, so that stretch shrinks to
 * nothing as a fold first appears: **there is necessarily a band of parameter
 * space where a fold exists and this grid cannot see it.**
 *
 * No step size removes that band; it only moves it. What the table above does
 * is bound it empirically — down to a blend of 30°, this grid still finds what
 * a grid ten times finer in speed finds — and what the shipped 18° of margin
 * over the 32° threshold does is keep the model far away from it.
 */
const SPEED_STEP_KNOTS = 0.1;

/**
 * Filled in by `settles to the same speed from rest as from speed` and asserted
 * by `leaves only cases where the boat is stopped on one of the branches`. The
 * two are one sweep — settling is what this file spends its time on, and asking
 * the same grid two questions costs one pass rather than two.
 */
const residual = {
  worstGap: 0,
  worstGapAt: "none",
  fastestSlowBranch: 0,
  fastestSlowBranchAt: "none",
};

function boat(twa: number, jibSet: boolean, trim: Radians, wind: MetersPerSecond): SimState {
  return {
    wind: { from: deg(twa), speed: wind },
    motion: { heading: 0, speed: 0 },
    trim: { mainAngle: trim, jibAngle: trim, jibSet },
    mainHeld: false,
    jibHeld: false,
  };
}

/**
 * `simulation.ts`'s force balance, evaluated at an arbitrary speed rather than
 * integrated towards one. Kept deliberately in the same order and with the same
 * terms as `advance`, since the whole point is that it is the same equation.
 */
function netForce(state: SimState, speed: MetersPerSecond): number {
  const apparent = apparentWind(state.wind, { ...state.motion, speed });
  const { driving, lateral } = rigForce(state.trim, apparent);
  const carried = depoweringFactor(state.wind.speed);
  return driving * carried - hullResistance(speed) - keelInducedDrag(speed, lateral * carried);
}

/**
 * Every speed the boat could settle at from this state: the downward zero
 * crossings of the net force, in knots. One is a polar; more than one is a fold.
 *
 * Forward speeds only. Sternway is §3.4's territory and has its own stable
 * points — a boat in irons with its sheets in sits astern — which are not what
 * this file is about; the last test below names that boundary explicitly and
 * measures what is left on the far side of it.
 */
function settledSpeeds(state: SimState, ceiling: Knots): Knots[] {
  const found: Knots[] = [];
  let previous = netForce(state, kt(0));

  for (let speed = SPEED_STEP_KNOTS; speed <= ceiling; speed += SPEED_STEP_KNOTS) {
    const current = netForce(state, kt(speed));
    if (previous > 0 && current <= 0) found.push(speed - SPEED_STEP_KNOTS / 2);
    previous = current;
  }

  return found;
}

/** The widest fold anywhere in the trim/angle grid at one wind, in knots. */
function worstFold(windKnots: number): { width: Knots; where: string } {
  let width = 0;
  let where = "none";
  // High enough that a fast branch can never hide above it and leave a fold
  // reading as a single crossing, and no higher, because every knot of ceiling
  // is samples spent. Scaled to the wind in light air; flattened at 12 kt above
  // that, which is nearly double the fastest speed this model can reach at any
  // wind at all — §3.2's depowering holds a beam reach to 6.41 kt in 45 kt of
  // breeze, and §3.5's wall would want a great deal more than 12 to be passed.
  const ceiling = Math.min(Math.max(3, windKnots * 1.4), 12);

  for (const jibSet of [false, true]) {
    for (let twa = 0; twa <= 180; twa += TWA_STEP_DEGREES) {
      for (let trim = 0; trim >= -90; trim -= TRIM_STEP_DEGREES) {
        const speeds = settledSpeeds(boat(twa, jibSet, deg(trim), kt(windKnots)), ceiling);
        if (speeds.length > 1 && speeds[speeds.length - 1] - speeds[0] > width) {
          width = speeds[speeds.length - 1] - speeds[0];
          where = `${jibSet ? "sloop" : "main only"}, TWA ${twa}°, trim ${trim}°`;
        }
      }
    }
  }

  return { width, where };
}

describe("the settled speed is single-valued (DESIGN.md §3.5, §3.6)", () => {
  /**
   * **The instrument check, and it has to graze the threshold to be worth
   * anything.** Every assertion below is of the form "the sweep found nothing",
   * which passes just as readily when the sweep is incapable of finding
   * anything — so the grid has to be shown finding something first.
   *
   * *Which* something is the whole question. Restoring the pre-pos-i4o curve
   * and catching its 2.90 kt fold proves only that the sweep is not inert: that
   * fold is enormous and a grid twenty times coarser than this one still finds
   * it, including the 1° trim grid the header above blames for three false
   * clean results. So this restores **only** the blend width, and only to 31° —
   * one degree inside the 32° boundary where folds begin. What is there to find
   * is then the *narrowest fold this model makes at all*, a 0.9 kt one at 4 kt
   * of wind occupying a single-digit number of grid cells.
   *
   * A blatant fold tests that the instrument works. A threshold-grazing one
   * tests that it is sharp enough to be believed when it reports nothing, which
   * is the only claim this file actually makes. And it does discriminate: run
   * this case at a 1° trim grid — the one the header blames — and **it fails**,
   * at 0.5° and 0.25° it passes. The old blatant-fold version passed at every
   * step size tried, which is what made it worthless.
   */
  it("can see the narrowest fold this model makes", () => {
    const foil = FOIL as { stallBlendWidth: number };
    const saved = foil.stallBlendWidth;
    foil.stallBlendWidth = deg(31);

    try {
      // 31° folds at 2, 3 and 4 kt and is clean by 5 — light air is where the
      // last of it survives, because there the wall is not yet damping anything.
      const found = worstFold(4);
      expect(found.width, "a fold at 31° of blend went unseen").toBeGreaterThan(0);
    } finally {
      foil.stallBlendWidth = saved;
    }
  }, 30_000);

  /**
   * The sweep proper. Every wind the simulator can be put in — §5's slider
   * offers 0–30 kt and §2.1 opens in 6–14 — at every trim, on both rigs.
   */
  it("has one settled speed per trim, at every wind and every point of sail", () => {
    // Spanning the slider: below §2.1's opening range, across it, and above the
    // wind at which §3.2's depowering takes over.
    for (const wind of [2, 6, 10, 14, 20, 30]) {
      const found = worstFold(wind);
      expect(found.width, `${wind} kt true: fold at ${found.where}`).toBe(0);
    }
  }, 60_000);

  /**
   * The same claim in the terms the bug was reported in, which is worth having
   * separately: not "the equation has one root" but "the boat arrives at the
   * same speed however it got there". Settling is what a student experiences,
   * and it is an independent route to the answer — a few hundred integration
   * steps rather than a root count.
   *
   * **It carries the residual as well, in one pass over one grid**, because the
   * two questions are the same sweep asked twice and settling is the expensive
   * part of this file. What survives is described in
   * `leaves only cases where the boat is stopped on one of the branches` below,
   * which reads the numbers this collects.
   */
  it("settles to the same speed from rest as from speed", () => {
    for (const wind of [6, 10, 14]) {
      for (const jibSet of [false, true]) {
        // From 5°, not 10°: the residual this also collects lives at TWA 65°,
        // and a grid of 10 + 15k steps straight over it. That is not a
        // hypothetical — merging these two sweeps into one pass did exactly
        // that, and the bound below went on passing against a set that no
        // longer contained the case its own docblock describes.
        for (let twa = 5; twa <= 180; twa += 15) {
          for (let trim = 0; trim >= -90; trim -= 2) {
            const state = boat(twa, jibSet, deg(trim), kt(wind));
            const fromRest = metersPerSecondToKnots(settle(state).motion.speed);
            const fromSpeed = metersPerSecondToKnots(
              settle({ ...state, motion: { heading: 0, speed: kt(wind * 1.2) } }).motion.speed,
            );

            const where = `${wind} kt, ${jibSet ? "sloop" : "main only"}, TWA ${twa}°, trim ${trim}°`;
            const gap = Math.abs(fromRest - fromSpeed);
            const slower = Math.min(fromRest, fromSpeed);

            // Collected for the residual test below, which is the same sweep.
            if (gap > 0.01) {
              if (gap > residual.worstGap) residual.worstGap = gap, (residual.worstGapAt = where);
              if (slower > residual.fastestSlowBranch)
                residual.fastestSlowBranch = slower, (residual.fastestSlowBranchAt = where);
            }

            // Both branches under way. A boat in irons with its sheets pinned
            // flat can sit astern or creep ahead depending on where it started,
            // which is §3.4's sternway rather than §3.2's stall.
            if (fromRest < 0.5 || fromSpeed < 0.5) continue;

            expect(fromRest, where).toBeCloseTo(fromSpeed, 4);
          }
        }
      }
    }
  }, 60_000);

  /**
   * The bug as the human found it in the running app: main alone, TWA 90 in
   * 10 kt, trimming in past the stall. It used to cost 1.73 kt for a tenth of a
   * degree — 4.5972 against 2.8637 — and to settle 1.69 kt apart at trim −37°
   * depending on where it started.
   *
   * Pinned as a *rate* rather than as speeds, so that a later calibration pass
   * can move the polar without touching this, and so that what is asserted is
   * the thing that was wrong.
   */
  it("costs a tenth of a degree what a tenth of a degree should cost", () => {
    const speedAtTrim = (trim: number, from = 0): Knots =>
      metersPerSecondToKnots(
        settle({
          ...boat(90, false, deg(trim), kt(10)),
          motion: { heading: 0, speed: kt(from) },
        }).motion.speed,
      );

    for (let trim = -40; trim <= -30; trim += 0.1) {
      const here = speedAtTrim(trim);
      const next = speedAtTrim(trim + 0.1);
      expect(Math.abs(next - here), `trim ${trim.toFixed(1)}°`).toBeLessThan(0.05);
    }

    expect(speedAtTrim(-37)).toBeCloseTo(speedAtTrim(-37, 6), 4);
  }, 30_000);

  /**
   * And at the trim a student is actually being told to use. The §4.2 traffic
   * light reads green here, so a fold at this trim would be the model
   * contradicting its own advice: sheet to the green light from a standstill and
   * settle at two thirds of the speed the same trim holds once moving. It did,
   * by 1.56 kt, at TWA 110 in 6 kt.
   */
  it("does not depend on how the boat got there at the optimal trim either", () => {
    for (const wind of [6, 10]) {
      for (const jibSet of [false, true]) {
        for (const twa of [50, 70, 90, 110, 130]) {
          let state = boat(twa, jibSet, 0, kt(wind));
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

          const fromRest = settle({ ...state, motion: { heading: 0, speed: 0 } });
          const fromSpeed = settle({ ...state, motion: { heading: 0, speed: kt(wind * 1.2) } });

          expect(
            metersPerSecondToKnots(fromRest.motion.speed),
            `${wind} kt, ${jibSet ? "sloop" : "main only"}, TWA ${twa}° at optimal trim`,
          ).toBeCloseTo(metersPerSecondToKnots(fromSpeed.motion.speed), 4);
        }
      }
    }
  }, 30_000);
});

describe("what is left, and where it lives", () => {
  /**
   * **The claim above is "one settled speed per trim"; this is the fine print,
   * and pos-i4o introduced half of it.** Two kinds of path-dependence survive,
   * and both share one property: *the boat is stopped on at least one of the two
   * branches*. Across 6–14 kt, both rigs, every angle and every trim, the
   * fastest a slow branch ever gets is **0.061 kt**. Nothing that is actually
   * sailing has two answers.
   *
   * **Sheeted flat, close hauled** — no ease at all, so α is the whole apparent
   * wind angle. At TWA 65° the boat either drifts astern or creeps ahead
   * depending on where it started: −0.233 kt against +0.404 kt in 14 kt of
   * wind, the widest case anywhere. This one is new. Before pos-i4o it settled
   * astern from both directions (−0.327 kt), and it is the price of the wider
   * blend — a sail at 65° of incidence now makes just enough lift to sustain
   * way, where before it made none worth having. Left rather than fixed, and
   * tracked as `pos-rem`: both branches are under half a knot, the boat is in
   * irons on either, §4.2 paints the sail red at this trim either way, and
   * moving the blend does not remove it (at 40° it shifts to TWA 55° and grows
   * to 0.77 kt).
   *
   * **A boat coasting to rest** — 0.000 kt against 0.042 kt. Not a fold at all
   * but `settle`'s iteration budget running out, which `simulation.ts`
   * documents: with no drive to balance against, a coasting boat approaches rest
   * like `1/t` and there is no finite time at which it has arrived. Root-counting
   * tells the two apart where settling cannot — at TWA 50° in 6 kt under main
   * alone at trim −48°, which reads as a 0.0405 kt split, the net force has *no*
   * downward crossing above zero, so the balance is rest and the boat is still
   * on its way there. Pre-existing and unrelated to this bead.
   *
   * Bounded here so neither can grow quietly, and so that what the rest of this
   * file claims is exactly true rather than nearly true.
   */
  it("leaves only cases where the boat is stopped on one of the branches", () => {
    // **That the sweep ran, and found something.** Everything below is an upper
    // bound, and an upper bound over an empty set is vacuous — which is how this
    // test would read if the sweep above were skipped, filtered out by a `-t`,
    // or quietly stopped sampling the angles where the residual lives.
    expect(residual.worstGap, "the sweep found no residual at all").toBeGreaterThan(0.1);

    // The property that makes the residual tolerable, and the one to defend: a
    // boat that is *moving* never has two answers. This is what would fail if a
    // fold came back somewhere the root-counting grid steps over.
    expect(
      residual.fastestSlowBranch,
      `slow branch under way at ${residual.fastestSlowBranchAt}`,
    ).toBeLessThan(0.1);

    // And the widest fork stays the one described above rather than growing.
    expect(residual.worstGap, `worst at ${residual.worstGapAt}`).toBeLessThan(1);
  });
});
