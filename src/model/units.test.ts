import { describe, expect, it } from "vitest";

import type { Radians, Vec2 } from "./units.ts";
import {
  acos,
  add,
  angleBetween,
  angleOfVector,
  asin,
  componentAcross,
  componentAlong,
  degreesToRadians,
  dot,
  feetToMeters,
  knotsToMetersPerSecond,
  magnitude,
  metersPerSecondToKnots,
  metersToFeet,
  normalizeSigned,
  normalizeUnsigned,
  oppositeAngle,
  perpendicular,
  poundsToKilograms,
  radiansToDegrees,
  rotateVector,
  scale,
  squareFeetToSquareMeters,
  subtract,
  TAU,
  toBoatFrame,
  toWorldFrame,
  unitVector,
  vectorFromAngle,
} from "./units.ts";

/** Angles are compared tightly — a sloppy tolerance would hide sign errors. */
const PRECISION = 10;

const deg = degreesToRadians;

function expectAngle(actual: Radians, expected: Radians): void {
  expect(actual).toBeCloseTo(expected, PRECISION);
}

/**
 * Compares two angles as *directions*. At the ±180 seam both representatives
 * are equally correct, and a vector round trip can legitimately come back on
 * either side of it, so equality there would be a test about floating point
 * rather than about the model.
 */
function expectSameDirection(actual: Radians, expected: Radians): void {
  expect(angleBetween(expected, actual)).toBeCloseTo(0, PRECISION);
}

function expectVector(actual: Vec2, expected: Vec2): void {
  expect(actual.x).toBeCloseTo(expected.x, PRECISION);
  expect(actual.y).toBeCloseTo(expected.y, PRECISION);
}

/** A spread of angles that deliberately lands on both wrap seams. */
const SAMPLE_DEGREES = [
  -360, -270, -181, -180, -179, -90, -1, 0, 1, 45, 89, 90, 91, 179, 180, 181, 270, 359, 360, 720,
];

describe("normalizeUnsigned", () => {
  it("wraps into [0, 2π)", () => {
    for (const degrees of SAMPLE_DEGREES) {
      const wrapped = normalizeUnsigned(deg(degrees));
      expect(wrapped).toBeGreaterThanOrEqual(0);
      expect(wrapped).toBeLessThan(TAU);
    }
  });

  it("keeps the angle's direction", () => {
    expectAngle(normalizeUnsigned(deg(0)), 0);
    expectAngle(normalizeUnsigned(deg(360)), 0);
    expectAngle(normalizeUnsigned(deg(-90)), deg(270));
    expectAngle(normalizeUnsigned(deg(450)), deg(90));
    expectAngle(normalizeUnsigned(deg(-450)), deg(270));
  });

  it("folds a rounding-sized negative to zero rather than to a full turn", () => {
    expect(normalizeUnsigned(-1e-18)).toBe(0);
    expect(normalizeUnsigned(-TAU)).toBe(0);
  });
});

describe("normalizeSigned", () => {
  it("wraps into (−π, π]", () => {
    for (const degrees of SAMPLE_DEGREES) {
      const wrapped = normalizeSigned(deg(degrees));
      expect(wrapped).toBeGreaterThan(-Math.PI - 1e-12);
      expect(wrapped).toBeLessThanOrEqual(Math.PI + 1e-12);
    }
  });

  it("puts the ±180 boundary at +180", () => {
    expectAngle(normalizeSigned(deg(180)), Math.PI);
    expectAngle(normalizeSigned(deg(-180)), Math.PI);
    expectAngle(normalizeSigned(deg(540)), Math.PI);
  });

  it("reads angles past a half turn as the short way round", () => {
    expectAngle(normalizeSigned(deg(270)), deg(-90));
    expectAngle(normalizeSigned(deg(350)), deg(-10));
    expectAngle(normalizeSigned(deg(-350)), deg(10));
  });

  it("is idempotent", () => {
    for (const degrees of SAMPLE_DEGREES) {
      const once = normalizeSigned(deg(degrees));
      expectAngle(normalizeSigned(once), once);
    }
  });
});

describe("angleBetween", () => {
  it("is positive clockwise", () => {
    expectAngle(angleBetween(deg(0), deg(90)), deg(90));
    expectAngle(angleBetween(deg(90), deg(0)), deg(-90));
  });

  it("crosses the 0/360 seam the short way", () => {
    expectAngle(angleBetween(deg(350), deg(10)), deg(20));
    expectAngle(angleBetween(deg(10), deg(350)), deg(-20));
    expectAngle(angleBetween(deg(-5), deg(725)), deg(10));
  });

  it("crosses the ±180 seam the short way", () => {
    expectAngle(angleBetween(deg(179), deg(-179)), deg(2));
    expectAngle(angleBetween(deg(-179), deg(179)), deg(-2));
  });

  it("is antisymmetric away from the half-turn boundary", () => {
    for (const degrees of SAMPLE_DEGREES) {
      const forward = angleBetween(deg(30), deg(degrees));
      if (Math.abs(Math.abs(forward) - Math.PI) < 1e-9) continue; // ±180 is its own opposite
      expectAngle(angleBetween(deg(degrees), deg(30)), -forward);
    }
  });
});

describe("oppositeAngle", () => {
  it("turns 'blows from' into 'blows toward'", () => {
    expectAngle(oppositeAngle(deg(0)), Math.PI);
    expectAngle(oppositeAngle(deg(90)), deg(-90));
    expectAngle(oppositeAngle(deg(-90)), deg(90));
  });

  it("round-trips", () => {
    for (const degrees of SAMPLE_DEGREES) {
      expectAngle(oppositeAngle(oppositeAngle(deg(degrees))), normalizeSigned(deg(degrees)));
    }
  });
});

describe("boat frame", () => {
  it("reads dead ahead as zero and dead astern as ±180", () => {
    expectAngle(toBoatFrame(deg(40), deg(40)), 0);
    expectAngle(toBoatFrame(deg(220), deg(40)), Math.PI);
  });

  it("is positive to starboard", () => {
    // Boat heading north-east; a bearing 30° further clockwise is off the
    // starboard bow.
    expectAngle(toBoatFrame(deg(75), deg(45)), deg(30));
    expectAngle(toBoatFrame(deg(15), deg(45)), deg(-30));
  });

  it("works when the conversion crosses the 0/360 seam", () => {
    expectAngle(toBoatFrame(deg(10), deg(350)), deg(20));
    expectAngle(toBoatFrame(deg(350), deg(10)), deg(-20));
    expectAngle(toWorldFrame(deg(20), deg(350)), deg(10));
    expectAngle(toWorldFrame(deg(-20), deg(10)), deg(350 - 360));
  });

  it("round-trips through every heading", () => {
    for (const headingDegrees of SAMPLE_DEGREES) {
      for (const worldDegrees of SAMPLE_DEGREES) {
        const heading = deg(headingDegrees);
        const world = deg(worldDegrees);
        const there = toBoatFrame(world, heading);
        expectAngle(toWorldFrame(there, heading), normalizeSigned(world));
      }
    }
  });
});

describe("vectors", () => {
  it("points bearings the way SVG's y-down axis needs", () => {
    expectVector(unitVector(deg(0)), { x: 0, y: -1 }); // north is up
    expectVector(unitVector(deg(90)), { x: 1, y: 0 }); // east is right
    expectVector(unitVector(deg(180)), { x: 0, y: 1 });
    expectVector(unitVector(deg(270)), { x: -1, y: 0 });
  });

  it("round-trips angle → vector → angle", () => {
    for (const degrees of SAMPLE_DEGREES) {
      expectSameDirection(angleOfVector(unitVector(deg(degrees))), deg(degrees));
    }
  });

  it("reports dead astern as +180, whichever side it is reached from", () => {
    expectAngle(angleOfVector({ x: 0, y: 1 }), Math.PI);
    expectAngle(angleOfVector({ x: -0, y: 1 }), Math.PI);
  });

  it("scales without turning, and reverses when the length is negative", () => {
    expectVector(vectorFromAngle(deg(90), 3), { x: 3, y: 0 });
    expectVector(vectorFromAngle(deg(90), -3), { x: -3, y: 0 });
    expect(magnitude(vectorFromAngle(deg(37), 5))).toBeCloseTo(5, PRECISION);
  });

  it("gives the zero vector a defined, if arbitrary, bearing", () => {
    expect(angleOfVector({ x: 0, y: 0 })).toBe(0);
  });

  it("adds, subtracts, scales, and dots componentwise", () => {
    expectVector(add({ x: 1, y: 2 }, { x: 3, y: -4 }), { x: 4, y: -2 });
    expectVector(subtract({ x: 1, y: 2 }, { x: 3, y: -4 }), { x: -2, y: 6 });
    expectVector(scale({ x: 1, y: -2 }, 3), { x: 3, y: -6 });
    expect(dot({ x: 1, y: 2 }, { x: 3, y: -4 })).toBe(-5);
  });

  it("rotates clockwise, preserving length", () => {
    expectVector(rotateVector({ x: 0, y: -1 }, deg(90)), { x: 1, y: 0 });
    expectVector(rotateVector({ x: 1, y: 0 }, deg(90)), { x: 0, y: 1 });
    for (const degrees of SAMPLE_DEGREES) {
      const rotated = rotateVector(unitVector(deg(20)), deg(degrees));
      expectSameDirection(angleOfVector(rotated), deg(20 + degrees));
      expect(magnitude(rotated)).toBeCloseTo(1, PRECISION);
    }
  });

  it("turns perpendicular 90° clockwise", () => {
    expectVector(perpendicular({ x: 0, y: -1 }), { x: 1, y: 0 });
    expectVector(perpendicular({ x: 1, y: 0 }), { x: 0, y: 1 });
  });

  it("resolves a vector into along and across components", () => {
    const force = vectorFromAngle(deg(30), 10);
    expect(componentAlong(force, deg(30))).toBeCloseTo(10, PRECISION);
    expect(componentAcross(force, deg(30))).toBeCloseTo(0, PRECISION);
    expect(componentAlong(force, deg(120))).toBeCloseTo(0, PRECISION);
    expect(componentAcross(force, deg(120))).toBeCloseTo(-10, PRECISION);
    // A force 60° off the heading drives with cos 60° of itself.
    expect(componentAlong(force, deg(-30))).toBeCloseTo(5, PRECISION);
  });
});

describe("inverse trigonometry", () => {
  it("inverts sine and cosine over their principal ranges", () => {
    expectAngle(asin(0), 0);
    expectAngle(asin(1), Math.PI / 2);
    expectAngle(acos(1), 0);
    expectAngle(acos(-1), Math.PI);
    expectAngle(acos(0), Math.PI / 2);
  });

  it("absorbs rounding-sized overshoot, which is what the clamp is for", () => {
    expectAngle(acos(1 + 1e-15), 0);
    expectAngle(asin(-1 - 1e-15), -Math.PI / 2);
  });

  it("refuses input that is not a ratio at all, rather than inventing an angle", () => {
    // Clamping 1.4 would hand back a confident π/2 and bury the real bug —
    // a unit mix-up or an unnormalised vector — somewhere downstream.
    expect(() => asin(1.4)).toThrow(/not a ratio/);
    expect(() => acos(-2)).toThrow(/not a ratio/);
    expect(() => acos(Number.NaN)).toThrow(/not a ratio/);
  });
});

describe("conversions", () => {
  it("converts angles both ways", () => {
    expect(radiansToDegrees(Math.PI)).toBeCloseTo(180, PRECISION);
    expect(degreesToRadians(180)).toBeCloseTo(Math.PI, PRECISION);
    for (const degrees of SAMPLE_DEGREES) {
      expect(radiansToDegrees(degreesToRadians(degrees))).toBeCloseTo(degrees, PRECISION);
    }
  });

  it("converts speeds both ways", () => {
    expect(knotsToMetersPerSecond(1)).toBeCloseTo(0.5144444, 6);
    expect(knotsToMetersPerSecond(10)).toBeCloseTo(5.144444, 5);
    expect(metersPerSecondToKnots(knotsToMetersPerSecond(7.5))).toBeCloseTo(7.5, PRECISION);
  });

  it("converts lengths, masses, and areas", () => {
    expect(feetToMeters(1)).toBeCloseTo(0.3048, PRECISION);
    expect(metersToFeet(feetToMeters(19.5))).toBeCloseTo(19.5, PRECISION);
    expect(poundsToKilograms(1325)).toBeCloseTo(601.0, 1);
    expect(squareFeetToSquareMeters(118.6)).toBeCloseTo(11.02, 2);
  });
});
