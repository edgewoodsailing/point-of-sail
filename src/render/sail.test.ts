import { describe, expect, it } from "vitest";

import type { Sail } from "../model/boat.ts";
import { JIB, MAIN, STATIONS, SWING_LIMIT, jibClewPosition, mainClewPosition } from "../model/boat.ts";
import { foilCoefficients } from "../model/foil.ts";
import {
  angleOfAttack,
  dynamicPressure,
  luffFraction,
  optimalTrim,
  sailForce,
} from "../model/sail.ts";
import type { SimState } from "../model/simulation.ts";
import { FOIL, LUFF } from "../model/tuning.ts";
import type { Radians, Vec2 } from "../model/units.ts";
import {
  add,
  degreesToRadians,
  knotsToMetersPerSecond,
  magnitude,
  oppositeAngle,
  radiansToDegrees,
  scale,
  subtract,
  unitVector,
} from "../model/units.ts";
import type { ApparentWind } from "../model/wind.ts";
import { apparentWind, trueWindAngle } from "../model/wind.ts";
import { cubicPoint } from "./hull.ts";
import { trimQualityColor, trimQualityStop } from "./palette.ts";
import {
  SAIL_SAMPLES,
  camberDepth,
  camberProfile,
  createSailLayer,
  jibShape,
  mainShape,
  pressureFactor,
  rigDrawing,
  sailBezier,
  sailPathData,
  sailPoint,
  sailPoints,
  trimQuality,
  type SailShape,
} from "./sail.ts";
import { SCENE } from "./scene.ts";

const deg = degreesToRadians;

/** Metres. A tenth of a millimetre on a nineteen-foot boat is exactness enough. */
const PRECISION = 4;

/**
 * Mirrors `MAX_DRAFT_FRACTION` in `sail.ts`, which is private because it is that
 * module's taste. Restated here so the depth formula is pinned by an
 * independent number rather than by reading the implementation back to itself.
 */
const MAX_DRAFT_FRACTION = 0.16;

function wind(speedKnots: number, angleDegrees: number): ApparentWind {
  return { speed: knotsToMetersPerSecond(speedKnots), angle: deg(angleDegrees) };
}

/** A working breeze, well clear of both luff thresholds. */
const BREEZE = wind(10, 30);

/** Every legal trim, at one-degree spacing. */
function trimSweep(step = 1): Radians[] {
  const angles: Radians[] = [];
  for (let d = -90; d <= 90; d += step) angles.push(deg(d));
  return angles;
}

/** The point on the straight chord at a chord fraction — what camber is measured from. */
function chordPoint(shape: SailShape, s: number): Vec2 {
  return add(shape.tack, scale(subtract(shape.clew, shape.tack), s));
}

/** The drawn deviation from the chord at a chord fraction, as a vector. */
function bulge(shape: SailShape, s: number): Vec2 {
  return subtract(sailPoint(shape, s), chordPoint(shape, s));
}

/** The direction the wind is blowing *toward*. */
function flowDirection(apparent: ApparentWind): Vec2 {
  return unitVector(oppositeAngle(apparent.angle));
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

// --- The chord --------------------------------------------------------------

describe("sail chords (DESIGN.md §4.1)", () => {
  it("runs the main from the mast to the boom end at every legal trim", () => {
    for (const angle of trimSweep()) {
      const shape = mainShape(angle, BREEZE);
      expect(shape.tack).toEqual(STATIONS.mast);
      expect(shape.clew.x).toBeCloseTo(mainClewPosition(angle).x, PRECISION);
      expect(shape.clew.y).toBeCloseTo(mainClewPosition(angle).y, PRECISION);
      expect(magnitude(subtract(shape.clew, shape.tack))).toBeCloseTo(MAIN.foot, PRECISION);
    }
  });

  it("runs the jib from its tack to its clew at every legal trim", () => {
    for (const angle of trimSweep()) {
      const shape = jibShape(angle, BREEZE);
      expect(shape.tack).toEqual(STATIONS.jibTack);
      expect(shape.clew.x).toBeCloseTo(jibClewPosition(angle).x, PRECISION);
      expect(shape.clew.y).toBeCloseTo(jibClewPosition(angle).y, PRECISION);
      expect(magnitude(subtract(shape.clew, shape.tack))).toBeCloseTo(JIB.foot, PRECISION);
    }
  });

  it("starts the jib at its tack, not at the stemhead", () => {
    // The bead text says "the forestay at the bow"; §4.1 and `boat.ts` say the
    // tack, which rides a foot up a stay that rakes aft and so sits half a foot
    // abaft the stem. Half a foot is exactly the gap that would read as a bug.
    const shape = jibShape(deg(20), BREEZE);
    expect(shape.tack).not.toEqual(STATIONS.bow);
    expect(shape.tack.y - STATIONS.bow.y).toBeCloseTo(0.5 * 0.3048, PRECISION);
  });
});

// --- The camber profile, and that it really is the Bézier -------------------

describe("camber profile", () => {
  const positions = [mainShape(0, BREEZE).draftPosition, jibShape(0, BREEZE).draftPosition];

  it("pins both ends to the chord and peaks at exactly 1", () => {
    for (const p of positions) {
      expect(camberProfile(0, p)).toBe(0);
      expect(camberProfile(1, p)).toBe(0);
      expect(camberProfile(p, p)).toBeCloseTo(1, 12);
    }
  });

  it("bulges one way only, with a single peak at the draft position", () => {
    for (const p of positions) {
      const samples = Array.from({ length: 1001 }, (_, i) => camberProfile(i / 1000, p));
      for (let i = 1; i < 1000; i += 1) expect(samples[i]!).toBeGreaterThan(0);
      expect(Math.max(...samples)).toBeLessThanOrEqual(1 + 1e-12);

      const peakAt = samples.indexOf(Math.max(...samples)) / 1000;
      expect(peakAt).toBeCloseTo(p, 2);

      // Single-peaked: rises to the peak, falls after it, nowhere else.
      for (let i = 1; i <= 1000; i += 1) {
        const rising = samples[i]! > samples[i - 1]!;
        expect(rising).toBe(i / 1000 <= peakAt);
      }
    }
  });

  it("carries the jib's draft further forward than the main's", () => {
    expect(jibShape(0, BREEZE).draftPosition).toBeLessThan(mainShape(0, BREEZE).draftPosition);
    // Above 1/3, or the after handle goes negative and puts an S-bend in the sail.
    for (const p of positions) expect(p).toBeGreaterThan(1 / 3);
  });
});

describe("the drawn curve is the Bézier §4.1 asks for", () => {
  const shape = mainShape(deg(-40), BREEZE);

  it("places its handles at exactly 1/3 and 2/3 along the chord", () => {
    // This is what makes u(t) ≡ t, and therefore what makes the curve parameter
    // *be* the chord fraction. Everything below depends on it.
    const along = subtract(shape.clew, shape.tack);
    const chordSquared = dot(along, along);
    const bezier = sailBezier(shape);
    const fractionOf = (point: Vec2): number =>
      dot(subtract(point, shape.tack), along) / chordSquared;

    expect(fractionOf(bezier.control1)).toBeCloseTo(1 / 3, 12);
    expect(fractionOf(bezier.control2)).toBeCloseTo(2 / 3, 12);
  });

  it("puts every sampled point exactly on the cubic", () => {
    // The seam's load-bearing test: the sampler is a *sampling of* the Bézier,
    // not a second definition of the shape that could drift away from it.
    const bezier = sailBezier(shape);
    const points = sailPoints(shape);
    points.forEach((point, i) => {
      const onCurve = cubicPoint(shape.tack, bezier, i / SAIL_SAMPLES);
      expect(point.x).toBeCloseTo(onCurve.x, 12);
      expect(point.y).toBeCloseTo(onCurve.y, 12);
    });
  });

  it("facets by well under a millimetre between samples", () => {
    // Why SAIL_SAMPLES is sufficient rather than arbitrary: the worst error is
    // at each segment's midpoint, and it is a fortieth of a pixel on a phone.
    const bezier = sailBezier(shape);
    const points = sailPoints(shape);
    for (let i = 1; i <= SAIL_SAMPLES; i += 1) {
      const midpoint = scale(add(points[i - 1]!, points[i]!), 0.5);
      const onCurve = cubicPoint(shape.tack, bezier, (i - 0.5) / SAIL_SAMPLES);
      expect(magnitude(subtract(midpoint, onCurve))).toBeLessThan(0.001);
    }
  });
});

// --- Which side it bulges ---------------------------------------------------

describe("the sail always bulges to leeward (the acceptance criterion)", () => {
  const apparentAngles = [-179, -155, -120, -90, -60, -30, -15, -5, 5, 15, 30, 60, 90, 120, 155, 179];

  it("keeps the belly on the downwind side of the chord, at every trim on either tack", () => {
    for (const awa of apparentAngles) {
      const apparent = wind(10, awa);
      const flow = flowDirection(apparent);
      for (const trim of trimSweep(5)) {
        for (const shape of [mainShape(trim, apparent), jibShape(trim, apparent)]) {
          const deviation = bulge(shape, shape.draftPosition);
          // dot(offset, flow) = |depth|·|sin α| ≥ 0 — see the module docblock.
          // The floor is rounding rather than slack: an edge-on sail lands on
          // zero from either side, a few times 1e-17 out.
          expect(dot(deviation, flow)).toBeGreaterThan(-1e-12);
          if (Math.abs(shape.depth) > 1e-6) expect(dot(deviation, flow)).toBeGreaterThan(0);
        }
      }
    }
  });

  it("flips the bulge when the trim crosses the wind, not when it crosses the centreline", () => {
    // The criterion's wording is worth reading carefully. With the wind on the
    // starboard bow at 30°, the sail is edge-on at a trim of −30°, so that — not
    // zero — is where the belly changes sides.
    const apparent = wind(10, 30);
    const depthAt = (trimDegrees: number): number => mainShape(deg(trimDegrees), apparent).depth;

    expect(depthAt(-37)).toBeLessThan(0);
    expect(depthAt(-30)).toBe(0);
    expect(depthAt(-23)).toBeGreaterThan(0);

    // Straddling the centreline: same side, both times.
    expect(depthAt(-1)).toBeGreaterThan(0);
    expect(depthAt(1)).toBeGreaterThan(0);
  });

  it("mirrors exactly across the centreline", () => {
    for (const awa of [5, 30, 90, 155]) {
      for (const trim of trimSweep(5)) {
        const starboard = camberDepth(MAIN, trim, wind(10, awa));
        const port = camberDepth(MAIN, -trim, wind(10, -awa));
        expect(port).toBeCloseTo(-starboard, 12);
      }
    }
  });

  it("agrees with the model's lift on the attached limb", () => {
    // Restricted to attached flow on purpose: `foil.ts`'s flat-plate limb makes
    // Cl = 2 sinα cosα, which reverses at |α| = 90° where the belly does not.
    // The drawing's invariant is against the *flow*, not against lift.
    for (const awa of [-60, -30, -10, 10, 30, 60]) {
      const apparent = wind(10, awa);
      for (const trim of trimSweep(2)) {
        const alpha = angleOfAttack(trim, apparent);
        if (Math.abs(alpha) >= FOIL.stallAngle || Math.abs(alpha) <= LUFF.drawingAbove) continue;
        const depth = camberDepth(MAIN, trim, apparent);
        expect(Math.sign(depth)).toBe(Math.sign(foilCoefficients(alpha, MAIN.aspectRatio).lift));
      }
    }
  });

  it("stays honest with a backed sail (§3.4)", () => {
    // Boom shoved to windward off a mooring: driving force reverses, and the
    // belly is still on the face the wind is not striking.
    const apparent = wind(6, 10);
    const trim = deg(60);
    expect(sailForce(MAIN, trim, apparent).driving).toBeLessThan(0);

    const shape = mainShape(trim, apparent);
    expect(dot(bulge(shape, shape.draftPosition), flowDirection(apparent))).toBeGreaterThan(0);
  });
});

// --- Collapse ---------------------------------------------------------------

describe("camber collapses where the sail cannot hold a shape", () => {
  it("goes exactly flat inside the fully-luffing band (§3.3)", () => {
    for (const alpha of [-2, -1, 0, 1, 2]) {
      // Trim chosen so the angle of attack lands where we want it.
      const apparent = wind(10, 30);
      const trim = deg(alpha) - apparent.angle;
      expect(Math.abs(angleOfAttack(trim, apparent))).toBeLessThanOrEqual(LUFF.collapsedBelow + 1e-12);
      // Magnitude, because the product picks up the sign of sin α and lands on
      // −0 for a negative one. Flat is flat.
      expect(Math.abs(camberDepth(MAIN, trim, apparent))).toBe(0);
    }
  });

  it("fills monotonically as the luff stops shaking", () => {
    const apparent = wind(10, 30);
    let previous = 0;
    for (let a = 2; a <= 7; a += 0.25) {
      const depth = Math.abs(camberDepth(MAIN, deg(a) - apparent.angle, apparent));
      expect(depth).toBeGreaterThanOrEqual(previous);
      previous = depth;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it("goes flat again edge-on at the leech", () => {
    // α ≈ ±180° is the flow arriving at the leech — a flogging sail making
    // nothing, which `foil.ts` contemplates and which §3.3 also collapses since
    // pos-aa2. `sin α` collapsed it here first and over a much wider band, and
    // still supplies the side: without it the drawing would show full camber
    // here, on an arbitrary side, and flip it as α crossed 180°.
    const trim = deg(90);
    expect(camberDepth(MAIN, trim, wind(10, 90))).toBeCloseTo(0, 12);

    let previous = 0;
    for (let awa = 90; awa >= 83; awa -= 0.25) {
      const depth = Math.abs(camberDepth(MAIN, trim, wind(10, awa)));
      expect(depth).toBeGreaterThanOrEqual(previous);
      previous = depth;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it("never jumps as the angle of attack sweeps through either edge-on state", () => {
    // "No pop" measured against what a pop would look like: a full-camber sail
    // changing sides is 2 × 47 cm of movement, so a tenth of a degree moving
    // less than a hundredth of the full depth is a curve, not a jump.
    const fullCamber = MAIN.foot * MAX_DRAFT_FRACTION;
    for (const [trimDegrees, from, to] of [
      [90, 80, 100], // through α = 180°
      [0, -10, 10], // through α = 0°
    ] as const) {
      let previous: number | null = null;
      for (let awa = from; awa <= to; awa += 0.1) {
        const depth = camberDepth(MAIN, deg(trimDegrees), wind(10, awa));
        if (previous !== null) expect(Math.abs(depth - previous)).toBeLessThan(0.01 * fullCamber);
        previous = depth;
      }
    }
  });
});

describe("camber depth", () => {
  it("is the documented product of chord, draft, luff and pressure", () => {
    for (const awa of [15, 45, 90, 140]) {
      const apparent = wind(12, awa);
      for (const trim of trimSweep(5)) {
        const alpha = angleOfAttack(trim, apparent);
        // Only where the sail is *fully* drawing, so `expected` need not carry
        // the luff term. Asked of `luffFraction` rather than compared against
        // `LUFF.drawingAbove` by hand: §3.3 owns which angles those are, and it
        // has moved once already — pos-aa2 folded the thresholds about 90° as
        // well as about zero, which this guard silently missed.
        if (luffFraction(alpha) > 0) continue;
        const expected =
          MAIN.foot *
          MAX_DRAFT_FRACTION *
          pressureFactor(dynamicPressure(apparent.speed)) *
          Math.sin(alpha);
        expect(camberDepth(MAIN, trim, apparent)).toBeCloseTo(expected, 12);
      }
    }
  });

  it("softens near a calm and saturates in a breeze", () => {
    expect(pressureFactor(0)).toBe(0);
    expect(pressureFactor(dynamicPressure(knotsToMetersPerSecond(3)))).toBeCloseTo(0.5, 12);
    expect(pressureFactor(dynamicPressure(knotsToMetersPerSecond(10)))).toBeGreaterThan(0.9);

    let previous = -1;
    for (let knots = 0; knots <= 30; knots += 0.5) {
      const factor = pressureFactor(dynamicPressure(knotsToMetersPerSecond(knots)));
      expect(factor).toBeGreaterThan(previous);
      expect(factor).toBeLessThan(1);
      previous = factor;
    }
  });

  it("draws a straight line in a flat calm", () => {
    const shape = mainShape(deg(-40), wind(0, 30));
    expect(Math.abs(shape.depth)).toBe(0);
    for (const point of sailPoints(shape)) {
      // Collinear with the chord, which for a zero-camber sail is the sail.
      expect(magnitude(subtract(point, chordPoint(shape, 0)))).toBeLessThanOrEqual(MAIN.foot + 1e-9);
      const along = subtract(shape.clew, shape.tack);
      const across = point.x * along.y - point.y * along.x - (shape.tack.x * along.y - shape.tack.y * along.x);
      expect(across).toBeCloseTo(0, 12);
    }
  });
});

// --- The deformation seam ---------------------------------------------------

describe("the per-point deformation hook (the seam pos-dmg.2 inherits)", () => {
  const shape = mainShape(deg(-40), BREEZE);

  it("changes nothing when it returns what it was given", () => {
    expect(sailPoints(shape, (_, offset) => offset)).toEqual(sailPoints(shape));
  });

  it("displaces interior points normal to the chord, leaving the ends pinned", () => {
    const points = sailPoints(shape, (_, offset) => offset + 0.1);
    const base = sailPoints(shape);
    const along = subtract(shape.clew, shape.tack);
    const normal = scale({ x: -along.y, y: along.x }, 1 / magnitude(along));

    expect(points[0]).toEqual(shape.tack);
    expect(points[SAIL_SAMPLES]).toEqual(shape.clew);
    for (let i = 1; i < SAIL_SAMPLES; i += 1) {
      const moved = subtract(points[i]!, base[i]!);
      expect(moved.x).toBeCloseTo(0.1 * normal.x, 12);
      expect(moved.y).toBeCloseTo(0.1 * normal.y, 12);
    }
  });

  it("is called once per interior point, with the chord fraction and the undeformed offset", () => {
    const calls: [number, number][] = [];
    sailPoints(shape, (s, offset) => {
      calls.push([s, offset]);
      return offset;
    });

    expect(calls).toHaveLength(SAIL_SAMPLES - 1);
    calls.forEach(([s, offset], i) => {
      expect(s).toBeCloseTo((i + 1) / SAIL_SAMPLES, 12);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
      expect(offset).toBeCloseTo(shape.depth * camberProfile(s, shape.draftPosition), 12);
    });
  });

  it("supports the attenuate-then-add form pos-dmg.2 needs", () => {
    // The collapsed portion goes flat and ripples; the rest keeps its camber.
    // An addend-only hook could not have expressed the first half.
    const luffing = 0.4;
    const flutter = (s: number, offset: number): number =>
      offset * (s < luffing ? 0 : 1) + 0.05 * Math.sin(12 * s - 3);

    const points = sailPoints(shape, flutter);
    for (const point of points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
    expect(sailPathData(shape, flutter)).not.toMatch(/NaN|Infinity/);
  });
});

// --- Path data --------------------------------------------------------------

describe("sail path data", () => {
  const shape = mainShape(deg(-40), BREEZE);

  it("emits the bare Bézier when nothing is deforming it", () => {
    const d = sailPathData(shape);
    expect(d.startsWith("M ")).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(1);
    expect(d).not.toContain("L");
    expect(d.endsWith(`${formatted(shape.clew.x)} ${formatted(shape.clew.y)}`)).toBe(true);
  });

  it("emits a polyline of the right length when something is", () => {
    const d = sailPathData(shape, (_, offset) => offset + 0.01);
    expect((d.match(/L/g) ?? []).length).toBe(SAIL_SAMPLES);
    expect(d).not.toContain("C");
    expect(d.endsWith(`${formatted(shape.clew.x)} ${formatted(shape.clew.y)}`)).toBe(true);
  });

  it("emits nothing a renderer would choke on", () => {
    const shapes = [
      mainShape(deg(-40), BREEZE),
      mainShape(deg(-30), wind(10, 30)), // α = 0: fully luffing, depth exactly zero
      mainShape(deg(90), wind(10, 90)), // α = 180: edge-on at the leech
      mainShape(0, wind(0, 0)), // flat calm
      jibShape(deg(90), BREEZE),
      jibShape(deg(-90), BREEZE),
    ];
    for (const each of shapes) {
      for (const d of [sailPathData(each), sailPathData(each, (_, o) => o + 0.02)]) {
        expect(d).not.toMatch(/NaN|Infinity|e[+-]/i);
        expect(d).not.toMatch(/(^|\s)-0(\s|$)/);
        for (const value of d.match(/-?\d+(\.\d+)?/g) ?? []) {
          expect(Number.isFinite(Number(value))).toBe(true);
        }
      }
    }
  });

  it("is deterministic, so an unchanged sail rewrites no attribute", () => {
    expect(sailPathData(shape)).toBe(sailPathData(shape));
    expect(sailPathData(shape, (_, o) => o)).toBe(sailPathData(shape, (_, o) => o));
  });
});

// --- The traffic light ------------------------------------------------------

/**
 * §4.2's three acceptance criteria, asserted where they are actually made: the
 * ratio, not the DOM. The layer's job is one `setSailInk` call per sail, which
 * the node environment cannot exercise; what can go wrong here is the number.
 *
 * Where a criterion is about *colour* — "goes green", "goes red" — the check
 * runs the number through `palette.trimQualityColor` and compares against the
 * ramp's own end stops, so it fails if either the ratio or the fold onto the
 * ramp stops landing on them. `palette.test.ts` owns everything about the ramp
 * in between.
 */
describe("trim quality, the traffic light's number (DESIGN.md §4.2)", () => {
  /** The ramp's end stops, asked of the palette rather than written out here. */
  const GREEN = trimQualityColor(1);
  const RED = trimQualityColor(0);

  /** Close hauled to a dead run, on both tacks. */
  const POINTS_OF_SAIL = [30, 45, 60, 90, 120, 150, 180];

  const bothSails = [MAIN, JIB];

  /** Trims reading at or above `level`, as a share of the legal ±90° range. */
  function bandWidth(apparent: ApparentWind, level: number): number {
    const step = 0.25;
    let inside = 0;
    let total = 0;
    for (let d = -90; d <= 90; d += step) {
      total += 1;
      if (trimQuality(MAIN, deg(d), apparent) >= level) inside += 1;
    }
    return inside / total;
  }

  /**
   * The most driving trim, by brute force at a tenth of a degree.
   *
   * Deliberately *not* `optimalTrim`. Asking the quality about the angle its
   * own denominator came from is arithmetic, not a test — it would read 1 even
   * if both halves were wrong together. This is the independent answer, and it
   * is what "green at optimal trim" has to mean.
   */
  function mostDrivingTrim(sail: Sail, apparent: ApparentWind): Radians {
    const steps = 1800;
    let bestAngle = deg(-90);
    let bestDriving = -Infinity;
    for (let i = 0; i <= steps; i += 1) {
      // Off the index rather than accumulated, the way `optimalTrim`'s own
      // sweep is: `d += 0.1` drifts and stops at 89.99999999999832, so +90°
      // — which really is the optimum at AWA −120° and −180° — is never tried.
      const d = -90 + (180 * i) / steps;
      const driving = sailForce(sail, deg(d), apparent).driving;
      if (driving > bestDriving) {
        bestAngle = deg(d);
        bestDriving = driving;
      }
    }
    return bestAngle;
  }

  it("goes green at the optimal trim on every point of sail, on either tack", () => {
    for (const awa of [...POINTS_OF_SAIL, ...POINTS_OF_SAIL.map((a) => -a)]) {
      const apparent = wind(10, awa);
      for (const sail of bothSails) {
        const quality = trimQuality(sail, mostDrivingTrim(sail, apparent), apparent);
        // Not exactly 1, and *slightly over* it here: the search that supplies
        // the denominator refines to 0.3125° while this scan steps 0.1°, so a
        // scanned trim can beat it by a hair — 7e-5 at worst across these
        // angles. Which is the overshoot `palette.clampQuality` names as one of
        // the two reasons it folds rather than throws.
        expect(quality).toBeCloseTo(1, 3);
        expect(trimQualityColor(quality)).toBe(GREEN);
      }
    }
  });

  it("reads green *only* near the best trim, where the optimum is a real peak", () => {
    // The converse of the criterion above, and the half that catches a ramp
    // which has simply gone green everywhere. Asserting instead that nothing
    // reads *higher* than the optimum would prove nothing: inside one apparent
    // wind the denominator is a constant, so that is a statement about
    // `sailForce`'s argmax and would hold for any positive denominator at all.
    //
    // Restricted to angles where the optimum is a single peak. On a dead run
    // the two mirrored trims tie, so ±90° both read 1 and "near" has no
    // meaning; from AWA 113° to 123° the peak has left the legal range and sits
    // against the swing limit.
    for (const awa of [30, 45, 60, 90, -30, -90]) {
      const apparent = wind(10, awa);
      const best = mostDrivingTrim(MAIN, apparent);
      for (const trim of trimSweep(0.25)) {
        if (trimQuality(MAIN, trim, apparent) < 0.99) continue;
        // 1.4° at AWA 90 is the widest of these; 2° leaves room for the ramp
        // without letting a degenerate implementation through.
        expect(Math.abs(radiansToDegrees(trim - best))).toBeLessThan(2);
      }
    }
  });

  it("goes red overtrimmed, with the cloth dead still", () => {
    // Sheeted in hard: the flow stays attached to the cloth — nothing is
    // luffing — and the drive collapses anyway. This is the case §4.2 exists
    // for: without it an overtrimmed sail would look identical to a good one.
    //
    // Three of these are solidly negative (−0.51, −0.37, −0.15) and one lands
    // 4e-17 above zero, so they format to the ramp's exact red end stop. The
    // boom amidships on a broad reach is the one that does not: it reads
    // 0.0166, a sixtieth of the way up. So "red" is asked of the ramp's *hue*
    // as well as of the ratio — §4.4's stops run 30° → 52° → … → 145°, and a
    // hue below 35° is the bottom thirteenth of the ramp. The hue assertion is
    // implied by the ratio one against today's ramp; it is here so that the
    // colour claim keeps being checked if the ramp is ever re-authored.
    for (const [awa, trim] of [
      [30, 20],
      [45, 20],
      [60, 10],
      [90, 0],
      [150, 0],
    ] as const) {
      const apparent = wind(10, awa);
      expect(trimQuality(MAIN, deg(trim), apparent)).toBeLessThan(0.05);
      expect(trimQualityStop(trimQuality(MAIN, deg(trim), apparent)).hue).toBeLessThan(35);
      expect(luffFraction(angleOfAttack(deg(trim), apparent))).toBe(0);
    }

    // Dead downwind is the one exception, and the model is right to insist on
    // it: a boom hauled flat amidships on a run is edge-on to the wind at its
    // *leech* (α = 180°), and a real one slats. Red, and honestly luffing —
    // which is a statement about that trim, not about overtrimming.
    const run = wind(10, 180);
    expect(trimQualityStop(trimQuality(MAIN, 0, run)).hue).toBeLessThan(35);
    expect(luffFraction(angleOfAttack(0, run))).toBe(1);
  });

  it("goes red undertrimmed too, and that one *is* fluttering", () => {
    // The other direction, and the pair is what keeps the two failure modes
    // distinguishable: both red, one shaking (§4.2).
    for (const awa of [30, 45, 60, 90]) {
      const apparent = wind(10, awa);
      const eased = deg(-awa); // α = 0 exactly: the sail lies along the flow.
      expect(trimQualityColor(trimQuality(MAIN, eased, apparent))).toBe(RED);
      expect(luffFraction(angleOfAttack(eased, apparent))).toBe(1);
    }
  });

  it("falls off far more sharply close hauled than on a run", () => {
    // The claim §4.2 makes about *shape*, measured rather than asserted. In
    // 10 kt of apparent wind the trims reading 0.8 or better span 6.2% of the
    // legal range close hauled against 30.0% dead downwind, and the trims
    // reading 0.5 or better 11.5% against 50.8% — a bit under five times
    // wider, at both levels, from nothing but the driving-force ratio.
    for (const level of [0.8, 0.5]) {
      const closeHauled = bandWidth(wind(10, 30), level);
      const run = bandWidth(wind(10, 180), level);
      expect(run).toBeGreaterThan(4 * closeHauled);
    }

    // And it widens steadily in between rather than jumping at one angle.
    // Stated over the angles where the optimum is a real peak: between AWA 113°
    // and 123° the best trim is pinned to the swing limit — the sail wants to
    // be eased further than the shrouds allow — so the band there is a slice
    // off the side of a peak that has left the range, and it narrows sharply,
    // to 1.7% at AWA 120°, before opening out again past 125°.
    let previous = 0;
    for (const awa of [30, 45, 60, 90]) {
      const width = bandWidth(wind(10, awa), 0.8);
      expect(width).toBeGreaterThan(previous);
      previous = width;
    }
    expect(bandWidth(wind(10, 180), 0.8)).toBeGreaterThan(previous);
  });

  it("says the same thing at every wind speed", () => {
    // The ratio divides out dynamic pressure, and the floor is a coefficient —
    // `MINIMUM_USEFUL_DRIVE_COEFFICIENT` — so that it divides out too. Without that the sails
    // would refuse to go green in light air — the ramp would be reporting the
    // wind rather than the trim.
    for (const awa of [5, 8, 30, 90, 180]) {
      for (const trim of trimSweep(15)) {
        const reference = trimQuality(MAIN, trim, wind(10, awa));
        for (const knots of [1, 2, 25]) {
          expect(trimQuality(MAIN, trim, wind(knots, awa))).toBeCloseTo(reference, 12);
        }
      }
    }
  });

  it("paints every trim red in irons, where no trim drives at all", () => {
    // `optimalTrim` reports a best driving force of exactly zero below AWA
    // ≈ 4.3°, and hands the ratio to this side as §4.2's problem. Nothing may
    // read green here — and nothing may come out NaN either, which is what the
    // bare 0/0 would have given.
    for (const awa of [0, 1, 2, 3, 4, 4.2, -2, -4]) {
      const apparent = wind(10, awa);
      for (const sail of bothSails) {
        for (const trim of trimSweep(2)) {
          const quality = trimQuality(sail, trim, apparent);
          expect(Number.isFinite(quality)).toBe(true);
          expect(quality).toBeLessThanOrEqual(0);
          expect(trimQualityColor(quality)).toBe(RED);
        }
      }
    }
  });

  it("has no answer in a flat calm, and says so in red rather than in NaN", () => {
    for (const sail of bothSails) {
      for (const trim of trimSweep(15)) {
        expect(trimQuality(sail, trim, wind(0, 90))).toBe(0);
      }
    }
  });

  it("fades through the no-go zone instead of snapping at its edge", () => {
    // The floored denominator's whole purpose. Swept along the best trim
    // available at each angle, the quality climbs continuously from 0 in irons
    // to a full green by AWA 8°, with no step anywhere: the largest change over
    // a twentieth of a degree is 0.017, and it is at 8.15° — where the floor
    // stops binding, which is a corner in the slope and not a jump.
    let previous: number | null = null;
    for (let step = 0; step <= 280; step += 1) {
      // Off the index, so the sweep ends on 14° rather than on 13.95°.
      const apparent = wind(10, step / 20);
      const quality = trimQuality(MAIN, optimalTrim(MAIN, apparent).angle, apparent);
      if (previous !== null) expect(Math.abs(quality - previous)).toBeLessThan(0.05);
      previous = quality;
    }
    expect(previous).toBeCloseTo(1, 12);

    // Pinching at AWA 5° with the sheets perfect: not green, because no trim
    // there is worth calling good. Amber-to-red, and rising with the angle.
    const atOptimum = (awa: number): number =>
      trimQuality(MAIN, optimalTrim(MAIN, wind(10, awa)).angle, wind(10, awa));
    expect(atOptimum(5)).toBeLessThan(0.2);
    expect(atOptimum(6)).toBeGreaterThan(atOptimum(5));
    expect(atOptimum(8)).toBeGreaterThan(0.9);
    expect(atOptimum(10)).toBeCloseTo(1, 12);
  });

  it("mirrors across the centreline, like everything else in the drawing", () => {
    for (const awa of [5, 30, 90, 155]) {
      for (const trim of trimSweep(5)) {
        expect(trimQuality(MAIN, -trim, wind(10, -awa))).toBeCloseTo(
          trimQuality(MAIN, trim, wind(10, awa)),
          12,
        );
      }
    }
  });
});

// --- The rig, and the scene it has to fit in --------------------------------

describe("the rig", () => {
  const state: SimState = {
    wind: { from: deg(200), speed: knotsToMetersPerSecond(10) },
    motion: { heading: deg(35), speed: knotsToMetersPerSecond(4) },
    trim: { mainAngle: deg(-75), jibAngle: deg(-70), jibSet: true },
    mainHeld: false,
    jibHeld: false,
  };

  it("has no jib at all when the jib is struck (§3.7)", () => {
    expect(rigDrawing(state).jib).not.toBeNull();
    expect(rigDrawing({ ...state, trim: { ...state.trim, jibSet: false } }).jib).toBeNull();
  });

  it("derives each sail's shape and its quality from the one apparent wind", () => {
    const apparent = apparentWind(state.wind, state.motion);
    const drawing = rigDrawing(state);

    expect(drawing.main.shape).toEqual(mainShape(state.trim.mainAngle, apparent));
    expect(drawing.main.quality).toBe(trimQuality(MAIN, state.trim.mainAngle, apparent));
    expect(drawing.jib?.shape).toEqual(jibShape(state.trim.jibAngle, apparent));
    expect(drawing.jib?.quality).toBe(trimQuality(JIB, state.trim.jibAngle, apparent));

    // The apparent wind is the boat's own, not the true wind: it is what the
    // sails feel, so it is what the trim is judged against.
    expect(apparent.angle).not.toBeCloseTo(trueWindAngle(state.wind, state.motion), 3);
  });

  it("stays inside the disc the scene reserves for the boat", () => {
    // `SCENE.boatRadius` is measured from the hull and the clew arcs; the cloth
    // bulges outside its chord, so it needs checking rather than assuming. It
    // cannot win — at full ease the chord lies abeam, so its normal runs
    // fore-and-aft and the bulge moves along the disc rather than out of it —
    // but this is the guard for whoever next raises MAX_DRAFT_FRACTION.
    const fromPivot = (point: Vec2): number => magnitude(subtract(point, STATIONS.pivot));
    for (const awa of [-155, -90, -30, 30, 90, 155]) {
      const apparent = wind(20, awa);
      for (const trim of trimSweep(2)) {
        expect(Math.abs(trim)).toBeLessThanOrEqual(SWING_LIMIT + 1e-12);
        for (const shape of [mainShape(trim, apparent), jibShape(trim, apparent)]) {
          for (const point of sailPoints(shape)) {
            expect(fromPivot(point)).toBeLessThanOrEqual(SCENE.boatRadius + 1e-9);
          }
        }
      }
    }
  });

  it("builds a layer with both sails and a boom", () => {
    // The one structural check that does not need a DOM implementation to run:
    // `createSailLayer` is exercised by hand in the browser, as `createHullLayer`
    // is, so this only asserts the export exists and is a factory.
    expect(typeof createSailLayer).toBe("function");
  });
});

// --- helpers ----------------------------------------------------------------

/** How `svg.ts` will render a coordinate — four decimals, trailing zeros gone. */
function formatted(value: number): string {
  const trimmed = value.toFixed(4).replace(/\.?0+$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}
