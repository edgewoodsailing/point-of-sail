import { describe, expect, it } from "vitest";

import { jibClewPosition, mainClewPosition, STATIONS, SWING_LIMIT, HULL } from "../model/boat.ts";
import type { Radians, Vec2 } from "../model/units.ts";
import { degreesToRadians, magnitude, rotateVector } from "../model/units.ts";
import { headingTransform, SCENE, sceneExtent, SHORT_SPAN, viewBoxAttribute } from "./scene.ts";

const deg = degreesToRadians;

/** Metres. */
const PRECISION = 4;

describe("scene extent (DESIGN.md §4.1)", () => {
  it("pins the short axis to SHORT_SPAN whichever way round the surface is", () => {
    for (const [w, h] of [
      [390, 700],
      [700, 390],
      [834, 1112],
      [1600, 900],
      [500, 500],
    ] as const) {
      const extent = sceneExtent(w, h);
      const shortSpan = 2 * Math.min(extent.halfWidth, extent.halfHeight);
      expect(shortSpan).toBeCloseTo(SHORT_SPAN, PRECISION);
    }
  });

  it("gives the extra world space to the long axis, never to the short one", () => {
    const tall = sceneExtent(390, 700);
    expect(tall.halfWidth).toBeCloseTo(SCENE.shortRadius, PRECISION);
    expect(tall.halfHeight).toBeGreaterThan(tall.halfWidth);

    const wide = sceneExtent(1600, 900);
    expect(wide.halfHeight).toBeCloseTo(SCENE.shortRadius, PRECISION);
    expect(wide.halfWidth).toBeGreaterThan(wide.halfHeight);
  });

  it("scales both axes by the same factor, so nothing is distorted", () => {
    const extent = sceneExtent(1600, 900);
    expect((2 * extent.halfWidth) / 1600).toBeCloseTo(extent.metersPerPixel, 10);
    expect((2 * extent.halfHeight) / 900).toBeCloseTo(extent.metersPerPixel, 10);
  });

  it("survives a surface with no area yet", () => {
    for (const [w, h] of [
      [0, 0],
      [390, 0],
      [0, 700],
    ] as const) {
      const extent = sceneExtent(w, h);
      expect(Number.isFinite(extent.halfWidth)).toBe(true);
      expect(Number.isFinite(extent.halfHeight)).toBe(true);
      expect(extent.halfWidth).toBeGreaterThan(0);
      expect(extent.halfHeight).toBeGreaterThan(0);
    }
  });

  it("centres the origin — and therefore the mast — in the viewBox", () => {
    expect(viewBoxAttribute(sceneExtent(500, 500))).toBe("-6 -6 12 12");
    const [minX, minY, width, height] = viewBoxAttribute(sceneExtent(1600, 900))
      .split(" ")
      .map(Number) as [number, number, number, number];
    expect(minX).toBeCloseTo(-width / 2, PRECISION);
    expect(minY).toBeCloseTo(-height / 2, PRECISION);
  });

  it("reads at a usable size on the three viewports the bead names", () => {
    // The acceptance criteria are about legibility, so pin the scale itself.
    const boatLength = (w: number, h: number) => HULL.loa / sceneExtent(w, h).metersPerPixel;
    expect(boatLength(390, 700)).toBeGreaterThan(150); // phone
    expect(boatLength(834, 1000)).toBeGreaterThan(350); // iPad
    expect(boatLength(1600, 900)).toBeGreaterThan(400); // desktop
  });
});

describe("scene bands", () => {
  it("nests strictly, so no later bead can quietly overlap another", () => {
    expect(SCENE.boatRadius).toBeLessThan(SCENE.contentRadius);
    expect(SCENE.contentRadius).toBeLessThan(SCENE.windRingRadius);
    expect(SCENE.windRingRadius).toBeLessThan(SCENE.shortRadius);
  });

  it("contains the whole boat at every legal trim", () => {
    const points: Vec2[] = [STATIONS.bow, STATIONS.stern, STATIONS.jibTack, STATIONS.mast];
    for (let d = -90; d <= 90; d += 1) {
      points.push(mainClewPosition(deg(d)), jibClewPosition(deg(d)));
    }
    for (const point of points) {
      expect(magnitude(point)).toBeLessThanOrEqual(SCENE.boatRadius);
    }
    expect(SWING_LIMIT).toBeCloseTo(deg(90), 10);
  });

  it("reserves enough room ahead of the bow for the speed arrow", () => {
    // ≈ 1.05 m of arrow per m/s reaches contentRadius at hull speed and no further.
    const ahead = SCENE.contentRadius - magnitude(STATIONS.bow);
    expect(ahead / HULL.hullSpeed).toBeCloseTo(1.05, 1);
    expect(SCENE.contentRadius - magnitude(STATIONS.stern)).toBeGreaterThan(1);
  });
});

describe("heading transform", () => {
  /** SVG's rotate(a) about the origin, applied by hand. */
  function svgRotate(v: Vec2, degrees: number): Vec2 {
    const a = (degrees * Math.PI) / 180;
    return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) };
  }

  function degreesIn(transform: string): number {
    const match = /^rotate\((-?[\d.]+)\)$/.exec(transform);
    if (match === null) throw new Error(`Unexpected transform: ${transform}`);
    return Number(match[1]);
  }

  it("is exactly units.rotateVector, which is what makes the two frames one story", () => {
    const probes: Vec2[] = [STATIONS.bow, STATIONS.stern, mainClewPosition(deg(35))];
    for (const heading of [0, 17, 90, 143, -60, 179] as Radians[]) {
      const radians = deg(heading);
      const applied = degreesIn(headingTransform(radians));
      for (const probe of probes) {
        const bySvg = svgRotate(probe, applied);
        const byModel = rotateVector(probe, radians);
        expect(bySvg.x).toBeCloseTo(byModel.x, 6);
        expect(bySvg.y).toBeCloseTo(byModel.y, 6);
      }
    }
  });

  it("puts the bow screen-up at heading zero and screen-right at ninety", () => {
    const up = svgRotate(STATIONS.bow, degreesIn(headingTransform(0)));
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeLessThan(0); // −y is up in SVG

    const right = svgRotate(STATIONS.bow, degreesIn(headingTransform(deg(90))));
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBeCloseTo(0, 6);
  });
});
