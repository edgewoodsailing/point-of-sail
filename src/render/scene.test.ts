import { describe, expect, it } from "vitest";

import { jibClewPosition, mainClewPosition, STATIONS, SWING_LIMIT, HULL } from "../model/boat.ts";
import type { Radians, Vec2 } from "../model/units.ts";
import { degreesToRadians, magnitude, rotateVector, subtract } from "../model/units.ts";
import { boatTransform, SCENE, sceneExtent, SHORT_SPAN, viewBoxAttribute } from "./scene.ts";
import { formatNumber } from "./svg.ts";

const deg = degreesToRadians;

/** Metres. */
const PRECISION = 4;

/** Distance from the point the boat turns about — what every extent is measured from. */
function fromPivot(point: Vec2): number {
  return magnitude(subtract(point, STATIONS.pivot));
}

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
      // Zero is the documented sentinel for "no scale yet", not a scale. Pinned
      // so that a consumer tempted to divide by this field meets the contract
      // here rather than an Infinity at runtime.
      expect(extent.metersPerPixel).toBe(0);
    }
  });

  it("reports a positive scale for every surface that has one", () => {
    for (const [w, h] of [
      [390, 700],
      [1600, 900],
      [1, 1],
    ] as const) {
      expect(sceneExtent(w, h).metersPerPixel).toBeGreaterThan(0);
    }
  });

  it("centres the origin — and therefore the boat's pivot — in the viewBox", () => {
    // Derived rather than quoted, because the half-span is no longer a number
    // anyone chose: `shortRadius` follows the ring, and the ring is solved from
    // the two velocity scales (`SCENE`). Quoting "12" here pinned an old
    // decision as if it were an invariant. The invariant is that a square
    // surface is centred on the origin and spans `SHORT_SPAN`.
    const half = SHORT_SPAN / 2;
    expect(viewBoxAttribute(sceneExtent(500, 500))).toBe(
      `${formatNumber(-half)} ${formatNumber(-half)} ${formatNumber(SHORT_SPAN)} ${formatNumber(SHORT_SPAN)}`,
    );
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
    // contentRadius and windRingRadius are now the SAME circle: the band that
    // was reserved for the speed arrow's tip at hull speed IS the ring, since
    // the ring's radius is solved from that very statement. "Nests strictly"
    // survives as "never overlaps"; the strictness it asserted was a property
    // of a radius that had been declared rather than derived.
    expect(SCENE.contentRadius).toBeLessThanOrEqual(SCENE.windRingRadius);
    expect(SCENE.windRingRadius).toBeLessThan(SCENE.shortRadius);
  });

  it("contains the whole boat at every legal trim, measured from the pivot", () => {
    const points: Vec2[] = [STATIONS.bow, STATIONS.stern, STATIONS.jibTack, STATIONS.mast];
    for (let d = -90; d <= 90; d += 1) {
      points.push(mainClewPosition(deg(d)), jibClewPosition(deg(d)));
    }
    for (const point of points) {
      expect(fromPivot(point)).toBeLessThanOrEqual(SCENE.boatRadius);
    }
    expect(SWING_LIMIT).toBeCloseTo(deg(90), 10);
  });

  it("is bound by the jib clew at full ease, not by the hull", () => {
    // Worth pinning, because it is not the obvious answer and it changed when
    // the pivot moved: about the mast the transom corners bound it; about the
    // pivot the jib clew swings out abeam near the bow and reaches further.
    expect(fromPivot(jibClewPosition(SWING_LIMIT))).toBeCloseTo(SCENE.boatRadius, 6);
    expect(fromPivot(STATIONS.stern)).toBeLessThan(SCENE.boatRadius);
  });

  it("reserves the same room for the speed indicator ahead and astern", () => {
    // The pivot is the midpoint of LOA, so this is symmetric by construction —
    // sternway is no longer the cramped case it was about the mast, and a wake
    // at the stern (§4.3) would have as much room as an arrow off the bow.
    const ahead = SCENE.contentRadius - fromPivot(STATIONS.bow);
    const astern = SCENE.contentRadius - fromPivot(STATIONS.stern);
    expect(ahead).toBeCloseTo(astern, 9);
    // The absolute figures moved when the ring's radius stopped being declared
    // and started being solved from the two velocity maxima: the whole drawing
    // zoomed 1.30x, so a metre buys more picture than it did. What is asserted
    // is the symmetry, which is structural, and that the reservation is still
    // worth having at all.
    expect(ahead).toBeGreaterThan(1.2);
    expect(ahead / HULL.hullSpeed).toBeGreaterThan(0.4);
  });
});

describe("boat transform", () => {
  /**
   * Applies `rotate(d) translate(tx ty)` by hand, exactly as SVG would: the
   * rightmost transform first. Parsing the string rather than trusting it is
   * the point — this is the one test that proves the coordinate story instead
   * of restating it.
   */
  function applyTransform(v: Vec2, transform: string): Vec2 {
    const match = /^rotate\((-?[\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)$/.exec(transform);
    if (match === null) throw new Error(`Unexpected transform: ${transform}`);
    const [, degrees, tx, ty] = match as unknown as [string, string, string, string];
    const moved = { x: v.x + Number(tx), y: v.y + Number(ty) };
    const a = (Number(degrees) * Math.PI) / 180;
    return {
      x: moved.x * Math.cos(a) - moved.y * Math.sin(a),
      y: moved.x * Math.sin(a) + moved.y * Math.cos(a),
    };
  }

  it("is exactly rotateVector about the pivot, which makes the two frames one story", () => {
    const probes: Vec2[] = [STATIONS.bow, STATIONS.stern, STATIONS.mast, mainClewPosition(deg(35))];
    for (const heading of [0, 17, 90, 143, -60, 179] as Radians[]) {
      const radians = deg(heading);
      for (const probe of probes) {
        const bySvg = applyTransform(probe, boatTransform(radians));
        const byModel = rotateVector(subtract(probe, STATIONS.pivot), radians);
        expect(bySvg.x).toBeCloseTo(byModel.x, 6);
        expect(bySvg.y).toBeCloseTo(byModel.y, 6);
      }
    }
  });

  it("holds the pivot still at every heading, and only the pivot", () => {
    for (const heading of [0, 30, 90, 200, -45] as Radians[]) {
      const fixed = applyTransform(STATIONS.pivot, boatTransform(deg(heading)));
      expect(magnitude(fixed)).toBeCloseTo(0, 9);
    }
    // The mast is no longer the still point — that is the whole change.
    const mast = applyTransform(STATIONS.mast, boatTransform(deg(90)));
    expect(magnitude(mast)).toBeCloseTo(magnitude(STATIONS.pivot), 9);
    expect(magnitude(STATIONS.pivot)).toBeGreaterThan(0.5);
  });

  it("puts the bow screen-up at heading zero and screen-right at ninety", () => {
    const up = applyTransform(STATIONS.bow, boatTransform(0));
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeLessThan(0); // −y is up in SVG

    const right = applyTransform(STATIONS.bow, boatTransform(deg(90)));
    expect(right.x).toBeGreaterThan(0);
    expect(right.y).toBeCloseTo(0, 6);
  });

  it("swings bow and stern through equal arcs, which the mast never did", () => {
    const swing = (p: Vec2) => magnitude(subtract(p, STATIONS.pivot));
    expect(swing(STATIONS.bow)).toBeCloseTo(swing(STATIONS.stern), 9);
    expect(swing(STATIONS.bow)).toBeCloseTo(HULL.loa / 2, 9);
  });
});
