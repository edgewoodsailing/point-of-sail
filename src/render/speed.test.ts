import { describe, expect, it } from "vitest";

import { HULL, STATIONS } from "../model/boat.ts";
import type { Vec2 } from "../model/units.ts";
import { knotsToMetersPerSecond, magnitude, subtract } from "../model/units.ts";
import { SCENE } from "./scene.ts";
import {
  SPEED_FULL_SCALE,
  SPEED_REACH,
  createSpeedLayer,
  speedArrowLength,
  speedArrowPathData,
  underWay,
} from "./speed.ts";

/**
 * Every measurement below is read back out of the emitted `d` string, because
 * that string is what the renderer actually hands the DOM. So the tolerance is
 * the *formatter's*, not the arithmetic's: `formatNumber` rounds to four
 * decimals, which puts up to a fifth of a millimetre on a length built from two
 * coordinates. On a boat measured in metres that is exactness enough.
 */
const METRES = 3;

/** The barb length written down in `speed.ts`, restated so the module cannot agree with itself. */
const ARROW_BARB = 0.4;

const kt = knotsToMetersPerSecond;

/** Every `x y` pair in some path data, in order. */
function pathPoints(d: string): Vec2[] {
  const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const points: Vec2[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i]!, y: numbers[i + 1]! });
  }
  return points;
}

/** Distance from the pivot, which is the scene origin and what the bands measure from. */
const fromPivot = (p: Vec2): number => magnitude(subtract(p, STATIONS.pivot));

/** The tip is the second point of the shaft. */
const tipOf = (speed: number): Vec2 => pathPoints(speedArrowPathData(speed))[1]!;

describe("speed arrow scale (DESIGN.md §4.1, §4.3)", () => {
  it("reaches exactly the band reserved for it, at hull speed", () => {
    // The calibration, and the reason `SPEED_REACH` is derived rather than
    // typed: `contentRadius` exists to hold this arrow at this speed, so the two
    // have to agree by construction and not by coincidence.
    expect(fromPivot(tipOf(SPEED_FULL_SCALE))).toBeCloseTo(SCENE.contentRadius, METRES);
    expect(fromPivot(tipOf(-SPEED_FULL_SCALE))).toBeCloseTo(SCENE.contentRadius, METRES);
    expect(SPEED_FULL_SCALE).toBeCloseTo(HULL.hullSpeed, 10);
  });

  it("gives the arrow room worth having — at least ¾ of a metre per knot-ish", () => {
    // The same claim `scene.test.ts` makes about the band, read from this side:
    // whatever the hull's figures become, the arrow must still be long enough at
    // hull speed to read as a length rather than as a tick.
    expect(SPEED_REACH / HULL.hullSpeed).toBeGreaterThan(0.75);
    expect(SPEED_REACH).toBeGreaterThan(2);
  });

  it("is linear in speed and never clamped", () => {
    const half = speedArrowLength(SPEED_FULL_SCALE / 2);
    expect(half).toBeCloseTo(SPEED_REACH / 2, METRES);
    expect(speedArrowLength(SPEED_FULL_SCALE)).toBeCloseTo(2 * half, METRES);
    // The decision §4.1 asks for in as many words: `contentRadius` is a
    // reservation, not a clamp. Above hull speed the arrow keeps growing and
    // crosses the wind ring rather than pretending 5.6 kt and 8 kt are the same.
    expect(speedArrowLength(kt(8))).toBeGreaterThan(SPEED_REACH);
    expect(fromPivot(tipOf(kt(8)))).toBeGreaterThan(SCENE.windRingRadius);
  });

  it("grows strictly with speed, and reads the same either way", () => {
    let previous = speedArrowLength(0);
    expect(previous).toBe(0);
    for (let knots = 0.25; knots <= 9; knots += 0.25) {
      const length = speedArrowLength(kt(knots));
      expect(length).toBeGreaterThan(previous);
      expect(speedArrowLength(kt(-knots))).toBeCloseTo(length, 12);
      previous = length;
    }
  });

  it("has no arrow at all below a length its own stroke would swallow", () => {
    expect(underWay(0)).toBe(false);
    expect(underWay(kt(0.1))).toBe(false);
    expect(underWay(kt(-0.1))).toBe(false);
    // A boat ghosting along at a quarter knot is moving, and should say so.
    expect(underWay(kt(0.25))).toBe(true);
    expect(underWay(kt(-0.25))).toBe(true);
  });
});

describe("speed arrow direction (DESIGN.md §3.4)", () => {
  it("projects off the bow with way on, and off the stern with sternway", () => {
    const ahead = pathPoints(speedArrowPathData(kt(4)));
    expect(ahead[0]!.y).toBeCloseTo(STATIONS.bow.y, METRES);
    // −y is forward in the boat frame, so a tip ahead of the bow is *above* it.
    expect(ahead[1]!.y).toBeLessThan(STATIONS.bow.y);

    const astern = pathPoints(speedArrowPathData(kt(-4)));
    expect(astern[0]!.y).toBeCloseTo(STATIONS.stern.y, METRES);
    expect(astern[1]!.y).toBeGreaterThan(STATIONS.stern.y);
  });

  it("stays on the centreline, so it never leans off to one side", () => {
    for (const knots of [-6, -3, -0.5, 0.5, 3, 6]) {
      const [station, tip] = pathPoints(speedArrowPathData(kt(knots)));
      expect(station!.x).toBeCloseTo(0, 6);
      expect(tip!.x).toBeCloseTo(0, 6);
    }
  });

  it("reaches equally far ahead and astern, because the pivot is amidships", () => {
    // Sternway is no longer the cramped case it was when the boat turned about
    // the mast — the arrow gets the same budget in both directions.
    for (const knots of [1, 3, 5.6, 8]) {
      expect(fromPivot(tipOf(kt(knots)))).toBeCloseTo(fromPivot(tipOf(kt(-knots))), 9);
    }
  });

  it("puts both barbs behind the tip, splayed either side of the shaft", () => {
    // The path runs station, tip, barb, tip, barb — the head is one stroke
    // through the tip rather than two, so the join rounds instead of forking.
    const [, tip, firstBarb, , secondBarb] = pathPoints(speedArrowPathData(kt(4)));
    // Behind, in the boat frame: nearer the transom than the tip is.
    expect(firstBarb!.y).toBeGreaterThan(tip!.y);
    expect(secondBarb!.y).toBeGreaterThan(tip!.y);
    // One either side of the centreline, evenly. Which barb is to port is not
    // worth asserting: the arrow is symmetric, so it carries no meaning.
    expect(firstBarb!.x).toBeCloseTo(-secondBarb!.x, 9);
    expect(Math.abs(firstBarb!.x)).toBeGreaterThan(0.1);
    // And they face the other way on sternway, or the head would be a tail.
    const sternway = pathPoints(speedArrowPathData(kt(-4)));
    expect(sternway[2]!.y).toBeLessThan(sternway[1]!.y);
    expect(sternway[4]!.y).toBeLessThan(sternway[1]!.y);
  });
});

describe("speed arrow head", () => {
  it("never outgrows half its own shaft, so a slow boat draws a small arrow", () => {
    for (let knots = 0.25; knots <= 9; knots += 0.25) {
      const speed = kt(knots);
      const [, tip, barb] = pathPoints(speedArrowPathData(speed));
      const spread = magnitude(subtract(barb!, tip!));
      expect(spread).toBeLessThanOrEqual(Math.min(ARROW_BARB, speedArrowLength(speed) / 2) + 1e-4);
    }
  });

  it("is full size everywhere the boat normally sails", () => {
    // The shrinking only bites below ~2.3 kt; above that the head is a constant
    // size in metres, which is what keeps the *length* the thing that encodes
    // speed rather than the whole shape scaling together.
    for (const knots of [3, 4, 5.6, 8]) {
      const [, tip, barb] = pathPoints(speedArrowPathData(kt(knots)));
      expect(magnitude(subtract(barb!, tip!))).toBeCloseTo(ARROW_BARB, 3);
    }
  });
});

describe("speed path data", () => {
  it("emits nothing a renderer would choke on, at any speed the model reaches", () => {
    for (let knots = -9; knots <= 9; knots += 0.1) {
      const data = speedArrowPathData(kt(knots));
      expect(data).not.toMatch(/NaN|Infinity|e[+-]/i);
      expect(data).not.toMatch(/(^|\s)-0(\s|$)/);
    }
  });

  it("exports a layer factory", () => {
    // The DOM half is exercised by hand in the browser, as `createHullLayer` and
    // `createSailLayer` are; the suite runs in node.
    expect(typeof createSpeedLayer).toBe("function");
  });
});
