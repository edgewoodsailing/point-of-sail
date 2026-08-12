import { describe, expect, it } from "vitest";

import type { Sail } from "../model/boat.ts";
import { JIB, MAIN, STATIONS, SWING_LIMIT, jibClewPosition, mainClewPosition } from "../model/boat.ts";
import { foilCoefficients } from "../model/foil.ts";
import {
  angleOfAttack,
  collapsedFraction,
  dynamicPressure,
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
  collapseAt,
  createSailLayer,
  flutterEnvelope,
  flutterRamp,
  jibShape,
  luffFlutter,
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

/**
 * A shape at a chosen angle of attack. The boom stays on the centreline and
 * the wind is moved instead, since α = AWA + trim — which keeps every case
 * here a legal trim, including the α = 180° one that needs the boom amidships
 * with the wind dead astern.
 */
function shapeAtAlpha(alphaDegrees: number): SailShape {
  return mainShape(0, wind(10, alphaDegrees));
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
    // pos-aa2. Both terms of the depth vanish here now, so this holds whichever
    // one is doing the work; pos-83f measured that `sin α` is no longer what
    // keeps the flip invisible, and kept it for the *incidence* instead.
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
  it("is the documented product of chord, draft, collapse and pressure", () => {
    for (const awa of [15, 45, 90, 140]) {
      const apparent = wind(12, awa);
      for (const trim of trimSweep(5)) {
        const alpha = angleOfAttack(trim, apparent);
        // Only where the sail is *fully* drawing, so `expected` need not carry
        // the collapse term. Asked of `collapsedFraction` rather than compared
        // against `LUFF.drawingAbove` by hand: §3.3 owns which angles those are,
        // and it has moved once already — pos-aa2 folded the thresholds about 90°
        // as well as about zero, which this guard silently missed.
        if (collapsedFraction(alpha) > 0) continue;
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

// --- Where the collapse is ---------------------------------------------------

describe("the collapsed region runs from the edge that is breaking (pos-83f)", () => {
  it("carries the model's fraction and edge onto the shape", () => {
    for (const alpha of [0, 3, 5, 15, 90, 175, 180]) {
      const apparent = wind(10, alpha);
      const shape = shapeAtAlpha(alpha);
      const fromModel = collapsedFraction(angleOfAttack(0, apparent));
      expect(shape.collapsedFraction, `${alpha}°`).toBe(fromModel);
      expect(shape.collapseFrom, `${alpha}°`).toBe(alpha > 90 ? "leech" : "luff");
    }
  });

  it("shakes nothing at all when the sail is drawing", () => {
    const drawing = shapeAtAlpha(30);
    expect(drawing.collapsedFraction).toBe(0);
    for (const s of [0, 0.25, 0.5, 0.75, 1]) expect(collapseAt(drawing, s)).toBe(0);
  });

  /**
   * The bug this bead exists for, stated as a position on the cloth. At α = 175°
   * the fraction is 0.35 and the sail is breaking at its *leech*, so the after
   * 35% shakes and the forward 65% does not — the exact opposite of what the
   * old luff-aft axis drew.
   */
  it("shakes the after end at the leech and the forward end at the luff", () => {
    const leech = shapeAtAlpha(175);
    expect(leech.collapseFrom).toBe("leech");
    expect(leech.collapsedFraction).toBeCloseTo(0.352, 3);
    expect(collapseAt(leech, 0.2)).toBe(0);
    expect(collapseAt(leech, 0.5)).toBe(0);
    expect(collapseAt(leech, 0.99)).toBeGreaterThan(0);

    // The same fraction the other side of the fold, breaking the other way.
    const luff = shapeAtAlpha(5);
    expect(luff.collapseFrom).toBe("luff");
    expect(luff.collapsedFraction).toBeCloseTo(0.352, 3);
    expect(collapseAt(luff, 0.01)).toBeGreaterThan(0);
    expect(collapseAt(luff, 0.5)).toBe(0);
    expect(collapseAt(luff, 0.8)).toBe(0);
  });

  it("reads 1 at the breaking edge, 0 at the boundary, and rises in between", () => {
    for (const alpha of [3, 4, 5, 6, 175, 176, 177]) {
      const shape = shapeAtAlpha(alpha);
      const f = shape.collapsedFraction;
      const atEdge = shape.collapseFrom === "luff" ? 0 : 1;
      const boundary = shape.collapseFrom === "luff" ? f : 1 - f;

      expect(collapseAt(shape, atEdge), `${alpha}°`).toBeCloseTo(1, 12);
      expect(collapseAt(shape, boundary), `${alpha}°`).toBeCloseTo(0, 12);
      // Halfway in, from whichever end.
      const half = shape.collapseFrom === "luff" ? f / 2 : 1 - f / 2;
      expect(collapseAt(shape, half), `${alpha}°`).toBeCloseTo(0.5, 12);
    }
  });

  /**
   * Wholly collapsed, at either edge-on state: the region has grown to the whole
   * chord, so every interior point is inside it. The far end reads exactly 0 —
   * not a gap, but the boundary having arrived there.
   *
   * **Read that 0 as "furthest from where the flow detached", not "not
   * moving".** This pins the aerodynamic quantity `collapseAt` promises, and at
   * full collapse the far end is the *unsupported* one — a sail flogging head to
   * wind whips hardest exactly there. See `collapseAt`'s docblock and §4.1; a
   * flutter that reads this alone will hold the wrong end still.
   */
  it("covers the whole chord when the sail is wholly collapsed, at either edge", () => {
    for (const alpha of [0, 1, 180, 179]) {
      const shape = shapeAtAlpha(alpha);
      expect(shape.collapsedFraction, `${alpha}°`).toBe(1);
      for (const s of [0.01, 0.25, 0.5, 0.75, 0.99]) {
        expect(collapseAt(shape, s), `${alpha}° at s=${s}`).toBeGreaterThan(0);
      }

      const breaking = shape.collapseFrom === "luff" ? 0 : 1;
      expect(collapseAt(shape, breaking), `${alpha}°`).toBe(1);
      expect(collapseAt(shape, 1 - breaking), `${alpha}°`).toBe(0);
    }
  });

  /**
   * Bounded, and monotone toward the edge that is going — the two things a
   * flutter's amplitude ramp depends on, swept rather than spot-checked. Not a
   * *step* bound: the region's slope is `1/collapsedFraction`, which is
   * unbounded as the collapse first appears, so a fixed-step continuity check
   * would be pinning the sweep rather than the function.
   */
  it("is bounded, and deepens monotonically toward the breaking edge", () => {
    for (let alpha = 0; alpha <= 180; alpha += 0.5) {
      const shape = shapeAtAlpha(alpha);
      // Walk from the drawing end toward the breaking one, whichever that is.
      const toward = shape.collapseFrom === "luff" ? -1 : 1;
      let previous = -Infinity;
      for (let i = 0; i <= 200; i += 1) {
        const s = toward === 1 ? i / 200 : 1 - i / 200;
        const current = collapseAt(shape, s);
        expect(current, `${alpha}° at s=${s}`).toBeGreaterThanOrEqual(0);
        expect(current, `${alpha}° at s=${s}`).toBeLessThanOrEqual(1);
        expect(current, `${alpha}° at s=${s}`).toBeGreaterThanOrEqual(previous - 1e-12);
        previous = current;
      }
    }
  });

  /**
   * The fold's corner, seen from the drawing side. `collapseFrom` flips from
   * luff to leech at exactly α = 90°, and nothing can see it: the fraction is a
   * flat zero for tens of degrees either side, so the region is empty on both
   * limbs and the switch moves no cloth.
   */
  it("switches edges at α = 90° without moving anything", () => {
    for (const alpha of [89.9, 90, 90.1]) {
      const shape = shapeAtAlpha(alpha);
      expect(shape.collapsedFraction, `${alpha}°`).toBe(0);
      for (const s of [0, 0.5, 1]) expect(collapseAt(shape, s), `${alpha}°`).toBe(0);
    }
    expect(shapeAtAlpha(89.9).collapseFrom).toBe("luff");
    expect(shapeAtAlpha(90.1).collapseFrom).toBe("leech");
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

  /**
   * The collapsed portion goes flat and ripples; the rest keeps its camber. An
   * addend-only hook could not have expressed the first half.
   *
   * Written through `collapseAt` rather than a hand-rolled `s < fraction`,
   * because this is the executable form pos-dmg.2 is meant to copy and the axis
   * is the thing it must not get wrong. Run at both bands with the *same*
   * collapsed fraction: the flattening has to follow the breaking edge, which
   * is the luff at α = 5° and the leech at α = 175°.
   */
  it("supports the attenuate-then-add form pos-dmg.2 needs", () => {
    for (const alpha of [5, 175]) {
      const collapsing = mainShape(0, wind(10, alpha));
      expect(collapsing.collapsedFraction, `${alpha}°`).toBeCloseTo(0.352, 3);

      const ripple = (s: number): number => 0.05 * Math.sin(12 * s - 3);
      const flutter = (s: number, offset: number): number =>
        offset * (1 - collapseAt(collapsing, s)) + ripple(s);

      for (const point of sailPoints(collapsing, flutter)) {
        expect(Number.isFinite(point.x), `${alpha}°`).toBe(true);
        expect(Number.isFinite(point.y), `${alpha}°`).toBe(true);
      }
      expect(sailPathData(collapsing, flutter), `${alpha}°`).not.toMatch(/NaN|Infinity/);

      // With the ripple silenced, what is left is the attenuation — and it must
      // flatten the end that is breaking while the other end keeps its camber.
      // Compared as a *retained fraction* of the undeformed offset, so the
      // camber profile's own asymmetry does not decide the answer.
      const flatten = (s: number, offset: number): number =>
        offset * (1 - collapseAt(collapsing, s));
      const retained = (s: number): number =>
        magnitude(subtract(sailPoint(collapsing, s, flatten), chordPoint(collapsing, s))) /
        magnitude(bulge(collapsing, s));

      const forward = retained(0.1);
      const aft = retained(0.9);
      expect(forward, `${alpha}° forward`).toBeGreaterThanOrEqual(0);
      expect(aft, `${alpha}° aft`).toBeGreaterThanOrEqual(0);
      if (collapsing.collapseFrom === "luff") {
        expect(forward, `${alpha}°`).toBeLessThan(aft);
      } else {
        expect(aft, `${alpha}°`).toBeLessThan(forward);
      }
    }
  });
});

// --- The luffing flutter ----------------------------------------------------

/**
 * pos-dmg.2's travelling sine (DESIGN.md §4.1), asserted where it is made: the
 * geometry, not the DOM. The `node` environment cannot exercise the layer's
 * animation loop at all, and nothing here should be read as evidence about
 * frame rate on a tablet — see the module docblock in `sail.ts` for what was
 * and was not measured.
 */
describe("the luffing flutter (pos-dmg.2, DESIGN.md §4.1)", () => {
  /**
   * Mirrors `FLUTTER_AMPLITUDE_FRACTION` in `sail.ts`, restated rather than
   * imported for the same reason {@link MAX_DRAFT_FRACTION} is: so the sizes
   * below are pinned by an independent number.
   */
  const FLUTTER_AMPLITUDE_FRACTION = 0.04;

  const chordLength = (shape: SailShape): number => magnitude(subtract(shape.clew, shape.tack));

  /** The ripple's peak, in metres, before the envelope scales it down. */
  const peakRipple = (shape: SailShape): number =>
    chordLength(shape) * FLUTTER_AMPLITUDE_FRACTION;

  /**
   * The ripple alone: what the hook adds on top of the attenuated camber it
   * replaces. Recovered rather than read off the implementation, so the
   * attenuate-then-add form itself is under test.
   */
  function ripple(shape: SailShape, s: number, time: number): number {
    const deform = luffFlutter(shape, time);
    if (deform === undefined) return 0;
    const camber = shape.depth * camberProfile(s, shape.draftPosition);
    return deform(s, camber) - camber * (1 - collapseAt(shape, s));
  }

  /** The travelling sine with its envelope divided out, in −1..1. */
  function wave(shape: SailShape, s: number, time: number): number {
    return ripple(shape, s, time) / (peakRipple(shape) * flutterEnvelope(shape, s));
  }

  /**
   * A shape at a chosen collapsed fraction and edge, for the two places where
   * the quantity under test is a function of the *fraction* rather than of a
   * trim — so it can be evaluated at its maximum instead of swept up to it.
   * Everything but the two collapse fields is the main's real geometry.
   */
  function collapsingShape(collapsedFraction: number, collapseFrom: "luff" | "leech"): SailShape {
    return { ...shapeAtAlpha(0), collapsedFraction, collapseFrom };
  }

  /** Where the envelope peaks, as a chord fraction, and how big it is there. */
  function envelopePeak(shape: SailShape): { at: number; value: number } {
    let best = { at: 0, value: 0 };
    for (let i = 0; i <= 1000; i += 1) {
      const value = flutterEnvelope(shape, i / 1000);
      if (value > best.value) best = { at: i / 1000, value };
    }
    return best;
  }

  it("does not exist at all while the sail is drawing", () => {
    for (const alpha of [7, 8, 15, 45, 90, 135, 170, 173]) {
      const shape = shapeAtAlpha(alpha);
      expect(shape.collapsedFraction, `${alpha}°`).toBe(0);
      expect(luffFlutter(shape, 0.4), `${alpha}°`).toBeUndefined();
      // Which is what keeps the ordinary case free: the bare Bézier, not a
      // polyline of 32 identical-to-the-curve samples.
      expect(sailPathData(shape, luffFlutter(shape, 0.4)), `${alpha}°`).not.toContain("L");
    }
  });

  /**
   * The bead's first acceptance criterion, swept rather than spot-checked, and
   * on both limbs: the flutter is present exactly when §3.3 reports a collapse
   * and never otherwise.
   */
  it("appears exactly when the model reports a collapse, at either edge", () => {
    for (let alpha = 0; alpha <= 180; alpha += 0.25) {
      const shape = shapeAtAlpha(alpha);
      expect(luffFlutter(shape, 1.7) !== undefined, `${alpha}°`).toBe(
        shape.collapsedFraction > 0,
      );
    }
  });

  it("leaves the tack and the clew exactly where they are, at every phase", () => {
    for (const alpha of [0, 2, 3, 5, 175, 177, 180]) {
      const shape = shapeAtAlpha(alpha);
      for (const time of [0, 0.05, 0.11, 0.37, 1.9, 60]) {
        const points = sailPoints(shape, luffFlutter(shape, time));
        expect(points[0], `${alpha}° at ${time}s`).toEqual(shape.tack);
        expect(points[SAIL_SAMPLES], `${alpha}° at ${time}s`).toEqual(shape.clew);
      }
    }
  });

  /**
   * §4.1's whole point, and the thing the old `s < collapsedFraction` axis got
   * backwards: a sail *just* starting to break shows a small ripple at the edge
   * the flow arrives at, and nowhere else. At α = 5° and α = 175° the same 35%
   * of cloth has gone — at opposite ends.
   */
  it("starts at the edge the flow arrives at, and nowhere else", () => {
    for (const [alpha, edge, expected] of [
      [5, "luff", 0.09],
      [175, "leech", 0.91],
    ] as const) {
      const shape = shapeAtAlpha(alpha);
      expect(shape.collapseFrom, `${alpha}°`).toBe(edge);
      expect(shape.collapsedFraction, `${alpha}°`).toBeCloseTo(0.352, 3);

      expect(envelopePeak(shape).at, `${alpha}°`).toBeCloseTo(expected, 2);
      // And the far end of the sail is not moving at all.
      const far = edge === "luff" ? 0.9 : 0.1;
      expect(ripple(shape, far, 0.3), `${alpha}°`).toBe(0);
    }
  });

  /**
   * "Amplitude scales with how deeply it is luffing." `collapseAt` alone reads
   * 1 at the breaking edge however little cloth has gone, so without the
   * `collapsedFraction` scalar a sail 1% collapsed would shiver at full
   * amplitude in a sliver.
   */
  it("grows with the collapse rather than arriving at full size", () => {
    let previous = 0;
    // Deepening the collapse. 7° is fully drawing; 3° is 0.896 collapsed, which
    // is where the cross-fade below starts and where this claim stops being
    // exactly true — see the next test for what happens across it.
    for (let alpha = 6.75; alpha >= 3; alpha -= 0.25) {
      const shape = shapeAtAlpha(alpha);
      const peak = envelopePeak(shape).value * peakRipple(shape);
      expect(peak, `${alpha}°`).toBeGreaterThan(previous);
      previous = peak;
    }
    // And the deepest collapse of all is bigger still than where it left off.
    expect(envelopePeak(shapeAtAlpha(0)).value * peakRipple(shapeAtAlpha(0))).toBeGreaterThan(
      previous,
    );
  });

  /**
   * **The cross-fade is not quite monotone in amplitude**, and the honest thing
   * is to bound the dip rather than to assert a growth that is not there. While
   * the ramp is swapping ends the two halves pull opposite ways, so the mixture
   * is flatter than either of them.
   *
   * The normalisation in `flutterEnvelope` is what keeps that to 5.3%, at
   * α = 2.44°; without it the mixture cancels and the dip is 37%, which is a
   * ripple visibly shrinking and swelling as a boat comes head to wind. What is
   * left is a twentieth of an amplitude that is itself 5.7 px peak to peak on a
   * phone, spread over about a degree of angle of attack.
   */
  it("dips no more than a tenth in amplitude while the ramp swaps ends", () => {
    let highest = 0;
    let deepestDip = 0;
    for (let alpha = 3; alpha >= 0; alpha -= 0.05) {
      const shape = shapeAtAlpha(alpha);
      const peak = envelopePeak(shape).value * peakRipple(shape);
      highest = Math.max(highest, peak);
      deepestDip = Math.max(deepestDip, (highest - peak) / highest);
    }
    expect(deepestDip).toBeGreaterThan(0);
    expect(deepestDip).toBeLessThan(0.1);
  });

  /**
   * The sizes, in the units that decide whether a student can see it. Pinned
   * because visibility is the acceptance criterion and a silent change to any
   * of the three flutter constants would move them.
   *
   * The binding case is the jib on a 320 px phone, where `SHORT_SPAN` = 12 m
   * spans 320 px, so a metre is 26.7 px. A wholly collapsed jib then shivers
   * 4.4 px peak to peak against a 2.2 px stroke.
   */
  it("is drawn big enough to spot and small enough not to read as camber", () => {
    const pxPerMeter = 320 / (2 * SCENE.shortRadius);

    /** Peak-to-peak in CSS px on that phone. */
    const spread = (shape: SailShape): number =>
      2 * envelopePeak(shape).value * peakRipple(shape) * pxPerMeter;

    const flogging = shapeAtAlpha(0);
    expect(flogging.collapsedFraction).toBe(1);
    expect(envelopePeak(flogging).value * peakRipple(flogging)).toBeCloseTo(0.1065, 4);
    expect(spread(flogging)).toBeCloseTo(5.68, 2);

    const jib = jibShape(0, wind(10, 0));
    expect(jib.collapsedFraction).toBe(1);
    expect(envelopePeak(jib).value * peakRipple(jib)).toBeCloseTo(0.0824, 4);
    expect(spread(jib)).toBeCloseTo(4.39, 2);

    // Just breaking: a ripple, not a flap. 1.6 px peak to peak on that phone.
    const breaking = shapeAtAlpha(5);
    expect(envelopePeak(breaking).value * peakRipple(breaking)).toBeCloseTo(0.0302, 4);
    expect(spread(breaking)).toBeCloseTo(1.61, 2);

    // And never mistakable for camber: full draft on the main is 0.473 m.
    expect(0.1065).toBeLessThan(0.25 * MAIN.foot * MAX_DRAFT_FRACTION);
  });

  /**
   * **The largest ripple is not the flogging one**, which the test above would
   * leave you believing. The envelope tops out at 0.942 — 5% above its
   * full-collapse value — at `collapsedFraction ≈ 0.95`, α = 2.68°, and at
   * `s = 0.10` rather than at the leech: the normalised cross-fade is broadest
   * halfway across, so the peak sits higher there than at either end of it.
   *
   * Pinned because it is the figure that actually has to stay legible, and
   * because a change to any of the flutter constants moves this before it moves
   * the flogging case.
   */
  it("is largest in the middle of the cross-fade, not head to wind", () => {
    // **Evaluated at the maximum rather than swept up to it.** A sampled sweep
    // reports its own step size here: the ridge is narrow in α and sits exactly
    // on the taper's inner corner, so coarsening from 0.001° to 0.05° walks the
    // answer from 0.9448 down to 0.9243. The maximum is instead reached in
    // closed form — at `collapsedFraction = 0.95` the cross-fade weight is
    // `smoothstep(0.5) = 0.5`, both ends of the mixture are 0.5, and at s = 0.1
    // the taper has just reached 1, giving exactly 0.945 — and a synthetic shape
    // can be put there directly. That fraction is reachable: α ≈ 2.677°.
    const atPeak = collapsingShape(0.95, "luff");
    expect(flutterEnvelope(atPeak, 0.1)).toBeCloseTo(0.945, 12);
    expect(shapeAtAlpha(2.677).collapsedFraction).toBeCloseTo(0.95, 3);

    // Bigger than head to wind, and further forward than the leech.
    expect(flutterEnvelope(atPeak, 0.1)).toBeGreaterThan(
      envelopePeak(shapeAtAlpha(0)).value,
    );

    // And nothing anywhere exceeds it. Swept coarsely on purpose — as an upper
    // bound a sparse grid can only understate, so this cannot pass by luck.
    let highest = 0;
    for (const make of [mainShape, jibShape]) {
      for (let alpha = 0; alpha <= 180; alpha += 0.01) {
        const shape = make(0, wind(10, alpha));
        if (shape.collapsedFraction <= 0) continue;
        for (let i = 0; i <= 500; i += 1) {
          highest = Math.max(highest, flutterEnvelope(shape, i / 500));
        }
      }
    }
    expect(highest).toBeLessThanOrEqual(0.945 + 1e-12);

    // 5.96 px peak to peak on the main and 4.61 on the jib, on a 320 px phone —
    // *above* the flogging figures above rather than below them.
    const pxPerMeter = 320 / (2 * SCENE.shortRadius);
    const spread = (shape: SailShape): number => 2 * 0.945 * peakRipple(shape) * pxPerMeter;
    expect(spread(shapeAtAlpha(0))).toBeCloseTo(5.96, 2);
    expect(spread(jibShape(0, wind(10, 0)))).toBeCloseTo(4.61, 2);
  });

  /**
   * It *travels*, and it travels with the flow — aft when the wind arrives at
   * the luff, forward when it arrives at the leech. Asserted as an exact phase
   * invariance rather than by eyeballing two frames: a wave moving at one chord
   * a second satisfies `wave(s + v·dt, t + dt) = wave(s, t)`.
   *
   * This is the one thing that reads `collapseFrom` outside `collapseAt`, and
   * it is only the sign of the phase gradient — `s` stays a monotone position
   * on the drawn chord, which is what the phase depends on.
   */
  it("travels with the flow, at one chord length a second", () => {
    const chordsPerSecond = 1;
    for (const alpha of [0, 180]) {
      const shape = shapeAtAlpha(alpha);
      const toward = shape.collapseFrom === "luff" ? 1 : -1;
      for (const s of [0.3, 0.5, 0.7]) {
        for (const dt of [0.01, 0.05, 0.1]) {
          expect(
            wave(shape, s + toward * chordsPerSecond * dt, 0.4 + dt),
            `${alpha}° at s=${s} +${dt}s`,
          ).toBeCloseTo(wave(shape, s, 0.4), 10);
        }
      }
    }
  });

  /**
   * **The decision §4.1 left to the animation** (`collapseAt`'s docblock and
   * §4.1 both say it is this bead's to make): while the collapse is partial the
   * ripple sits at the *detached* edge, and once the whole chord has let go it
   * sits at the *unsupported* one — the leech, which whips because nothing is
   * holding it.
   *
   * Note the asymmetry is only apparent. On the leech-first limb `collapseAt`
   * at full collapse already *is* `s`, so the cross-fade is the identity there
   * and the whole effect is head to wind. The next test pins that.
   */
  it("moves the shake to the unsupported leech once the whole sail has let go", () => {
    for (const alpha of [0, 1, 2, 178, 179, 180]) {
      const shape = shapeAtAlpha(alpha);
      expect(shape.collapsedFraction, `${alpha}°`).toBe(1);
      expect(envelopePeak(shape).at, `${alpha}°`).toBeCloseTo(0.9, 2);
      // Dead still where it is pinned to the mast, whichever way the flow came.
      expect(ripple(shape, 0.02, 0.3), `${alpha}°`).toBeCloseTo(0, 3);
    }
  });

  /**
   * **The invariant the closed-form normaliser stands or falls on, tested on the
   * quantity it is actually about.**
   *
   * An earlier version of this test swept `flutterEnvelope` for `≤ 1` and
   * claimed that proved the normaliser. It does not, and the reason is worth
   * keeping: the envelope is `ramp × collapsedFraction × endTaper(s)`, and both
   * extra factors bite hardest exactly where the ramp peaks. On the luff limb at
   * full collapse the ramp peaks at `s = 1`, where `endTaper` is *zero* — so the
   * envelope sweep never sees the quantity at all. It tops out at 0.945, leaving
   * 5% of headroom through which a normaliser understated by 5% would sail
   * unnoticed, drawing a ripple deeper than `FLUTTER_AMPLITUDE_FRACTION` allows.
   *
   * `flutterRamp` is that quantity with the two dampers off, and swept over both
   * sails and every collapse it reaches **exactly** 1 and never exceeds it.
   */
  it("has a ramp that reaches exactly 1 and never passes it", () => {
    // Reduced to a few assertions rather than one per sample: the sweep is
    // 1.4 million points, and `expect` at every one of them is what makes a
    // test like this time out instead of run.
    let lowest = Infinity;
    let highest = -Infinity;
    let highestAt = "";
    for (const make of [mainShape, jibShape]) {
      for (let alpha = 0; alpha <= 180; alpha += 0.05) {
        const shape = make(0, wind(10, alpha));
        for (let i = 0; i <= 200; i += 1) {
          const value = flutterRamp(shape, i / 200);
          lowest = Math.min(lowest, value);
          if (value > highest) {
            highest = value;
            highestAt = `${alpha.toFixed(2)}° at s=${i / 200}`;
          }
        }
      }
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(highest, highestAt).toBeLessThanOrEqual(1);
    // Equality reached, so `≤ 1` is tight here rather than roomy. This is what
    // the envelope sweep could not do.
    expect(highest).toBeCloseTo(1, 12);
  });

  it("has a ramp of 0 wherever there is nothing collapsed to shake", () => {
    for (const alpha of [8, 20, 90, 160, 173]) {
      const shape = shapeAtAlpha(alpha);
      expect(shape.collapsedFraction, `${alpha}°`).toBe(0);
      for (const s of [0, 0.25, 0.5, 0.75, 1]) {
        expect(flutterRamp(shape, s), `${alpha}° at s=${s}`).toBe(0);
      }
    }
  });

  it("changes nothing at all on the leech-first limb, where collapseAt already is s", () => {
    const flogging = shapeAtAlpha(180);
    expect(flogging.collapseFrom).toBe("leech");
    for (let i = 0; i <= 100; i += 1) {
      expect(collapseAt(flogging, i / 100), `s=${i / 100}`).toBeCloseTo(i / 100, 12);
    }
  });

  /**
   * The cross-fade's onset is above `collapsedFraction` 0.9 — |α| < 2.98° — so
   * every partial collapse §4.1 cares about is left exactly where `collapseAt`
   * puts it, with no ripple outside the region at all.
   */
  it("leaves every partial collapse exactly where collapseAt puts it", () => {
    let checked = 0;
    for (let alpha = 0; alpha <= 180; alpha += 0.25) {
      const shape = shapeAtAlpha(alpha);
      if (!(shape.collapsedFraction > 0 && shape.collapsedFraction <= 0.9)) continue;
      checked += 1;
      for (let i = 0; i <= 200; i += 1) {
        const s = i / 200;
        if (collapseAt(shape, s) === 0) {
          expect(flutterEnvelope(shape, s), `${alpha}° at s=${s}`).toBe(0);
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  /**
   * Above the onset the `s` term is not gated on the region, so it does reach a
   * little past the boundary onto cloth §3.3 still calls "drawing" — and the
   * honest thing is to measure that overhang rather than to claim there is
   * none. Gating it would trade a smear for a real discontinuity in the drawn
   * shape at the boundary, which is the worse of the two.
   *
   * **Measured at the points that are actually drawn**, which is the number
   * that matters: {@link sailPoints} evaluates 31 interior samples, and the
   * worst overhang at any of them, over every partial collapse of both limbs,
   * is 0.217 of peak — 0.026 m on the main, 2.2 px of amplitude on a 1024 px
   * iPad. It falls on the single sample at `s = 0.969`, at α = 2.55°, where
   * 96.6% of the sail has gone and the drawn camber is 0.65 mm. Sampled on the
   * continuum instead it reaches 0.40, at `s = 0.954` — between two samples,
   * so never on screen.
   */
  it("bounds what it can move outside the collapsed region", () => {
    let worst = 0;
    for (let alpha = 0; alpha <= 180; alpha += 0.05) {
      const shape = shapeAtAlpha(alpha);
      if (!(shape.collapsedFraction > 0 && shape.collapsedFraction < 1)) continue;
      for (let i = 1; i < SAIL_SAMPLES; i += 1) {
        const s = i / SAIL_SAMPLES;
        if (collapseAt(shape, s) > 0) continue;
        worst = Math.max(worst, flutterEnvelope(shape, s));
      }
    }
    expect(worst).toBeLessThan(0.25);
    // 2.2 px of amplitude on the tablet §4.5 sizes everything against.
    const iPadPxPerMeter = 1024 / (2 * SCENE.shortRadius);
    expect(worst * peakRipple(shapeAtAlpha(2.55)) * iPadPxPerMeter).toBeLessThan(2.5);
    // Not zero: the cross-fade above is what puts it there, and a future change
    // that made this exactly 0 would have removed the flogging behaviour.
    expect(worst).toBeGreaterThan(0);
  });

  /**
   * Both ends of the drawn chord are attachments — the mast or
   * `STATIONS.jibTack`, and the clew, which is a grab point. The hook is never
   * called there, but that alone would leave the first interior sample carrying
   * nearly full amplitude beside a fixed point and draw a spike rather than a
   * ripple. The end taper is what makes the flutter grow out of the attachment.
   */
  it("grows out of its attachments instead of spiking off them", () => {
    let worstEnd = 0;
    for (const make of [mainShape, jibShape]) {
      for (let alpha = 0; alpha <= 180; alpha += 0.05) {
        const shape = make(0, wind(10, alpha));
        if (shape.collapsedFraction <= 0) continue;
        for (const s of [1 / SAIL_SAMPLES, 1 - 1 / SAIL_SAMPLES]) {
          worstEnd = Math.max(worstEnd, flutterEnvelope(shape, s) * peakRipple(shape));
        }
      }
    }

    // Measured in metres rather than as a share of *this* shape's own peak: at a
    // collapse so slight that only one sample falls inside the region, that
    // sample necessarily is the peak, and the ratio reads 0.99 while the sail
    // moves two hundredths of a pixel. The size is the thing that matters.
    //
    // A `worstEnd < 0.25 × largestAnywhere` assertion used to sit here as well.
    // It is gone rather than loosened: it passed with 3% of margin, all of it
    // set by `FLUTTER_END_TAPER` against `1 / SAIL_SAMPLES` and none of it a
    // design property, and leaving it beside the honest bounds below would have
    // left the coincidence doing the guarding.
    //
    // This one **is** a pinned measurement of the current constants rather than
    // a bound, and is meant to fail when one of them moves.
    expect(worstEnd).toBeCloseTo(0.0266, 4);

    // These two *are* bounds, and they are the ones that mean something: under
    // a pixel on a phone, and under two and a half on the tablet §4.5 sizes
    // everything against.
    expect(worstEnd * (320 / (2 * SCENE.shortRadius))).toBeLessThan(1);
    expect(worstEnd * (1024 / (2 * SCENE.shortRadius))).toBeLessThan(2.5);
  });

  /**
   * The polyline is a chord-by-chord approximation of a curve that now carries
   * three ripples as well as the camber, so §4.1's 0.4 mm faceting figure is
   * about the *base* camber and does not cover this. Measured over both sails,
   * every collapse and five phases, the worst sagitta is 9.65 mm — 0.26 px on a
   * 320 px phone against a 2.2 px stroke, and 1.16 px on a 1440 px desktop
   * against a 6 px one. `stroke-linejoin: round` covers the rest.
   */
  it("facets by well under a stroke width even at three ripples a chord", () => {
    let worst = 0;
    for (const make of [mainShape, jibShape]) {
      for (let alpha = 0; alpha <= 180; alpha += 0.5) {
        const shape = make(0, wind(10, alpha));
        for (const time of [0, 0.07, 0.13, 0.21, 0.29]) {
          const deform = luffFlutter(shape, time);
          if (deform === undefined) continue;
          const points = sailPoints(shape, deform);
          for (let i = 0; i < points.length - 1; i += 1) {
            const midpoint = scale(add(points[i]!, points[i + 1]!), 0.5);
            const onCurve = sailPoint(shape, (i + 0.5) / SAIL_SAMPLES, deform);
            worst = Math.max(worst, magnitude(subtract(onCurve, midpoint)));
          }
        }
      }
    }
    expect(worst).toBeLessThan(0.011);
    expect(worst * (320 / (2 * SCENE.shortRadius))).toBeLessThan(0.3);
    expect(worst * (1440 / (2 * SCENE.shortRadius))).toBeLessThan(1.2);
  });

  it("emits nothing a renderer would choke on, at any collapse or phase", () => {
    for (const make of [mainShape, jibShape]) {
      for (let alpha = 0; alpha <= 180; alpha += 0.5) {
        for (const time of [0, 0.083, 0.5, 3.7, 1e4]) {
          const shape = make(0, wind(10, alpha));
          const d = sailPathData(shape, luffFlutter(shape, time));
          expect(d, `${alpha}° at ${time}s`).not.toMatch(/NaN|Infinity|e[+-]/i);
          for (const value of d.match(/-?\d+(\.\d+)?/g) ?? []) {
            expect(Number.isFinite(Number(value)), `${alpha}° at ${time}s`).toBe(true);
          }
        }
      }
    }
  });

  it("is deterministic, so an unchanged sail at an unchanged phase rewrites nothing", () => {
    const shape = shapeAtAlpha(4);
    expect(sailPathData(shape, luffFlutter(shape, 2.5))).toBe(
      sailPathData(shape, luffFlutter(shape, 2.5)),
    );
    expect(sailPathData(shape, luffFlutter(shape, 2.5))).not.toBe(
      sailPathData(shape, luffFlutter(shape, 2.6)),
    );
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

  /**
   * "Red" asked of the ramp's *hue* rather than of the exact end stop, because
   * some of these land a little above zero rather than on it. §4.4's stops run
   * 30° → 52° → … → 145°, so a hue below 35° is the bottom thirteenth of the
   * ramp — red by the ramp's own reckoning. Kept alongside the ratio bound so
   * the *colour* claim keeps being checked if the ramp is ever re-authored.
   */
  const isRed = (quality: number): boolean => trimQualityStop(quality).hue < 35;

  it("goes red oversheeted, with the cloth dead still", () => {
    // Oversheeted means hauled in *past* the optimum, and the boom on the
    // centreline is as far in as the sheet goes — anything beyond it is on the
    // other side of the boat and is a backed sail, not an overtrimmed one.
    // This is the case §4.2 exists for: the flow stays attached the whole way,
    // so without the ramp an oversheeted sail looks exactly like a good one.
    for (const awa of [40, 60, 90, 150]) {
      const apparent = wind(10, awa);
      expect(isRed(trimQuality(MAIN, 0, apparent))).toBe(true);
      expect(isRed(trimQuality(JIB, 0, apparent))).toBe(true);
      expect(collapsedFraction(angleOfAttack(0, apparent))).toBe(0);
    }

    // Dead downwind is the one place the cloth is *not* still, and the model is
    // right to insist on it: a boom hauled flat amidships on a run meets the
    // wind at its *leech* (α = 180°), and a real one slats. Red, and honestly
    // luffing — a statement about that trim, not about oversheeting.
    const run = wind(10, 180);
    expect(isRed(trimQuality(MAIN, 0, run))).toBe(true);
    expect(collapsedFraction(angleOfAttack(0, run))).toBe(1);
  });

  it("cannot be badly oversheeted close hauled, because the physics says so", () => {
    // The qualification §4.2 now carries, pinned rather than left implicit. The
    // best trim close hauled is already nearly on the centreline — 9.1° off it
    // at AWA 30°, and exactly on it at 20° — so there is barely any room to
    // sheet in past it, and hauling the boom all the way in reads amber rather
    // than red. Sheeted to the centreline, the quality first reaches amber at
    // AWA 28.2° and red at 35.0°: oversheeting is a reaching and running
    // mistake, which is where it is a mistake on the water too.
    expect(radiansToDegrees(mostDrivingTrim(MAIN, wind(10, 20)))).toBeCloseTo(0, 6);
    expect(trimQuality(MAIN, 0, wind(10, 20))).toBeCloseTo(1, 3);

    const closeHauled = trimQuality(MAIN, 0, wind(10, 30));
    expect(closeHauled).toBeGreaterThan(0.4);
    expect(isRed(closeHauled)).toBe(false);

    expect(isRed(trimQuality(MAIN, 0, wind(10, 34.9)))).toBe(false);
    expect(isRed(trimQuality(MAIN, 0, wind(10, 35.1)))).toBe(true);
  });

  it("goes red with a backed sail, which is a different mistake (§3.4)", () => {
    // Sheeted past the centreline onto the windward side. These read −0.51,
    // −0.37 and −0.15 — *negative*, which is the tell that separates them from
    // oversheeting: an oversheeted sail drives forward less, a backed one
    // drives the boat astern. Red for both reasons, and not luffing either.
    for (const [awa, trim] of [
      [30, 20],
      [45, 20],
      [60, 10],
    ] as const) {
      const apparent = wind(10, awa);
      const quality = trimQuality(MAIN, deg(trim), apparent);
      expect(deg(trim)).toBeGreaterThan(mostDrivingTrim(MAIN, apparent));
      expect(quality).toBeLessThan(0);
      expect(isRed(quality)).toBe(true);
      expect(collapsedFraction(angleOfAttack(deg(trim), apparent))).toBe(0);
    }
  });

  it("goes red undertrimmed too, and that one *is* fluttering", () => {
    // The other direction, and the pair is what keeps the two failure modes
    // distinguishable: both red, one shaking (§4.2).
    for (const awa of [30, 45, 60, 90]) {
      const apparent = wind(10, awa);
      const eased = deg(-awa); // α = 0 exactly: the sail lies along the flow.
      expect(trimQualityColor(trimQuality(MAIN, eased, apparent))).toBe(RED);
      expect(collapsedFraction(angleOfAttack(eased, apparent))).toBe(1);
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
