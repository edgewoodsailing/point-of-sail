import { describe, expect, it } from "vitest";

import {
  HULL,
  JIB,
  MAIN,
  mainClewPosition,
  jibClewPosition,
  RIG,
  sailChordBearing,
  STATIONS,
} from "./boat.ts";
import type { Vec2 } from "./units.ts";
import {
  degreesToRadians,
  magnitude,
  metersPerSecondToKnots,
  metersToFeet,
  normalizeSigned,
  subtract,
} from "./units.ts";

const deg = degreesToRadians;

/** How far aft of the bow a boat-frame point sits, in feet — the way §3/§5 quote it. */
function feetAftOfBow(point: Vec2): number {
  return metersToFeet(point.y - STATIONS.bow.y);
}

/** Distance between the two clews, in metres, for a pair of trim angles in degrees. */
function clewGap(mainDegrees: number, jibDegrees: number): number {
  return magnitude(subtract(mainClewPosition(deg(mainDegrees)), jibClewPosition(deg(jibDegrees))));
}

/**
 * The closest the two clews ever come, in metres, with both sails trimmed
 * anywhere within ±`limitDegrees`. Swept at a fine step: the minimum sits in a
 * shallow valley, so a coarse grid reports a value that is too optimistic.
 */
function closestApproach(limitDegrees: number): number {
  let closest = Infinity;
  for (let mainDegrees = -limitDegrees; mainDegrees <= limitDegrees; mainDegrees += 0.25) {
    for (let jibDegrees = -limitDegrees; jibDegrees <= limitDegrees; jibDegrees += 0.25) {
      closest = Math.min(closest, clewGap(mainDegrees, jibDegrees));
    }
  }
  return closest;
}

describe("Rhodes 19 hull figures (DESIGN.md §3)", () => {
  it("matches the published dimensions", () => {
    expect(metersToFeet(HULL.loa)).toBeCloseTo(19 + 2 / 12, 6);
    expect(metersToFeet(HULL.lwl)).toBeCloseTo(17 + 9 / 12, 6);
    expect(metersToFeet(HULL.beam)).toBeCloseTo(7, 6);
    expect(metersToFeet(HULL.draft)).toBeCloseTo(3 + 3 / 12, 6);
    expect(HULL.displacement).toBeCloseTo(601, 0);
  });

  it("keeps the 7:19 beam-to-length proportion the drawing is built on (§4.1)", () => {
    expect(HULL.beam / HULL.loa).toBeCloseTo(7 / 19.167, 3);
  });

  it("puts hull speed at 5.65 kt", () => {
    expect(metersPerSecondToKnots(HULL.hullSpeed)).toBeCloseTo(5.65, 2);
    expect(HULL.hullSpeed).toBeCloseTo(2.9, 1);
  });
});

describe("rig and sails (DESIGN.md §3.2)", () => {
  it("carries the I/J/P/E dimensions", () => {
    expect(metersToFeet(RIG.i)).toBeCloseTo(15.0, 6);
    expect(metersToFeet(RIG.j)).toBeCloseTo(6.5, 6);
    expect(metersToFeet(RIG.p)).toBeCloseTo(24.0, 6);
    expect(metersToFeet(RIG.e)).toBeCloseTo(9.7, 6);
  });

  it("converts both sail areas to SI", () => {
    expect(MAIN.area).toBeCloseTo(11.0, 1);
    expect(JIB.area).toBeCloseTo(5.25, 2);
  });

  it("keeps roughly the two-thirds/one-third main:jib area split", () => {
    expect(MAIN.area / (MAIN.area + JIB.area)).toBeCloseTo(0.677, 3);
  });

  it("computes aspect ratio as luff²/area", () => {
    expect(MAIN.aspectRatio).toBeCloseTo(4.86, 2);
    expect(JIB.aspectRatio).toBeCloseTo(5.11, 2);
  });

  it("takes the jib's dimensions from the class rule book, not the foretriangle", () => {
    // RB 21.02.04: luff 17'0", foot 7'6". Note the luff exceeds √(I² + J²) ≈ 16.4.
    expect(metersToFeet(JIB.luff)).toBeCloseTo(17.0, 6);
    expect(metersToFeet(JIB.foot)).toBeCloseTo(7.5, 6);
    expect(metersToFeet(MAIN.luff)).toBeCloseTo(24.0, 6);
  });
});

describe("stations (DESIGN.md §4.1, §5)", () => {
  it("measures from the mast, on the centreline", () => {
    expect(STATIONS.mast).toEqual({ x: 0, y: 0 });
    for (const station of [STATIONS.bow, STATIONS.stern, STATIONS.forestay]) {
      expect(station.x).toBe(0);
    }
  });

  it("spans the full LOA from bow to stern", () => {
    expect(magnitude(subtract(STATIONS.stern, STATIONS.bow))).toBeCloseTo(HULL.loa, 9);
    expect(STATIONS.bow.y).toBeLessThan(0); // forward is −y
    expect(STATIONS.stern.y).toBeGreaterThan(0);
  });

  it("puts the mast 7 ft aft of the bow, one J ahead of the forestay", () => {
    expect(feetAftOfBow(STATIONS.mast)).toBeCloseTo(7.0, 6);
    expect(metersToFeet(STATIONS.mast.y - STATIONS.forestay.y)).toBeCloseTo(6.5, 6);
  });

  it("lands the forestay just aft of the stem, so the boat still reads as a sloop", () => {
    expect(feetAftOfBow(STATIONS.forestay)).toBeCloseTo(0.5, 6);
  });
});

describe("sail chord bearing", () => {
  it("lies dead aft when sheeted flat", () => {
    expect(sailChordBearing(0)).toBeCloseTo(Math.PI, 10);
  });

  it("swings toward the beam it is eased to", () => {
    // Positive trim = clew to starboard, and starboard is +90° off the bow.
    expect(sailChordBearing(deg(90))).toBeCloseTo(deg(90), 10);
    expect(sailChordBearing(deg(-90))).toBeCloseTo(deg(-90), 10);
    expect(sailChordBearing(deg(30))).toBeCloseTo(deg(150), 10);
    expect(sailChordBearing(deg(-30))).toBeCloseTo(deg(-150), 10);
  });

  it("stays normalised when trim is backed past the beam", () => {
    const bearing = sailChordBearing(deg(150));
    expect(bearing).toBeCloseTo(deg(30), 10);
    expect(bearing).toBe(normalizeSigned(bearing));
  });
});

describe("clew positions (DESIGN.md §5)", () => {
  it("puts the main clew at the boom end, 16.7 ft aft of the bow when sheeted flat", () => {
    const clew = mainClewPosition(0);
    expect(clew.x).toBeCloseTo(0, 12);
    expect(feetAftOfBow(clew)).toBeCloseTo(16.7, 6);
  });

  it("sheets the jib clew to the deck 8 ft aft of the bow", () => {
    const clew = jibClewPosition(0);
    expect(clew.x).toBeCloseTo(0, 12);
    expect(feetAftOfBow(clew)).toBeCloseTo(8.0, 6);
  });

  it("swings each clew to starboard on positive trim, and mirrors on negative", () => {
    for (const clewAt of [mainClewPosition, jibClewPosition]) {
      const starboard = clewAt(deg(25));
      const port = clewAt(deg(-25));
      expect(starboard.x).toBeGreaterThan(0);
      expect(port.x).toBeCloseTo(-starboard.x, 12);
      expect(port.y).toBeCloseTo(starboard.y, 12);
    }
  });

  it("swings on a fixed radius about its own pivot", () => {
    for (const trimDegrees of [-120, -90, -45, 0, 15, 45, 90, 120]) {
      const trim = deg(trimDegrees);
      expect(magnitude(subtract(mainClewPosition(trim), STATIONS.mast))).toBeCloseTo(MAIN.foot, 9);
      expect(magnitude(subtract(jibClewPosition(trim), STATIONS.forestay))).toBeCloseTo(JIB.foot, 9);
    }
  });

  it("separates the clews by ~45% of the boat's length when both are sheeted flat", () => {
    // §5's headline figure: 16.7 ft aft against 8 ft aft, so ~230 px apart on a
    // 500 px boat, which is what makes the grab points unambiguous at normal trim.
    const flatGap = clewGap(0, 0);
    expect(metersToFeet(flatGap)).toBeCloseTo(8.7, 6);
    expect(flatGap / HULL.loa).toBeCloseTo(0.45, 2);
  });

  it("closes to a known minimum as trim widens, rather than staying comfortably apart", () => {
    // Pinned as measured values, not as a threshold with slack: both minima sit
    // *on* the edge of the range searched, at the main's limit, so the gap is
    // still shrinking when the search stops. A margin-based assertion would
    // read as a guarantee that holds a bit further out, and it doesn't.
    //
    // Within ±60° — normal working trim — the closest the clews come is
    // 0.345·LOA, about 6.6 ft, ~173 px on a 500 px boat: still an easy target.
    // Open both sails to ±90° — as far as the shrouds let the boom go — and
    // that falls to 0.218·LOA, ~109 px: still clear of two 44 px touch discs.
    expect(closestApproach(60) / HULL.loa).toBeCloseTo(0.34542, 5);
    expect(closestApproach(90) / HULL.loa).toBeCloseTo(0.2179, 5);
  });

  it("keeps the arcs' crossing beyond the boom's shroud-limited swing", () => {
    // The main's arc (radius E about the mast) and the jib's (radius 7.5 ft
    // about the forestay, 6.5 ft ahead of it) do intersect — but only with the
    // main eased to ~129°, well past the ~90° where the boom fetches up on the
    // shrouds. So once trim is clamped to the boom's physical swing (pos-bwd.3),
    // the clews can never coincide; this pins where the crossing sits so the
    // conclusion is re-checked if the stations or sail dimensions ever change.
    expect(clewGap(129.43, 87.41)).toBeLessThan(0.05);
  });
});
