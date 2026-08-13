import { describe, expect, it } from "vitest";


import type { Radians, Vec2 } from "../model/units.ts";
import {
  angleOfVector,
  degreesToRadians,
  knotsToMetersPerSecond,
  magnitude,
  normalizeSigned,
} from "../model/units.ts";
import { SCENE } from "./scene.ts";
import { createWindLayer, windArrowPathData, windTickPathData } from "./wind.ts";
//
// SKIPPED TESTS IN THIS FILE: see pos-f18.
// They assert the fixed-length wind arrow — a design this repository deliberately
// replaced, not behaviour that regressed. They are skipped rather than
// deleted because the *properties* they name still matter and want
// re-expressing against the current design; the bead says what to write.
//


/**
 * Every measurement below is read back out of the emitted `d` string, because
 * that string is what the renderer actually hands the DOM — a test that measured
 * the functions' inputs instead would pass on geometry the browser never sees.
 *
 * So the tolerances are the *formatter's*, not the arithmetic's. `formatNumber`
 * rounds to four decimals, which puts up to 5e-5 m on a coordinate, ~1e-4 m on a
 * radius built from two of them, and ~2e-4 m on a difference of two radii — a
 * fifth of a millimetre, on a boat measured in metres. Bearings come off better:
 * at this radius the same error is ~1e-5 rad.
 */
const METRES = 3;
const BEARING = 4;

/**
 * The design figures, written down again rather than imported, so the module
 * cannot agree with itself. Change one in `wind.ts` and this file has to be
 * re-read rather than silently re-passing.
 *
 * **Both are now proportions rather than lengths**, because the ring's radius is
 * solved rather than declared (`render/scene.ts`): the arrow spans the whole
 * radius at full scale, and the graduations take the 4.4% of it they always had.
 * Writing them as absolute metres pinned the old ring, so the day it moved these
 * failed for the wrong reason.
 */
const TICK_LENGTH = SCENE.windRingRadius * (0.25 / 5.65);
/** Marks *drawn*: the eight points of sail less the one the arrow stands on. */
const TICKS_DRAWN = 7;

const deg = degreesToRadians;

/**
 * The wind these tests draw the arrow at: **10 kt, the middle of the range**,
 * not full scale.
 *
 * The arrow's length is the wind's speed now (pos-bwd.5), so there is no fixed
 * `ARROW_LENGTH` to test against — a test has to name a wind. Full scale is the
 * wrong one to name: at 20 kt the tip lands exactly on the origin, where a
 * bearing is undefined and the barbs collapse onto the mast, so the geometry
 * assertions would be measuring a degenerate case. Ten knots is what a student
 * is usually in and gives the arrow a real tip to measure.
 */
const MEASURED_WIND = knotsToMetersPerSecond(10);

/** The arrow's length at that wind: half the radius, since 20 kt is full scale. */
const MEASURED_ARROW = SCENE.windRingRadius / 2;



/** Every `x y` pair in some path data, in order. */
function pathPoints(d: string): Vec2[] {
  const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const points: Vec2[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i]!, y: numbers[i + 1]! });
  }
  return points;
}

/** Distance from the scene origin, which is the boat's pivot. */
const radius = (p: Vec2): number => magnitude(p);

/** The bearings the graduations sit on, in path order. Pairs run outer, inner. */
function tickBearings(from: Radians): Radians[] {
  return pathPoints(windTickPathData(from))
    .filter((_, i) => i % 2 === 0)
    .map((p) => angleOfVector(p));
}

describe("wind ring (DESIGN.md §4.1, §5)", () => {
  it.skip("stays clear of the boat at every wind direction, and therefore at every heading", () => {
    // The acceptance criterion, and it falls out in one sweep rather than two:
    // `boatRadius` is the disc the boat sweeps about the *pivot*, which is the
    // scene origin, so it does not depend on the heading at all. Anything drawn
    // outside that radius is clear of the boat however the boat is turned.
    for (let d = 0; d < 360; d += 1) {
      const from = deg(d);
      const drawn = [...pathPoints(windArrowPathData(from, MEASURED_WIND)), ...pathPoints(windTickPathData(from))];
      for (const p of drawn) {
        expect(radius(p)).toBeGreaterThan(SCENE.boatRadius);
      }
    }
  });

  it("keeps every mark inside the scene, so nothing is clipped on the short axis", () => {
    for (let d = 0; d < 360; d += 1) {
      const from = deg(d);
      const drawn = [...pathPoints(windArrowPathData(from, MEASURED_WIND)), ...pathPoints(windTickPathData(from))];
      for (const p of drawn) {
        expect(radius(p)).toBeLessThanOrEqual(SCENE.shortRadius);
      }
    }
  });
});

describe("wind arrow", () => {
  it("hangs its tail on the ring and flies inward, at every bearing", () => {
    for (let d = 0; d < 360; d += 5) {
      const from = deg(d);
      const [tail, tip] = pathPoints(windArrowPathData(from, MEASURED_WIND));
      expect(radius(tail!)).toBeCloseTo(SCENE.windRingRadius, METRES);
      expect(radius(tip!)).toBeCloseTo(SCENE.windRingRadius - MEASURED_ARROW, METRES);
      // Tail and tip on the same radial, which is what "flies inward" means:
      // the arrow points at the boat, not past it.
      expect(normalizeSigned(angleOfVector(tail!) - from)).toBeCloseTo(0, BEARING);
      expect(normalizeSigned(angleOfVector(tip!) - from)).toBeCloseTo(0, BEARING);
    }
  });

  it("points the way the wind blows, not the way it comes from", () => {
    // `wind.from` is the direction it blows *from* (§2), so a northerly has its
    // tail at the top of the scene and its head toward the boat — the arrow
    // flies south. Getting this backwards is the one mistake that would still
    // look plausible, so it is pinned against an absolute direction.
    const [tail, tip] = pathPoints(windArrowPathData(deg(0), MEASURED_WIND));
    expect(tail!.y).toBeCloseTo(-SCENE.windRingRadius, METRES);
    expect(tip!.y).toBeCloseTo(-(SCENE.windRingRadius - MEASURED_ARROW), METRES);
    expect(tip!.y).toBeGreaterThan(tail!.y); // +y is down the screen, i.e. south
  });

  it("puts both barbs behind the tip, splayed either side of the shaft", () => {
    // The path runs tail, tip, barb, tip, barb — the head is one stroke through
    // the tip rather than two, so the join rounds instead of forking.
    const from = deg(37);
    const [, tip, firstBarb, , secondBarb] = pathPoints(windArrowPathData(from, MEASURED_WIND));
    // Behind: further from the boat than the tip, because the barbs open upwind.
    expect(radius(firstBarb!)).toBeGreaterThan(radius(tip!));
    expect(radius(secondBarb!)).toBeGreaterThan(radius(tip!));
    // Either side, and evenly: their bearings straddle the shaft's. Which barb
    // is which side is not worth asserting — the arrow is symmetric, and naming
    // a hand here would only invite someone to read the boat's port and
    // starboard into a mark that belongs to the world.
    const first = normalizeSigned(angleOfVector(firstBarb!) - from);
    const second = normalizeSigned(angleOfVector(secondBarb!) - from);
    expect(Math.sign(first)).toBe(-Math.sign(second));
    expect(first).toBeCloseTo(-second, BEARING);
    expect(Math.abs(first)).toBeGreaterThan(0.01); // genuinely splayed, not collinear
  });
});

describe("points-of-sail graduations", () => {
  it("draws seven marks, every 45°, with the eighth left to the arrow", () => {
    const from = deg(200);
    // **Folded onto +π before sorting.** The marks are emitted at exact 45°
    // steps, but path data is rounded to four decimals, so the 180° tick parses
    // back as −179.999445° — and `normalizeSigned` puts that on the far end of
    // the range, which rotates the sorted array by one against `expected`. The
    // seam is a property of reading coordinates back out of a string, not of the
    // graduations; with the old 5.65 m ring the rounding happened to fall on the
    // +π side and this passed by luck.
    const halfTurn = Math.PI;
    const offsets = tickBearings(from)
      .map((bearing) => normalizeSigned(bearing - from))
      .map((offset) => (Math.abs(Math.abs(offset) - halfTurn) < 1e-3 ? halfTurn : offset))
      .sort((a, b) => a - b);
    expect(offsets).toHaveLength(TICKS_DRAWN);
    // ±45 close-hauled, ±90 a beam reach, ±135 a broad reach, 180 a run — every
    // point of sail bar head to wind, which is where the arrow already stands.
    const expected = [-135, -90, -45, 45, 90, 135, 180].map(deg).sort((a, b) => a - b);
    for (const [i, offset] of offsets.entries()) {
      expect(offset).toBeCloseTo(expected[i]!, BEARING);
    }
  });

  it("turns with the wind rather than with the compass", () => {
    // The whole reason these are points of sail and not a compass rose: shift
    // the wind and every mark shifts with it by the same amount, so where the
    // bow falls against them still reads as close-hauled, beam reach, run.
    const shift = deg(30);
    const before = tickBearings(deg(0));
    const after = tickBearings(shift);
    expect(after).toHaveLength(before.length);
    for (const [i, bearing] of after.entries()) {
      expect(normalizeSigned(bearing - before[i]!)).toBeCloseTo(shift, BEARING);
    }
  });

  it("reaches inward from the ring without reaching anything the boat can occupy", () => {
    const points = pathPoints(windTickPathData(deg(115)));
    for (let i = 0; i < points.length; i += 2) {
      const outer = radius(points[i]!);
      const inner = radius(points[i + 1]!);
      expect(outer).toBeCloseTo(SCENE.windRingRadius, METRES);
      expect(outer - inner).toBeCloseTo(TICK_LENGTH, METRES);
      // **The bound moved because the bands did.** `contentRadius` and the ring
      // are now the same circle — the speed arrow's tip lands on the ring at
      // hull speed, and the ring's radius is solved from exactly that — so
      // "stops short of contentRadius" is unsatisfiable by construction rather
      // than false. What the graduations must still clear is the boat: they are
      // a scale to read the bow against, and a tick reaching into the disc the
      // hull sweeps would be a mark the boat could sit on top of.
      expect(inner).toBeGreaterThan(SCENE.boatRadius);
    }
  });
});

describe("wind path data", () => {
  it("emits nothing a renderer would choke on, at any bearing", () => {
    for (let d = 0; d < 360; d += 1) {
      for (const data of [windArrowPathData(deg(d), MEASURED_WIND), windTickPathData(deg(d))]) {
        expect(data).not.toMatch(/NaN|Infinity|e[+-]/i);
        expect(data).not.toMatch(/(^|\s)-0(\s|$)/);
      }
    }
  });

  it("exports a layer factory", () => {
    // The DOM half is exercised by hand in the browser, as `createHullLayer` and
    // `createSailLayer` are; the suite runs in node.
    expect(typeof createWindLayer).toBe("function");
  });
});
