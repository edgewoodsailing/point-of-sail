import { describe, expect, it } from "vitest";

import { JIB, MAIN, SWING_LIMIT } from "./boat.ts";
import { optimalTrim } from "./sail.ts";
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
  return {
    wind: { from: twa, speed: WIND_SPEED },
    motion: { heading: 0, speed: 0 },
    trim: { mainAngle: 0, jibAngle: 0, jibSet: true, ...trim },
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
      trim: {
        ...state.trim,
        mainAngle: optimalTrim(MAIN, apparent).angle,
        jibAngle: optimalTrim(JIB, apparent).angle,
      },
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
      const settled = settle({
        ...boat(0),
        trim: { mainAngle: angle, jibAngle: angle, jibSet: true },
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
    const beamReach = wellTrimmed(deg(90));
    const target = (1 - 1 / Math.E) * settle(beamReach).motion.speed;

    const speeds = speedsOver(beamReach, 60);
    const frames = speeds.findIndex((speed) => speed >= target);

    expect(frames).toBeGreaterThan(0);
    expect(frames * FRAME).toBeGreaterThan(5);
    expect(frames * FRAME).toBeLessThan(15);
  });
});

describe("backing a sail (DESIGN.md §3.4)", () => {
  /**
   * Head to wind with the main held out square: the flow strikes the back of the
   * sail, and the only force it can make is astern. This is the mooring
   * departure of §3.4, without the gesture that pos-bql.1 will put on top of it.
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
    // §2.1 randomises 6–14 kt, but §5's wind slider has no stated ceiling, and
    // the resistance curve is a sixth power on top of a square: taken at the
    // speed the step starts from, it rings between two speeds by about 40 kt of
    // wind and diverges to NaN by 80 — permanently, since every later step adds
    // to a NaN. `advance` takes the resistance implicitly precisely so that
    // whoever sets that ceiling is choosing a lesson, not avoiding a trap.
    for (const wind of [40, 60, 100, 200]) {
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
      // Not asserted as monotone, unlike the temperate cases: above about 100 kt
      // the first step or two can overshoot, because it is the *drive* that
      // collapses with speed there and only the resistance is taken implicitly.
      // Overshooting once and converging is a different animal from ringing,
      // and this is not a wind anyone will sail the boat in anyway.
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

  it("moves nothing but the speed", () => {
    const next = settle(beamReach);

    expect(next.wind).toEqual(beamReach.wind);
    expect(next.trim).toEqual(beamReach.trim);
    expect(radiansToDegrees(next.motion.heading)).toBe(0);
    expect(next.mainHeld).toBe(false);
    expect(next.jibHeld).toBe(false);
  });

  it("settles on the speed the boat really reaches, even where it creeps up on it", () => {
    // Just outside the no-go zone the boat closes on its speed at about 0.023
    // per second, so the *change* per step goes small long before the *distance*
    // to the balance point does. A settle that stopped on a small change would
    // report a couple of percent low here — and this is exactly the corner where
    // pos-fo1.4 has to find the closest useful angle, which is the boundary
    // where the speed goes to nothing.
    //
    // Checked against sixteen minutes of frame-length steps, which is a
    // trajectory rather than an iteration and cannot converge to anything but
    // the true balance point.
    const crawling = wellTrimmed(deg(5));

    let sailed = crawling;
    for (let elapsed = 0; elapsed < 960; elapsed += FRAME) sailed = step(sailed, FRAME);

    expect(metersPerSecondToKnots(sailed.motion.speed)).toBeGreaterThan(0.4);
    expect(
      metersPerSecondToKnots(Math.abs(settle(crawling).motion.speed - sailed.motion.speed)),
    ).toBeLessThan(1e-4);
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
