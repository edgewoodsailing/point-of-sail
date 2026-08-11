/**
 * The hull outline, the mast and the forestay — the part of the drawing that
 * never changes shape (DESIGN.md §4.1).
 *
 * Everything here is in **boat-frame metres**: the same `Vec2` axes the model
 * uses, with the origin at the mast. `render/scene.ts` explains why the drawing
 * needs no conversion; this module is the first thing that benefits from it,
 * since every dimension below is read straight out of `model/boat.ts` rather
 * than typed in.
 *
 * The outline is exposed as *data* — control points, not a `d` string — so that
 * `hull.test.ts` can measure the boat instead of matching text. That is what
 * makes "does it still look like a Rhodes 19" a table of numbers.
 */

import { HULL, STATIONS } from "../model/boat.ts";
import type { Meters, Vec2 } from "../model/units.ts";
import { magnitude } from "../model/units.ts";
import { formatNumber, svgElement } from "./svg.ts";

// --- Fairing: the drawing's taste, isolated ---------------------------------
//
// The four dimensions above are measurements of the boat and come from
// boat.ts. The fractions below are how the curve is faired between them, which
// is a drawing decision — the hull is "deliberately abstract" (§4.1). They stay
// local rather than going to `model/tuning.ts`: that file's job is to separate
// physics from taste *in the model*, and a Bézier handle is neither.

/** Where the boat is widest, as a fraction of LOA aft of the bow. */
const MAX_BEAM_STATION = 0.52;
/** Transom half-width, as a fraction of the half beam. */
const TRANSOM_FRACTION = 0.48;
/**
 * Bow handle: how far it flares (× half beam) and how far aft it reaches
 * (× the bow run).
 *
 * These two are the shape's most sensitive pair, because between them they set
 * the angle of the stem — `atan(FLARE · halfBeam / (REACH · bowRun))`, doubled
 * across the centreline. A long reach with a small flare draws a needle rather
 * than a boat, and it does so without violating any of the constraints the
 * tests check. The station table in `hull.test.ts` is what catches it.
 */
const BOW_FLARE = 0.5;
const BOW_REACH = 0.28;
/** How far forward of the widest point its forward handle sits (× the bow run). */
const BEAM_ENTRY = 0.45;
/** How far aft of the widest point its after handle sits (× the run aft). */
const BEAM_EXIT = 0.55;
/** Quarter handle: how far inboard (× beam − transom) and forward of the transom (× the run aft). */
const QUARTER_INBOARD = 0.35;
const QUARTER_LIFT = 0.1;

/** Mast dot radius. A dimension of the boat, so it is in metres and scales with the drawing. */
const MAST_RADIUS: Meters = 0.11;

// --- The outline ------------------------------------------------------------

/** One cubic Bézier: two handles and an end point. The start is the previous end. */
export interface CubicSegment {
  readonly control1: Vec2;
  readonly control2: Vec2;
  readonly end: Vec2;
}

/**
 * The starboard half of the hull, bow to transom. The port half is never
 * written down — {@link hullPathData} mirrors this one — so the boat cannot
 * drift out of symmetry.
 */
export interface HullOutline {
  /** The stem head. Also the forward extreme of the boat. */
  readonly bow: Vec2;
  /** Bow → widest point, then widest point → starboard transom corner. */
  readonly starboard: readonly [CubicSegment, CubicSegment];
  /** The widest point, exposed because tests and the scene both want it. */
  readonly maxBeam: Vec2;
  /** The starboard transom corner. The transom itself is the straight line across. */
  readonly transomCorner: Vec2;
}

function buildOutline(): HullOutline {
  const halfBeam = HULL.beam / 2;
  const bow = STATIONS.bow;
  const sternY = STATIONS.stern.y;

  const maxBeam: Vec2 = { x: halfBeam, y: bow.y + MAX_BEAM_STATION * HULL.loa };
  const transomCorner: Vec2 = { x: TRANSOM_FRACTION * halfBeam, y: sternY };

  /** Bow to the widest point… */
  const bowRun = maxBeam.y - bow.y;
  /** …and the widest point to the transom. */
  const runAft = sternY - maxBeam.y;

  return {
    bow,
    maxBeam,
    transomCorner,
    starboard: [
      {
        control1: { x: BOW_FLARE * halfBeam, y: bow.y + BOW_REACH * bowRun },
        // x = halfBeam here and at the start of the next segment, so the tangent
        // at the widest point is exactly fore-and-aft. That is what makes the
        // maximum beam exactly HULL.beam rather than approximately it.
        control2: { x: halfBeam, y: maxBeam.y - BEAM_ENTRY * bowRun },
        end: maxBeam,
      },
      {
        control1: { x: halfBeam, y: maxBeam.y + BEAM_EXIT * runAft },
        // Forward of the transom, so the topside meets it at a real corner
        // rather than tangentially. Transoms have corners.
        control2: {
          x: transomCorner.x + QUARTER_INBOARD * (halfBeam - transomCorner.x),
          y: sternY - QUARTER_LIFT * runAft,
        },
        end: transomCorner,
      },
    ],
  };
}

/** The outline, computed once. Pure data — no DOM, no state. */
export const HULL_OUTLINE: HullOutline = buildOutline();

/** The same point with its x negated: starboard → port. */
function mirror(v: Vec2): Vec2 {
  return { x: -v.x, y: v.y };
}

/** A segment traversed in reverse, mirrored to port. Handles swap with it. */
function mirroredReverse(segment: CubicSegment, start: Vec2): CubicSegment {
  return {
    control1: mirror(segment.control2),
    control2: mirror(segment.control1),
    end: mirror(start),
  };
}

function cubicTo({ control1, control2, end }: CubicSegment): string {
  return (
    `C ${formatNumber(control1.x)} ${formatNumber(control1.y)}` +
    ` ${formatNumber(control2.x)} ${formatNumber(control2.y)}` +
    ` ${formatNumber(end.x)} ${formatNumber(end.y)}`
  );
}

/**
 * The closed hull outline as SVG path data, in metres.
 *
 * Runs bow → starboard side → starboard transom corner → straight across the
 * transom → port side → back to the bow.
 */
export function hullPathData(outline: HullOutline = HULL_OUTLINE): string {
  const [forward, aft] = outline.starboard;
  return [
    `M ${formatNumber(outline.bow.x)} ${formatNumber(outline.bow.y)}`,
    cubicTo(forward),
    cubicTo(aft),
    `L ${formatNumber(-outline.transomCorner.x)} ${formatNumber(outline.transomCorner.y)}`,
    cubicTo(mirroredReverse(aft, outline.maxBeam)),
    cubicTo(mirroredReverse(forward, outline.bow)),
    "Z",
  ].join(" ");
}

// --- Extent -----------------------------------------------------------------

/** A point on a cubic Bézier. Linear algebra only — no trigonometry to hide here. */
export function cubicPoint(start: Vec2, segment: CubicSegment, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * start.x + b * segment.control1.x + c * segment.control2.x + d * segment.end.x,
    y: a * start.y + b * segment.control1.y + c * segment.control2.y + d * segment.end.y,
  };
}

/** Sample count per segment. Fine enough that the sampled maximum is exact to ~1 mm. */
const EXTENT_SAMPLES = 512;

/**
 * The farthest any point of the outline lies from the mast.
 *
 * This is what the scene's extent is built on, and the reason it is *measured*
 * rather than declared: the maximum is at the transom corners (≈ 3.74 m), which
 * is neither the stern station nor anything else `boat.ts` names. Refairing the
 * hull moves it, and deriving it here means the scene follows along instead of
 * quietly letting the boat grow into the wind ring.
 */
export function outlineRadius(outline: HullOutline = HULL_OUTLINE): Meters {
  let farthest = Math.max(magnitude(outline.bow), magnitude(outline.transomCorner));
  let start = outline.bow;
  for (const segment of outline.starboard) {
    for (let i = 1; i <= EXTENT_SAMPLES; i += 1) {
      farthest = Math.max(farthest, magnitude(cubicPoint(start, segment, i / EXTENT_SAMPLES)));
    }
    start = segment.end;
  }
  // The port half is the mirror image, so its distances are identical.
  return farthest;
}

// --- The drawn layer --------------------------------------------------------

/**
 * The hull, the mast and the forestay, as one static group.
 *
 * It has no update function, and that is the "forestay stays visible when the
 * jib is struck" requirement (§4.1) expressed structurally: there is no
 * conditional here for anyone to later get wrong. The boat reads as a sloop
 * with its jib down because the forestay is simply always drawn.
 */
export function createHullLayer(): SVGGElement {
  const group = svgElement("g", { class: "pos-hull" });

  group.append(
    svgElement("path", {
      class: "pos-hull-outline",
      d: hullPathData(),
      "vector-effect": "non-scaling-stroke",
    }),
    svgElement("line", {
      class: "pos-forestay",
      x1: STATIONS.mast.x,
      y1: STATIONS.mast.y,
      x2: STATIONS.forestay.x,
      y2: STATIONS.forestay.y,
      "vector-effect": "non-scaling-stroke",
    }),
    svgElement("circle", {
      class: "pos-mast",
      cx: STATIONS.mast.x,
      cy: STATIONS.mast.y,
      r: MAST_RADIUS,
    }),
  );

  return group;
}
