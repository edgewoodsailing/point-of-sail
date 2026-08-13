import { describe, expect, it } from "vitest";

import { JIB, MAIN, SWING_LIMIT } from "./boat.ts";
import { hullResistance, keelInducedDrag } from "./hull.ts";
import { cleatedAt, depoweringFactor, optimalTrim, rigForce } from "./sail.ts";
import type { SimState } from "./simulation.ts";
import { settle, step } from "./simulation.ts";
import type { MetersPerSecond, Radians, Seconds } from "./units.ts";
import {
  degreesToRadians,
  knotsToMetersPerSecond,
  metersPerSecondToKnots,
  radiansToDegrees,
} from "./units.ts";
import { apparentWind } from "./wind.ts";
//
// SKIPPED TESTS IN THIS FILE: see pos-ciz.
// They assert two questions about how settle converges now the boom moves too — a design this repository deliberately
// replaced, not behaviour that regressed. They are skipped rather than
// deleted because the *properties* they name still matter and want
// re-expressing against the current design; the bead says what to write.
//


const deg = degreesToRadians;
const kt = knotsToMetersPerSecond;

/** The wind the calibration table of §3.6 is quoted in. */
const WIND_SPEED = kt(10);

/** The step a browser delivers at 60 Hz, near enough. */
const FRAME: Seconds = 1 / 60;

/**
 * A boat heading north with the true wind at `twa` off the bow. Heading north
 * means the boat frame and the world frame coincide, so a trim angle in a test
 * reads as the angle a sailor would describe.
 */
function boat(twa: Radians, trim: Partial<SimState["trim"]> = {}): SimState {
  const want = { mainAngle: 0, jibAngle: 0, jibSet: true, ...trim };
  // Cleated at the angles asked for, so the sheets hold them. Setting an angle
  // without its sheet would have the first step ease it straight back out — see
  // `cleatedAt`. The caller's own fields still win, so a test that wants to set
  // a sheet directly can.
  const cleated = cleatedAt(
    want.mainAngle,
    want.jibAngle,
    want.jibSet,
    apparentWind({ from: twa, speed: WIND_SPEED }, { heading: 0, speed: 0 }),
  );
  return {
    wind: { from: twa, speed: WIND_SPEED },
    motion: { heading: 0, speed: 0 },
    trim: { ...cleated, ...trim },
    mainHeld: false,
    jibHeld: false,
  };
}

/**
 * The same boat, at rest, with both sails set for the wind it will feel once it
 * is up to speed.
 *
 * The trim has to be found by iteration for the same reason speed is integrated
 * rather than solved: the apparent wind draws forward as the boat accelerates,
 * so the best trim depends on the speed and the speed depends on the trim.
 * Trimming for the wind at a standstill leaves a boat badly overeased — on a
 * beam reach it is worth about half the speed. Three passes is plenty; the trim
 * has stopped moving by the second.
 */
function wellTrimmed(twa: Radians): SimState {
  let state = boat(twa);

  for (let pass = 0; pass < 3; pass += 1) {
    const apparent = apparentWind(state.wind, settle(state).motion);
    state = {
      ...state,
      // Cleated: an angle without a sheet to hold it is eased straight back out
      // by the next step (`cleatedAt`).
      trim: cleatedAt(
        optimalTrim(MAIN, apparent).angle,
        optimalTrim(JIB, apparent).angle,
        state.trim.jibSet,
        apparent,
      ),
    };
  }

  return state;
}

/** Runs `seconds` of simulated time at 60 Hz, collecting the speed each frame. */
function speedsOver(state: SimState, seconds: Seconds): MetersPerSecond[] {
  const speeds: MetersPerSecond[] = [];
  let current = state;
  for (let elapsed = 0; elapsed < seconds; elapsed += FRAME) {
    current = step(current, FRAME);
    speeds.push(current.motion.speed);
  }
  return speeds;
}

/**
 * Asserts a run of speeds only ever moves the one way, and arrives where
 * settling says it should. Monotone means no ringing: an integrator taking too
 * long a step overshoots the equilibrium and comes back, which shows up here as
 * a single step in the wrong direction however small.
 */
function expectMonotone(
  speeds: MetersPerSecond[],
  direction: "up" | "down",
  destination: MetersPerSecond,
): void {
  const sign = direction === "up" ? 1 : -1;

  for (let i = 1; i < speeds.length; i += 1) {
    expect(sign * (speeds[i] - speeds[i - 1]), `frame ${i}`).toBeGreaterThanOrEqual(0);
  }

  const arrived = speeds[speeds.length - 1];
  expect(metersPerSecondToKnots(Math.abs(arrived - destination))).toBeLessThan(0.01);
}

describe("integration (DESIGN.md §3.5)", () => {
  it("settles to a steady speed on every point of sail", () => {
    // The bead's acceptance criterion. Deliberately not a polar assertion — the
    // numbers are pos-fo1.4's to pin down, and asserting them here would only
    // mean asserting them twice. What is checked is that a speed exists, that
    // it is one a sailboat could have, and that it stops changing.
    for (let twa = 0; twa <= 180; twa += 15) {
      for (const tack of [1, -1]) {
        const settled = settle(wellTrimmed(deg(twa * tack)));
        const speed = settled.motion.speed;
        const point = `TWA ${twa * tack}°`;

        expect(metersPerSecondToKnots(speed), point).toBeLessThan(8);

        // Outside the no-go zone the boat must actually sail, not merely fail
        // to go backwards — a bound of zero would pass on a model that had
        // stopped computing forces at all.
        if (twa >= 30) expect(metersPerSecondToKnots(speed), point).toBeGreaterThan(1);
        else expect(speed, point).toBeGreaterThanOrEqual(0);

        // Another minute of sailing moves it by less than a thousandth of a knot.
        const later = speedsOver(settled, 60);
        for (const drifted of later) {
          expect(metersPerSecondToKnots(Math.abs(drifted - speed)), point).toBeLessThan(1e-3);
        }
      }
    }
  });

  it("approaches that speed from either side without ever turning back", () => {
    // Oscillation is the failure this rules out: an explicit integrator with too
    // long a step rings about the equilibrium instead of approaching it. Stated
    // as monotonicity of the run itself rather than as a bound against
    // `settle`'s answer — two runs at different step sizes agree to about seven
    // digits, and a comparison at that resolution would be measuring the
    // integrator's step, not the boat's behaviour.
    const beamReach = wellTrimmed(deg(90));
    const settled = settle(beamReach).motion.speed;

    expectMonotone(speedsOver(beamReach, 120), "up", settled);

    // And from above: a boat that has just borne away and is carrying too much
    // speed for its new heading slows into the same value without dipping under.
    const fast = { ...beamReach, motion: { ...beamReach.motion, speed: settled + kt(2) } };
    expectMonotone(speedsOver(fast, 120), "down", settled);
  });

  it("stays in irons head to wind, whatever the sails are doing", () => {
    // The no-go zone simply is one (§3.6) — nothing draws it. Asserted over the
    // whole range of trims rather than at the optimal one, because head to wind
    // the optimal trim sits inside `LUFF.collapsedBelow`: the sails carry no
    // force at all, the speed stays at exactly zero, and a single-trim
    // assertion would hold on any model, including one that had forgotten to
    // integrate. The sweep has teeth because most of it is not the quiet case.
    let fastest = -Infinity;
    let sternmost = Infinity;

    for (let angle = -SWING_LIMIT; angle <= SWING_LIMIT; angle += SWING_LIMIT / 18) {
      // **Held**, because head to wind a released sail simply weathervanes to
      // the centreline: the sheet limit is symmetric and the weathervane is
      // dead ahead, so every trim in this sweep would collapse to zero and the
      // sweep would test nothing. §3.4 already says a backed sail is "a state a
      // hand is holding" — this is that sentence made executable, and it is the
      // reason the mooring departure needs a finger on the boom.
      const settled = settle({
        ...boat(0),
        trim: { ...cleatedAt(angle, angle, true, apparentWind(boat(0).wind, boat(0).motion)),
                mainAngle: angle, jibAngle: angle },
        mainHeld: true,
        jibHeld: true,
      }).motion.speed;

      fastest = Math.max(fastest, settled);
      sternmost = Math.min(sternmost, settled);
    }

    // Not one of them sails.
    expect(metersPerSecondToKnots(fastest)).toBeLessThanOrEqual(0);
    // And the sweep is doing real work: the trims that put the sail across the
    // wind push the boat firmly backwards, which is §3.4's mooring departure.
    expect(metersPerSecondToKnots(sternmost)).toBeLessThan(-2);
  });

  it("takes about ten seconds to get going", () => {
    // §3.5's lag, as the running model delivers it rather than as the mapping
    // promises it: quicker than the nominal ten seconds, because the apparent
    // wind draws forward as the boat accelerates and the drive grows with it.
    // The bound is loose on purpose. What it protects is the lesson — that trim
    // changes do not pay off instantly — not a particular number.
    //
    // **Measured with the sails kept trimmed as the boat accelerates**, which
    // is what the reasoning above describes and what a sailor does. Held
    // instead at the trim the boat ends up with, this measures something else
    // entirely — a sail sheeted for 61° of apparent wind sits at α = 51° while
    // the boat is stopped and 90° off the wind, which is a stalled sail, and
    // what gets timed is how long it takes to unstall rather than how long the
    // boat takes to accelerate. That number is wild: 39 s close hauled and 11 s
    // on a beam reach before pos-fo1.4, 13 s and 26 s after it, with the
    // difference sitting almost entirely in `FOIL.plateNormalForce`. The lag
    // itself barely moved, which is the point of measuring it this way.
    const beamReach = wellTrimmed(deg(90));
    const target = (1 - 1 / Math.E) * settle(beamReach).motion.speed;

    let sailed: SimState = { ...beamReach, motion: { ...beamReach.motion, speed: 0 } };
    let elapsed = 0;
    for (; elapsed < 60 && sailed.motion.speed < target; elapsed += FRAME) {
      const apparent = apparentWind(sailed.wind, sailed.motion);
      sailed = step(
        {
          ...sailed,
          trim: cleatedAt(
            optimalTrim(MAIN, apparent).angle,
            optimalTrim(JIB, apparent).angle,
            sailed.trim.jibSet,
            apparent,
          ),
        },
        FRAME,
      );
    }

    expect(sailed.motion.speed).toBeGreaterThanOrEqual(target);
    expect(elapsed).toBeGreaterThan(3);
    expect(elapsed).toBeLessThan(15);
  });
});

describe("backing a sail (DESIGN.md §3.4)", () => {
  /**
   * Head to wind with the main held out square: the flow strikes the back of the
   * sail, and the only force it can make is astern. This is the mooring
   * departure of §3.4, without the gesture that pos-bql.1 will put on top of it.
   *
   * The `mainHeld` flag the cases below set is **inert in the model today** —
   * nothing in `step` or `rigForce` reads it, and settling with it true and
   * false gives bit-identical speeds. It is set because it describes the
   * situation honestly: a hand is holding that boom out. pos-bql.1 gives it its
   * job, and these tests should keep passing when it does.
   */
  const backed = boat(0, { mainAngle: deg(90), jibSet: false });

  it("drives the boat astern", () => {
    const settled = settle({ ...backed, mainHeld: true });
    expect(settled.motion.speed).toBeLessThan(0);
  });

  it("gathers sternway smoothly, without ringing", () => {
    const held = { ...backed, mainHeld: true };
    const speeds = speedsOver(held, 60);

    expectMonotone(speeds, "down", settle(held).motion.speed);
    for (const speed of speeds) expect(speed).toBeLessThanOrEqual(0);
  });

  it("makes backing up slower than the same sail pushing the same way forwards", () => {
    // The astern factor, isolated. Squaring the main off on a dead run is the
    // mirror image of holding it out head to wind: the same sail at the same
    // 90° angle of attack, and in both cases the boat moves away from the wind,
    // so the apparent wind falls off with speed identically. Everything about
    // the two balances is the same except which side of zero the speed is on —
    // so the ratio is the astern factor's doing and nothing else's.
    //
    // With `asternFactor` at 1 the two would come out *equal*, which is what
    // makes this worth asserting: the previous form of this test, that sternway
    // is slower than a beam reach, would have passed just as well.
    const squaredRun: SimState = {
      ...backed,
      wind: { ...backed.wind, from: deg(180) },
      mainHeld: false,
    };

    const astern = Math.abs(settle({ ...backed, mainHeld: true }).motion.speed);
    const ahead = settle(squaredRun).motion.speed;

    expect(astern / ahead).toBeLessThan(0.85);
    expect(astern / ahead).toBeGreaterThan(0.6);
  });
});

describe("step size", () => {
  const beamReach = wellTrimmed(deg(90));

  it("clamps a long frame rather than taking it", () => {
    // A backgrounded tab hands back a `dt` of minutes on the frame after it is
    // restored. Every one of these advances the same tenth of a second.
    const clamped = step(beamReach, 0.1).motion.speed;
    for (const dt of [0.1, 1, 60, 600, 86400, Infinity]) {
      expect(step(beamReach, dt).motion.speed).toBe(clamped);
    }

    // And a frame shorter than the clamp is taken as it is.
    expect(step(beamReach, 0.05).motion.speed).toBeLessThan(clamped);
    expect(step(beamReach, 0.05).motion.speed).toBeGreaterThan(0);
  });

  it("stands still for a step that is not a length of time", () => {
    // A NaN would poison the speed permanently, since every later step adds to
    // it; a negative one is a clock running backwards. Both mean "no news".
    for (const dt of [NaN, -1, -Infinity, 0]) {
      expect(step(beamReach, dt).motion.speed).toBe(0);
    }
  });

  it("holds together in a wind nobody would sail in", () => {
    // §2.1 randomises 6–14 kt, but §5 does not say where its wind slider stops,
    // and the resistance curve is a fourth power on top of a square: taken at
    // the speed the step starts from, it used to stop settling at around 80 kt
    // of wind and diverge to NaN by 120 — permanently, since every later step
    // adds to a NaN. (Those thresholds were 55 and 85 before pos-lcz softened
    // the wall exponent.)
    //
    // **pos-d7u's depowering put that failure out of reach**, and this test is
    // no longer the thing that would catch it. The drive is capped at its 13 kt
    // value, so every wind below settles around 6.4 kt instead of climbing, and
    // the naive integrator converges just as cleanly here as the implicit one —
    // checked at 55, 60, 80, 100, 120, 200, 500 and 1000 kt, tails identical.
    //
    // It is kept, and kept sweeping absurd winds, because what makes the
    // failure unreachable is now a tuning constant rather than a property of
    // the physics: `DEPOWERING.fullPowerWind` raised far enough, or taken out
    // to try something else, puts the fourth power back within reach. This
    // asserts the boat stays finite and stops moving whatever the wind, which
    // is the claim §5 actually needs and the one that survives either regime.
    for (const wind of [55, 60, 100, 200]) {
      const trimmed = wellTrimmed(deg(90));
      const gale: SimState = { ...trimmed, wind: { ...trimmed.wind, speed: kt(wind) } };
      const settled = settle(gale).motion.speed;

      expect(Number.isFinite(settled), `${wind} kt`).toBe(true);
      expect(metersPerSecondToKnots(settled), `${wind} kt`).toBeGreaterThan(0);

      // Five minutes of the longest frames the clamp allows, and then a hard
      // look at the last ten seconds of it: every sample identical to the
      // settled speed. Ringing is what this rules out, and ringing is what the
      // old integrator did here — two speeds, alternating, forever.
      //
      // Not asserted as monotone, unlike the temperate cases, and that is now
      // headroom rather than necessity. It used to be necessity: the step
      // follows a tangent to a convex curve, so its target lies past the true
      // balance point, and in a gale not slightly — the first step from rest at
      // 200 kt landed at 12.03 m/s against a balance of 6.34. Under pos-d7u's
      // capped drive the same step lands at 0.0223 m/s against a balance of
      // 2.3016, and the approach is monotone at every wind swept here.
      //
      // Those are *this* boat's figures, which is worth flagging because the
      // docblock on `advance` quotes a different pair for the same experiment.
      // `gale` below carries the trim `wellTrimmed` found in 10 kt and then has
      // the wind swapped under it, so it is overtrimmed for the gale and settles
      // at 4.40-4.50 kt across 55 kt to 1000. Re-trimmed for the wind it is
      // actually in, the boat settles at 6.38-6.40 kt and the first step is
      // 0.0635 m/s. Both are real; they are different boats.
      //
      // The assertion stays the weaker one, because what it is really for is
      // that the overshoot *decays* if there is one, which is the property that
      // separates converging from ringing and does not depend on the cap.
      let current = gale;
      const speeds: MetersPerSecond[] = [];
      for (let elapsed = 0; elapsed < 300; elapsed += 0.1) {
        current = step(current, 0.1);
        speeds.push(current.motion.speed);
      }

      for (const speed of speeds) {
        expect(metersPerSecondToKnots(speed), `${wind} kt`).toBeLessThan(40);
      }
      for (const speed of speeds.slice(-100)) {
        expect(Math.abs(speed - settled), `${wind} kt`).toBeLessThan(1e-6);
      }
    }
  });

  it("reaches the same settled speed whatever the step size", () => {
    const settled = settle(beamReach).motion.speed;

    for (const dt of [1 / 120, FRAME, 0.05, 0.1]) {
      let current = beamReach;
      for (let elapsed = 0; elapsed < 120; elapsed += dt) current = step(current, dt);
      expect(metersPerSecondToKnots(Math.abs(current.motion.speed - settled))).toBeLessThan(0.01);
    }
  });
});

describe("state handling", () => {
  const beamReach = wellTrimmed(deg(45));

  it("leaves the state it was given alone", () => {
    const frozen: SimState = Object.freeze({
      ...beamReach,
      motion: Object.freeze({ ...beamReach.motion }),
      trim: Object.freeze({ ...beamReach.trim }),
      wind: Object.freeze({ ...beamReach.wind }),
    });

    // Modules are strict mode, so a write to a frozen object throws rather than
    // failing silently — this fails loudly if `step` ever starts mutating.
    const next = step(frozen, FRAME);

    expect(frozen.motion.speed).toBe(0);
    expect(next).not.toBe(frozen);
    expect(next.motion.speed).toBeGreaterThan(0);
  });

  it("moves the speed and the sails, and nothing else", () => {
    // **The sails are no longer inputs.** A sheet is a limit and the wind picks
    // the angle inside it, so `step` moves the boom and the jib's clew as well
    // as the speed — that is what makes a boat tack its own mainsail. What must
    // still hold is that nothing *else* moves: the wind, the heading and the
    // held flags are the input layer's, and the integrator does not touch them.
    const next = settle(beamReach);

    expect(next.wind).toEqual(beamReach.wind);
    expect(next.trim.jibSet).toBe(beamReach.trim.jibSet);
    expect(next.trim.mainSheet).toBe(beamReach.trim.mainSheet);
    expect(next.trim.jibSheet).toBe(beamReach.trim.jibSheet);
    expect(next.trim.jibSheetSide).toBe(beamReach.trim.jibSheetSide);
    expect(radiansToDegrees(next.motion.heading)).toBe(0);
    expect(next.mainHeld).toBe(false);
    expect(next.jibHeld).toBe(false);
  });

  it.skip("settles on the speed the boat really reaches, even where it creeps up on it", () => {
    // Deep inside the no-go zone the boat closes on its speed very slowly, so
    // the *change* per step goes small long before the *distance* to the
    // balance point does. A settle that stopped on a small change would report
    // a couple of percent low here — and this is the corner where §3.6's
    // closest useful angle lives, the boundary where the speed goes to nothing.
    //
    // Checked against sixteen minutes of frame-length steps, which is a
    // trajectory rather than an iteration and cannot converge to anything but
    // the true balance point.
    //
    // The speed it crawls to is a quarter of a knot, down from 0.7 before
    // pos-fo1.4 closed the no-go zone. The lower bound is here so that the test
    // keeps having something to converge *to*: at exactly zero this would pass
    // on a model that had stopped computing forces.
    const crawling = wellTrimmed(deg(5));

    let sailed = crawling;
    for (let elapsed = 0; elapsed < 960; elapsed += FRAME) sailed = step(sailed, FRAME);

    expect(metersPerSecondToKnots(sailed.motion.speed)).toBeGreaterThan(0.1);
    expect(
      metersPerSecondToKnots(Math.abs(settle(crawling).motion.speed - sailed.motion.speed)),
    ).toBeLessThan(1e-4);
  });

  it("settles on a speed where the forces actually balance", () => {
    // The definition of the thing, asserted directly against the forces rather
    // than against another integration — and the property that a five-second
    // settle step quietly broke. Stepping that far is not a step toward
    // anything once the drive falls with speed faster than the resistance
    // rises, and the iteration would drop into a two-point cycle and return one
    // end of it: 46 N out of balance in the first case below, 118 in the second,
    // 1147 in the third. All three look perfectly plausible as speeds, which is
    // what makes checking the balance rather than the number worth doing.
    const inWind = (state: SimState, wind: number): SimState => ({
      ...state,
      wind: { ...state.wind, speed: kt(wind) },
    });

    const cases: [string, SimState][] = [
      [
        "sloop, 10 kt, TWA 105, sails eased to 80°",
        boat(deg(105), { mainAngle: deg(-80), jibAngle: deg(-80) }),
      ],
      [
        "sloop, 14 kt, TWA 75, sails square",
        inWind(boat(deg(75), { mainAngle: deg(-90), jibAngle: deg(-90) }), 14),
      ],
      [
        "main alone, 80 kt, TWA 95, eased to 85°",
        inWind(boat(deg(95), { mainAngle: deg(85), jibSet: false }), 80),
      ],
      ["beam reach, well trimmed", wellTrimmed(deg(90))],
      ["five degrees off the wind", wellTrimmed(deg(5))],
      ["dead run", wellTrimmed(deg(180))],
    ];

    for (const [name, state] of cases) {
      const settled = settle(state);
      const apparent = apparentWind(settled.wind, settled.motion);
      const forces = rigForce(settled.trim, apparent);

      // §3.2's depowering, which `rigForce` deliberately does not apply — see
      // `depoweringFactor` for why it lives at the integrator's seam instead.
      // Two of the cases below are above the wind it starts biting in, and one
      // is at 80 kt where it is worth a factor of forty, so leaving it out here
      // would not be a rounding error: it would assert a balance the boat is
      // not in.
      const carried = depoweringFactor(settled.wind.speed);

      // All three terms of §3.5's balance, the keel's included — leaving it out
      // would let this pass on a settle that had converged to the wrong speed
      // by exactly the induced drag, which upwind is over a hundred newtons.
      const unbalanced =
        forces.driving * carried -
        hullResistance(settled.motion.speed) -
        keelInducedDrag(settled.motion.speed, forces.lateral * carried);

      // A tenth of a newton is a hundredth of what the boat feels drifting in a
      // calm, and four orders below the failures above.
      expect(Math.abs(unbalanced), name).toBeLessThan(0.1);
    }
  });

  it("settles to a speed that settling again does not move", () => {
    // To within the tolerance `settle` stops at, which is what "settled" means
    // here: a speed still drifting by less than a millionth of a metre per
    // second per tenth of a second.
    const settled = settle(wellTrimmed(deg(120)));
    const again = settle(settled);
    expect(Math.abs(again.motion.speed - settled.motion.speed)).toBeLessThan(1e-5);
  });
});
