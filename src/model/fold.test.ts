import { describe, expect, it } from "vitest";

import { JIB, MAIN } from "./boat.ts";
import { hullResistance, hullResistanceSlope, keelInducedDrag } from "./hull.ts";
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
 * this sweep is about. `what is left, and where it lives` names that boundary
 * explicitly, and the block after it searches the far side of it with an
 * instrument built for the job, since a grid in TWA is the wrong one.
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

/**
 * How fast a search has to look before it can conclude there is nothing there.
 *
 * High enough that a fast branch can never hide above it and leave a fold
 * reading as a single crossing, and no higher, because every knot of ceiling is
 * samples spent. Scaled to the wind in light air; flattened at 12 kt above
 * that, which is nearly double the fastest speed this model can reach at any
 * wind at all — §3.2's depowering holds a beam reach to 6.41 kt in 45 kt of
 * breeze, and §3.5's wall would want a great deal more than 12 to be passed.
 *
 * Shared by both searches in this file rather than written out twice, so the
 * bound the forward sweep clears and the bound the boundary sweep below clears
 * cannot drift apart.
 */
function speedCeiling(windKnots: number): Knots {
  return Math.min(Math.max(3, windKnots * 1.4), 12);
}

/** The widest fold anywhere in the trim/angle grid at one wind, in knots. */
function worstFold(windKnots: number): { width: Knots; where: string } {
  let width = 0;
  let where = "none";
  const ceiling = speedCeiling(windKnots);

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
   * wind, the widest case anywhere. This is the model sitting on the edge of its
   * own no-go zone, and `the fold at the edge of the no-go zone` below works out
   * what it is, why no constant in `tuning.ts` removes it, and what bounds it.
   * Kept here as well because it is what this sweep actually walks into, and
   * because the two searches reaching the same case by different routes is worth
   * something.
   *
   * pos-rem filed this as introduced by pos-i4o and it is not: what pos-i4o moved
   * is *which grid cell* the band falls in. The phenomenon predates it and was
   * far worse — on the pre-pos-i4o curve the same band sits at TWA 36.3°–37.5° at
   * trim 0 and splits 2.934 kt, with a fast branch of 2.498 kt, a boat genuinely
   * sailing. The block below measures that, and measures that this sweep's grid
   * could not have seen it.
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

// --- The fold at the edge of the no-go zone (§3.4, §3.5) --------------------
//
// Everything above searches a *grid*. This does not, because for this fold a
// grid is the wrong instrument and being lucky with one is what the file spent
// three passes learning to distrust.

/**
 * How far either side of rest the net force is read to ask which way rest
 * leans, in knots.
 *
 * Small enough to be inside the linear stretch around zero, and far enough out
 * to clear the residue of the bisection below. Forty halvings take a one-degree
 * bracket to about 1e-12 of a degree, and the drive moves some 2 N per degree of
 * TWA there, so the drive left at rest is around 2e-12 N — while a
 * ten-thousandth of a knot against the shallowest drive slope in the model,
 * 3.5 N/(m/s), reads 1.8e-4 N. Eight orders of margin.
 */
const REST_PROBE_KNOTS = 1e-4;

/**
 * How fast the walk outward from rest opens up, per step.
 *
 * It only has to bracket a sign change; the bisection that follows does the
 * accuracy. A fifth per step spans a ten-thousandth of a knot to the 12 kt
 * ceiling in 64 evaluations, where a fixed step fine enough for the lightest
 * branch would want tens of thousands.
 */
const OUTWARD_GROWTH = 1.2;

/**
 * How finely the drive from rest is scanned in TWA before each sign change is
 * bisected, in degrees.
 *
 * The only sampled axis left in this search, and the one place it could still
 * miss something — a pair of sign changes inside one degree would read as none.
 * Checked rather than assumed: against a scan twenty times finer, over the same
 * 4332 settings this search visits, the two agree on the number of sign changes
 * at all but twelve. All twelve are at trim −2°, and in every one of them it is
 * the *coarse* scan finding an extra rather than the fine one finding something
 * the coarse missed — see {@link noGoBoundaries} on the collapsed plateau, where
 * "the angle at which the drive changes sign" is not a well-posed question and
 * nothing is hiding either way.
 */
const BOUNDARY_SCAN_DEGREES = 1;

/**
 * The wind {@link noGoBoundaries} is evaluated at, in knots. Any would do — see
 * there for why the answer does not depend on it — so this is the middle of
 * §2.1's opening range rather than a number with a job.
 */
const BOUNDARY_REFERENCE_WIND = 10;

/**
 * The winds the bound is taken over, in knots: §5's slider, finely.
 *
 * **Six sampled winds was not good enough and this is the axis that caught it.**
 * The other two axes are honest — TWA is solved for rather than sampled, and the
 * trim grid is the one the file already argues for — but the wind list was
 * inherited from the sweeps above, where it is a list of *cases* rather than a
 * search. Here it is a search, and the quantity being maximised is not monotone
 * in the wind: the branches grow with it up to §3.2's `fullPowerWind` and shrink
 * above, because past the knee the drive stops collecting while the water's
 * scale does not. So the maximum sits at the knee — measured at 12.8 kt, against
 * a 13 kt constant — and a list holding 10 and 14 straddles it and reports 6%
 * low. A tenth of a knot resolves it.
 */
const BOUND_WINDS: number[] = Array.from({ length: 296 }, (_, i) => 0.5 + i * 0.1);

/**
 * Every true wind angle at which the drive from rest changes sign, at one trim
 * and wind, bisected.
 *
 * **This is the whole point of the block.** The band of angles in which the boat
 * has two settled speeds astride zero is a fraction of a degree wide — half a
 * degree at trim 0 — and it always sits at the angle where the drive from rest
 * passes through zero. A sweep in TWA finds it by luck or not at all. Solving
 * for the angle instead makes the search exact on that axis, so trim is the only
 * thing left being sampled.
 *
 * The net force at rest *is* the drive at rest: {@link hullResistance} and
 * {@link keelInducedDrag} are both even and quadratic in speed, so both vanish
 * at zero. `charges nothing for the water at rest` below pins that, because it
 * is the fact the whole mechanism turns on.
 *
 * **The collapsed plateau is not a boundary and does not need to be.** Near head
 * to wind, and again near dead astern, §3.3 collapses the sail outright and the
 * drive from rest is *exactly* zero over a stretch of angles rather than passing
 * through zero at one. Sign changes at the ends of that stretch are an artefact
 * of where the scan lands, which is why nothing below asserts on how many
 * boundaries were found. Nothing hides there either: root-counting across signed
 * speeds at all 36,984 grid cells where the drive from rest is exactly zero —
 * every trim, both rigs, six winds — finds no case with two settled speeds.
 *
 * **These angles do not depend on the wind, and that is what makes a fine wind
 * grid affordable.** At rest the apparent wind *is* the true wind, so the drive
 * from rest is `½ρW²·A` times a function of the angles alone, and §3.2's
 * depowering is one more positive factor on top. Neither can move a sign change.
 * So this is evaluated once per rig and trim at {@link BOUNDARY_REFERENCE_WIND}
 * and reused at every wind, which turns the wind axis from six samples into
 * three hundred for no extra boundary work. `locates the same boundaries at
 * every wind` asserts the property rather than trusting this paragraph.
 */
function noGoBoundaries(
  jibSet: boolean,
  trim: Radians,
  wind: MetersPerSecond = kt(BOUNDARY_REFERENCE_WIND),
): number[] {
  const atRest = (twa: number) => netForce(boat(twa, jibSet, trim, wind), 0);
  const found: number[] = [];

  let previous = atRest(0);
  for (let twa = BOUNDARY_SCAN_DEGREES; twa <= 180; twa += BOUNDARY_SCAN_DEGREES) {
    const current = atRest(twa);

    if (previous > 0 !== current > 0) {
      let low = twa - BOUNDARY_SCAN_DEGREES;
      let high = twa;
      const positiveAtHigh = current > 0;
      // Halving the bracket forty times takes a degree to under 1e-12 of one.
      for (let pass = 0; pass < 40; pass += 1) {
        const mid = (low + high) / 2;
        if (atRest(mid) > 0 === positiveAtHigh) high = mid;
        else low = mid;
      }
      found.push((low + high) / 2);
    }

    previous = current;
  }

  return found;
}

/**
 * Walking outward from rest in one direction, the first speed at which the net
 * force crosses back through zero: the branch the boat runs away to on that
 * side.
 *
 * Returns the ceiling itself if there is no crossing before it, so a branch that
 * runs away to the end of the search shows up as a large number and fails the
 * bound rather than vanishing from the set being bounded.
 */
function branchOutward(state: SimState, direction: 1 | -1, ceiling: Knots): Knots {
  let low = REST_PROBE_KNOTS;
  let atLow = netForce(state, kt(direction * low));

  for (let high = low * OUTWARD_GROWTH; high <= ceiling; high *= OUTWARD_GROWTH) {
    const atHigh = netForce(state, kt(direction * high));

    if (atLow > 0 !== atHigh > 0) {
      let inner = low;
      let outer = high;
      for (let pass = 0; pass < 50; pass += 1) {
        const mid = (inner + outer) / 2;
        if (netForce(state, kt(direction * mid)) > 0 === atLow > 0) inner = mid;
        else outer = mid;
      }
      return (direction * (inner + outer)) / 2;
    }

    low = high;
    atLow = atHigh;
  }

  return direction * ceiling;
}

/**
 * The two speeds the boat settles at either side of an unstable rest, or null
 * where rest is not unstable and there is only the one answer.
 *
 * **Rest is unstable exactly when the drive gains with speed there**, and that
 * is the condition tested: the net force positive just ahead of zero and
 * negative just astern of it. Since both water drags vanish at rest, that is a
 * statement about the rig alone — the boat makes more drive the moment it has
 * way on, because the apparent wind hauls forward and takes the sail off the
 * stall. Which is a true thing about boats, and the reason a mooring departure
 * starts with a push.
 *
 * Where it holds, rest is the *unstable* root and the two stable ones are
 * necessarily either side of it, so this fold cannot be tuned away without
 * denying that a boat sails itself out of irons once it is moving. §3.5 works
 * through what that costs.
 */
function branchesAstrideRest(
  state: SimState,
  ceiling: Knots,
): { astern: Knots; ahead: Knots } | null {
  const ahead = netForce(state, kt(REST_PROBE_KNOTS));
  const astern = netForce(state, kt(-REST_PROBE_KNOTS));
  if (!(ahead > 0 && astern < 0)) return null;

  return {
    astern: branchOutward(state, -1, ceiling),
    ahead: branchOutward(state, 1, ceiling),
  };
}

/** The worst fold astride rest anywhere along the no-go boundary. */
function worstAstrideRest(winds: number[]) {
  const worst = {
    split: 0,
    where: "none",
    fastest: 0,
    fastestAt: "none",
    boundaries: 0,
    folds: 0,
  };

  for (const jibSet of [false, true]) {
    for (let trim = 0; trim >= -90; trim -= TRIM_STEP_DEGREES) {
      // Hoisted out of the wind loop, which is exactly what makes that loop
      // affordable at a tenth of a knot. See {@link noGoBoundaries}.
      const boundaries = noGoBoundaries(jibSet, deg(trim));

      for (const wind of winds) {
        const ceiling = speedCeiling(wind);

        for (const twa of boundaries) {
          worst.boundaries += 1;

          const state = boat(twa, jibSet, deg(trim), kt(wind));
          const branches = branchesAstrideRest(state, ceiling);
          if (branches === null) continue;

          worst.folds += 1;
          const rig = jibSet ? "sloop" : "main only";
          const where = `${wind.toFixed(1)} kt, ${rig}, TWA ${twa.toFixed(2)}°, trim ${trim}°`;
          const split = branches.ahead - branches.astern;
          const fastest = Math.max(branches.ahead, -branches.astern);
          if (split > worst.split) worst.split = split, (worst.where = where);
          if (fastest > worst.fastest) worst.fastest = fastest, (worst.fastestAt = where);
        }
      }
    }
  }

  return worst;
}

describe("the fold at the edge of the no-go zone (DESIGN.md §3.4, §3.5)", () => {
  /**
   * **What is left after the sweeps above, measured by an instrument that finds
   * it on purpose.** Right at the angle where the drive from rest changes sign,
   * rest is an unstable balance and the boat runs away from it — astern if it
   * starts astern, ahead if it starts ahead. That is a genuine second
   * equilibrium and not `settle`'s convergence floor: root-counting and settling
   * agree to four decimals on both branches.
   *
   * **It is structural, so this bounds it rather than forbidding it.** §3.5 has
   * the argument and the rejected alternatives; the short form is that both
   * water drags are quadratic, so they contribute no slope at rest at all, and
   * the sign of the drive's own slope is left to decide the stability of rest
   * unopposed. At the upwind boundary that slope is positive at every wind and
   * both rigs, 3.5 to 15.4 N/(m/s).
   *
   * **What is defended is that nothing sailing has two answers.** Across §5's
   * whole wind slider at a tenth of a knot, both rigs and every trim from flat to
   * fully eased, the fastest branch anywhere is **0.482 kt** and the widest split
   * **0.699 kt**, both at 12.8–12.9 kt on the sloop, TWA 64.88°, trim 0°. The
   * boat is stopped on both branches, §4.2 paints the sail red at that trim
   * either way, and there is no wind or angle at which a student is doing
   * anything that works out differently.
   *
   * That the peak sits at 12.8 kt rather than at one of the round numbers the
   * sweeps above use is the reason {@link BOUND_WINDS} exists; the first version
   * of this test sampled six winds, straddled the knee, and reported 6% low.
   *
   * **Only two trims on this side of the centreline fold at all**, and it is
   * worth naming them because "sheeted flat" undersells how flat: trim 0, and
   * trim −0.25° at a slightly wider angle (TWA 66.25°) and a smaller branch
   * (0.337 kt on the sloop). Half a degree of ease is clean at every wind on the
   * grid. So the band is a quarter-degree sliver of trim as well as half a degree
   * of TWA, which is why the sweeps above meet it only at their very first trim.
   *
   * **The windward side of the centreline is out of scope, and is worse.**
   * Every sweep in this file runs trim 0 to −90°, the side the sheet holds a sail
   * on. Carried the other way the band is wider and the fast branch does make
   * way — 1.306 kt split with a 0.827 kt branch at trim +4.75°, TWA 50.48° — but
   * a sail to windward is §3.4's *held* state rather than a trim, since releasing
   * it swings it back to leeward, so settling there needs the boom held across
   * for the couple of hundred frames it takes. Measured and named rather than
   * asserted over, because backing a sail is a transient by design.
   */
  it("leaves the boat stopped on both branches wherever rest is unstable", () => {
    const worst = worstAstrideRest(BOUND_WINDS);

    // **That the search reached what it measures.** Both bounds below are upper
    // bounds, and an upper bound over an empty set is vacuous — which is what
    // this test would become if the boundary scan stopped locating boundaries,
    // or if `branchesAstrideRest` stopped recognising an unstable rest. A
    // failure here is not necessarily bad news: a model that had genuinely
    // stopped folding at its no-go boundary would fail it too, and should,
    // because then the two bounds are guarding nothing and should be deleted
    // rather than left looking like protection.
    expect(worst.boundaries, "no no-go boundary was located at all").toBeGreaterThan(100);
    expect(worst.folds, "no boundary folds — see this test's docblock").toBeGreaterThan(0);

    // The property that makes it tolerable, and the one to defend: neither
    // branch is a boat that is sailing. Measured 0.482 kt.
    expect(worst.fastest, `a branch is under way at ${worst.fastestAt}`).toBeLessThan(0.6);

    // And the fork stays the size it is. Measured 0.699 kt; the pre-pos-i4o
    // curve put it at 2.93 kt.
    expect(worst.split, `widest astride rest at ${worst.where}`).toBeLessThan(1);
  }, 30_000);

  /**
   * **The property {@link worstAstrideRest} is built on**, which is what lets it
   * find the boundary once per trim and spend the saving on three hundred winds
   * instead of six. At rest the apparent wind is the true wind, so the drive is
   * `½ρW²·A` times a function of the angles alone; the wind enters as a positive
   * factor and a positive factor cannot move a zero crossing.
   *
   * Asserted rather than argued, because the argument stops holding the moment
   * anything in `sail.ts` reads the true wind for something other than a scale —
   * `depoweringFactor` already does, and is fine only because it is also a
   * positive factor. Something keyed to the wind that was not would break this
   * silently, and the search would then be reusing boundaries that had moved.
   */
  it("locates the same boundaries at every wind", () => {
    for (const jibSet of [false, true]) {
      for (let trim = 0; trim >= -90; trim -= 15) {
        const light = noGoBoundaries(jibSet, deg(trim), kt(4));
        const heavy = noGoBoundaries(jibSet, deg(trim), kt(30));
        const where = `${jibSet ? "sloop" : "main only"}, trim ${trim}°`;

        expect(heavy.length, `boundary count moved with the wind at ${where}`).toBe(light.length);
        for (let i = 0; i < light.length; i += 1) {
          expect(heavy[i], `boundary moved with the wind at ${where}`).toBeCloseTo(light[i], 9);
        }
      }
    }
  });

  /**
   * **The instrument check, and the thing it has to beat is the sweep upstairs.**
   * `leaves only cases where the boat is stopped on one of the branches` bounds
   * this same fold by settling on a grid of 15° in TWA and 2° in trim. The band
   * is half a degree wide. That grid lands on it at TWA 65°, trim 0° — and it
   * lands there by coincidence, which is not a property anyone chose and not one
   * that survives the constants moving.
   *
   * So: restore the pre-pos-i4o curve, where the band sits at TWA 36.3°–37.5°
   * instead, and check both halves of the claim. The search above finds a
   * **2.934 kt** fold with a **2.498 kt** fast branch at TWA 36.65°, trim 0° — a
   * boat sailing on one branch and drifting astern on the other. The settling
   * grid's cells either side of that band, TWA 35° and 50°, each report a single
   * settled speed to four decimals. The grid is not merely unlucky there; it has
   * nowhere to stand.
   *
   * Which is what makes the bound in the previous test worth more than the one
   * upstairs: it is derived from where the fold has to be rather than sampled in
   * the hope of meeting it.
   */
  it("finds a fold the settling sweep's grid has nowhere to stand on", () => {
    const foil = FOIL as { stallBlendWidth: number; maxLift: number };
    const savedBlend = foil.stallBlendWidth;
    const savedMaxLift = foil.maxLift;

    // Before pos-i4o: no maximum on the attached limb, and the old 20° blend.
    foil.maxLift = Infinity;
    foil.stallBlendWidth = deg(20);

    try {
      const worst = worstAstrideRest([6, 10, 14]);
      expect(worst.split, "the boundary search missed the pre-pos-i4o fold").toBeGreaterThan(2);
      expect(worst.fastest, "the pre-pos-i4o fast branch was not a boat sailing").toBeGreaterThan(2);

      // And the same fold, at the cells the settling sweep actually visits.
      for (const wind of [6, 10, 14]) {
        for (const twa of [35, 50]) {
          const state = boat(twa, true, 0, kt(wind));
          const fromRest = metersPerSecondToKnots(settle(state).motion.speed);
          const fromSpeed = metersPerSecondToKnots(
            settle({ ...state, motion: { heading: 0, speed: kt(wind * 1.2) } }).motion.speed,
          );

          expect(
            Math.abs(fromRest - fromSpeed),
            `the settling grid can see the band at ${wind} kt, TWA ${twa}° after all`,
          ).toBeLessThan(0.01);
        }
      }
    } finally {
      foil.stallBlendWidth = savedBlend;
      foil.maxLift = savedMaxLift;
    }
  }, 30_000);

  /**
   * **The fact the whole mechanism turns on, pinned where it can be broken.**
   * Both of §3.5's water charges are even and quadratic in speed, so the water
   * offers no *slope* at rest, only curvature. That is what leaves the rig's own
   * slope to decide whether rest is stable, and it is why no resistance constant
   * can be turned to remove the fold: `RESISTANCE.quadratic` and the wall both
   * arrive multiplied by a speed that has already gone to zero.
   *
   * **The claim is about rest itself, not about small speeds generally**, and
   * the difference matters. By the time the boat is on either branch — a couple
   * of tenths of a knot — the water is charging 15 N/(m/s) and is the whole
   * reason the runaway stops there rather than continuing. What it charges *at*
   * rest is zero, and that is the part that decides which way the boat leaves.
   *
   * So this pins the limit exactly and then pins the approach to it: the slope
   * is not merely small near rest, it is going to zero *with* the speed, a tenth
   * of the slope for a tenth of the speed. A linear damping term — the one change
   * that would genuinely remove the fold — would leave a constant there instead,
   * and fails both halves. §3.5 costs that option at more than doubling the
   * hull's resistance at a knot; this is where it would first show.
   */
  it("charges nothing for the water at rest, which is what leaves the drive to decide", () => {
    // A side force the keel is genuinely carrying close hauled, so the induced
    // drag term is not let off by a zero load.
    const sideForce = 500;
    const chordSlope = (knots: number) => {
      const speed = kt(knots);
      return (hullResistance(speed) + keelInducedDrag(speed, sideForce)) / speed;
    };

    // Exactly zero at rest, both terms, which is the fact §3.5 leans on.
    expect(hullResistanceSlope(0)).toBe(0);
    expect(hullResistance(0)).toBe(0);
    expect(keelInducedDrag(0, sideForce)).toBe(0);

    // And approached linearly rather than levelling off at some small constant:
    // a decade of speed is a decade of slope, twice over.
    const linear = "the water's slope is not linear in speed";
    expect(chordSlope(1e-3) / chordSlope(1e-4), linear).toBeCloseTo(10, 1);
    expect(chordSlope(1e-4) / chordSlope(1e-5), linear).toBeCloseTo(10, 1);

    // Which puts it four orders under the smallest drive slope measured at any
    // no-go boundary, 3.5 N/(m/s), by a hundredth of a knot of boat speed.
    expect(chordSlope(1e-5), "the water has a slope at rest after all").toBeLessThan(1e-3);
  });
});
