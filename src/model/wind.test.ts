import { describe, expect, it } from "vitest";

import { apparentWind, trueWindAngle } from "./wind.ts";
import type { BoatMotion, TrueWind } from "./wind.ts";
import {
  degreesToRadians,
  knotsToMetersPerSecond,
  metersPerSecondToKnots,
  radiansToDegrees,
} from "./units.ts";

const deg = degreesToRadians;
const kt = knotsToMetersPerSecond;

/**
 * The apparent wind for a boat on a given point of sail, stated the way the
 * design document states its cases: a true wind angle rather than a pair of
 * absolute bearings. The heading is a free parameter — only the angle between
 * heading and wind can matter — so every test can pick one, and
 * {@link acrossHeadings} checks that claim directly.
 */
function onPointOfSail(
  trueWindAngleDegrees: number,
  trueWindKnots: number,
  boatKnots: number,
  headingDegrees = 0,
): { speed: number; angle: number } {
  const wind: TrueWind = {
    from: deg(headingDegrees + trueWindAngleDegrees),
    speed: kt(trueWindKnots),
  };
  const boat: BoatMotion = { heading: deg(headingDegrees), speed: kt(boatKnots) };
  const apparent = apparentWind(wind, boat);
  return {
    speed: metersPerSecondToKnots(apparent.speed),
    angle: radiansToDegrees(apparent.angle),
  };
}

/** Headings spread around the compass, including both sides of the 0/360 seam. */
const HEADINGS = [0, 45, 90, 179, 180, 181, 270, 350, 359.9];

describe("apparent wind (DESIGN.md §3.1)", () => {
  it("equals the true wind when the boat is stopped", () => {
    for (const trueWindAngleDegrees of [0, 30, 90, 135, 180, -45, -90, -135]) {
      const apparent = onPointOfSail(trueWindAngleDegrees, 10, 0);
      expect(apparent.speed).toBeCloseTo(10, 9);
      expect(apparent.angle).toBeCloseTo(trueWindAngleDegrees, 9);
    }
  });

  it("adds the boat's speed head to wind", () => {
    const apparent = onPointOfSail(0, 10, 4);
    expect(apparent.speed).toBeCloseTo(14, 9);
    expect(apparent.angle).toBeCloseTo(0, 9);
  });

  it("subtracts it dead downwind", () => {
    const apparent = onPointOfSail(180, 10, 4);
    expect(apparent.speed).toBeCloseTo(6, 9);
    expect(Math.abs(apparent.angle)).toBeCloseTo(180, 9);
  });

  it("swings the wind ahead when the boat outruns it downwind", () => {
    const apparent = onPointOfSail(180, 10, 14);
    expect(apparent.speed).toBeCloseTo(4, 9);
    expect(apparent.angle).toBeCloseTo(0, 9);
  });

  /**
   * The knife-edge the {@link apparentWind} `CALM` branch exists for. Direction
   * is undefined here, and the convention is that it reads as the true wind
   * angle — the bearing the apparent wind fills in from as the boat slows.
   *
   * Swept across headings deliberately. The unguarded fall-through returns
   * `180° − heading`, which is right by coincidence at heading 0 and wrong
   * everywhere else, so pinning this at a single northerly heading would pass
   * with the guard deleted.
   */
  it("reports the true wind angle when running at exactly wind speed", () => {
    for (const headingDegrees of HEADINGS) {
      const apparent = onPointOfSail(180, 10, 10, headingDegrees);
      expect(apparent.speed).toBe(0);
      expect(Math.abs(apparent.angle)).toBeCloseTo(180, 9);
    }
  });

  /**
   * Hand-worked: 10 kt on the starboard beam, 5 kt of boat speed. The apparent
   * wind is the hypotenuse, √(10² + 5²) ≈ 11.18 kt, and it has drawn forward
   * from 90° to atan(10/5) ≈ 63.4° — a bigger shift than students expect, and
   * the whole reason a beam reach is trimmed well inside 90°.
   */
  it("matches the hand-worked beam reach", () => {
    const apparent = onPointOfSail(90, 10, 5);
    expect(apparent.speed).toBeCloseTo(Math.sqrt(125), 9);
    expect(apparent.angle).toBeCloseTo(63.4349488, 6);
  });

  it("mirrors exactly onto the other tack", () => {
    for (const trueWindAngleDegrees of [30, 63, 90, 135, 170]) {
      const starboard = onPointOfSail(trueWindAngleDegrees, 10, 5);
      const port = onPointOfSail(-trueWindAngleDegrees, 10, 5);
      expect(port.speed).toBeCloseTo(starboard.speed, 9);
      expect(port.angle).toBeCloseTo(-starboard.angle, 9);
    }
  });

  it("draws the wind steadily forward as the boat accelerates", () => {
    let previous = 90;
    for (let boatKnots = 0; boatKnots <= 6; boatKnots += 0.25) {
      const { angle } = onPointOfSail(90, 10, boatKnots);
      expect(angle).toBeLessThanOrEqual(previous + 1e-9);
      previous = angle;
    }
    expect(previous).toBeLessThan(65);
  });

  it("puts the wind further forward the faster the boat goes, upwind too", () => {
    const slow = onPointOfSail(45, 10, 2);
    const fast = onPointOfSail(45, 10, 5);
    expect(fast.angle).toBeLessThan(slow.angle);
    expect(fast.speed).toBeGreaterThan(slow.speed);
  });

  it("builds when the boat makes sternway under a following wind", () => {
    // Backing up runs the boat against the wind's direction of travel, so the
    // apparent wind strengthens instead of dying — still from dead astern.
    const apparent = onPointOfSail(180, 10, -3);
    expect(apparent.speed).toBeCloseTo(13, 9);
    expect(Math.abs(apparent.angle)).toBeCloseTo(180, 9);
  });

  it("depends only on the angle between heading and wind", () => {
    const reference = onPointOfSail(50, 12, 4, 0);
    for (const headingDegrees of HEADINGS) {
      const rotated = onPointOfSail(50, 12, 4, headingDegrees);
      expect(rotated.speed).toBeCloseTo(reference.speed, 9);
      expect(rotated.angle).toBeCloseTo(reference.angle, 9);
    }
  });

  it("never reports an angle outside (−180°, 180°]", () => {
    for (const headingDegrees of HEADINGS) {
      for (let trueWindAngleDegrees = -180; trueWindAngleDegrees < 180; trueWindAngleDegrees += 7) {
        const { angle } = onPointOfSail(trueWindAngleDegrees, 10, 5, headingDegrees);
        expect(angle).toBeGreaterThan(-180 - 1e-9);
        expect(angle).toBeLessThanOrEqual(180 + 1e-9);
      }
    }
  });
});

describe("true wind angle", () => {
  it("is the wind's bearing off the bow, across the seam", () => {
    const wind: TrueWind = { from: deg(10), speed: kt(10) };
    const boat: BoatMotion = { heading: deg(350), speed: kt(4) };
    expect(radiansToDegrees(trueWindAngle(wind, boat))).toBeCloseTo(20, 9);
  });

  it("is unaffected by boat speed", () => {
    const wind: TrueWind = { from: deg(120), speed: kt(10) };
    for (const speed of [-3, 0, 5]) {
      const boat: BoatMotion = { heading: deg(30), speed: kt(speed) };
      expect(radiansToDegrees(trueWindAngle(wind, boat))).toBeCloseTo(90, 9);
    }
  });
});
