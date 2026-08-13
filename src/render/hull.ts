/**
 * The hull outline and the mast — the part of the drawing that never changes
 * shape (DESIGN.md §4.1).
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

import { CHAINPLATES, HULL, STATIONS } from "../model/boat.ts";
import type { Meters, Vec2 } from "../model/units.ts";
import { feetToMeters, magnitude, subtract } from "../model/units.ts";
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

/**
 * One cubic segment as a `C` command. Exported because `sail.ts` emits the same
 * curve type; if a third caller appears, this and {@link cubicPoint} are what
 * would move to a shared `render/path.ts`.
 */
export function cubicTo({ control1, control2, end }: CubicSegment): string {
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
 * The farthest any point of the outline lies from `about` — by default the
 * pivot, since what the scene needs is the disc the hull sweeps as it turns.
 *
 * The reason this is *measured* rather than declared: the maximum sits at the
 * transom corners, which is neither the stern station nor anything else
 * `boat.ts` names, and it stays there only by a couple of centimetres once the
 * pivot moves to mid-length. Refairing the hull moves it, and deriving it here
 * means the scene follows along instead of quietly letting the boat grow into
 * the wind ring.
 *
 * `about` must lie on the centreline; the port half is taken as the mirror
 * image rather than swept, which is only sound for a centred pivot.
 */
export function outlineRadius(
  outline: HullOutline = HULL_OUTLINE,
  about: Vec2 = STATIONS.pivot,
): Meters {
  const from = (point: Vec2): number => magnitude(subtract(point, about));
  let farthest = Math.max(from(outline.bow), from(outline.transomCorner));
  let start = outline.bow;
  for (const segment of outline.starboard) {
    for (let i = 1; i <= EXTENT_SAMPLES; i += 1) {
      farthest = Math.max(farthest, from(cubicPoint(start, segment, i / EXTENT_SAMPLES)));
    }
    start = segment.end;
  }
  return farthest;
}

// --- Standing rigging -------------------------------------------------------

/**
 * How far inboard of its true position each deck fitting is drawn, 6 inches.
 *
 * The same inset the jib's tack already carries — it sits half a foot aft of the
 * stem — which is what lets the headstay's dot and the jib's tack be the *same
 * point* rather than two marks a few pixels apart arguing about which is right.
 *
 * Drawing them inboard is an honest simplification rather than a fudge. This is
 * a top-down drawing of a three-dimensional boat, and a chainplate is a fitting
 * on a near-vertical topside: there is no single deck coordinate that is the
 * truth. Pulling them in clears the sheer line, so a dot reads as a fitting on
 * the deck rather than as a lump in the hull's outline.
 */
const DECK_INSET: Meters = feetToMeters(0.5);

/** Samples per segment when the sheer is inverted to find beam at a station. */
const SHEER_SAMPLES = 512;

/**
 * The half-beam of the drawn sheer at a given boat-frame *y*, in metres.
 *
 * Measured off the same outline the hull is drawn from, so a dot placed with it
 * cannot drift off the curve when the hull is refaired. The outline runs bow to
 * transom with *y* strictly increasing — every control point's *y* lies between
 * its segment's endpoints — so a dense sample plus a linear step between
 * neighbours inverts it without needing to solve the cubic.
 *
 * Outside the hull's fore-and-aft extent it clamps to the nearest end, which is
 * the useful answer for a caller asking about the stem or the transom.
 */
export function sheerHalfBeamAt(y: Meters, outline: HullOutline = HULL_OUTLINE): Meters {
  let previous = outline.bow;
  if (y <= previous.y) return previous.x;

  let start = outline.bow;
  for (const segment of outline.starboard) {
    for (let i = 1; i <= SHEER_SAMPLES; i += 1) {
      const point = cubicPoint(start, segment, i / SHEER_SAMPLES);
      if (point.y >= y) {
        const span = point.y - previous.y;
        // A degenerate step means two samples share a y; either x will do.
        if (!(span > 0)) return point.x;
        const t = (y - previous.y) / span;
        return previous.x + t * (point.x - previous.x);
      }
      previous = point;
    }
    start = segment.end;
  }
  return outline.transomCorner.x;
}

/** One of the boat's six stays, and where it lands on deck. */
export interface StayStation {
  readonly name: string;
  readonly at: Vec2;
  /**
   * Whether the school ties yarn to it: the two uppers and the backstay, and
   * not the headstay or the lowers.
   *
   * A property of the station rather than a list kept somewhere else, because
   * the alternative is `render/telltale.ts` matching on names — which works
   * until someone renames one and the telltale quietly stops being drawn.
   */
  readonly carriesTelltale: boolean;
}

/**
 * Where all six stays land, drawn {@link DECK_INSET} inboard of the truth
 * (§4.1, pos-aax).
 *
 * `RB 17.00`: one pair of uppers, one pair of lowers, single spreaders, one
 * headstay, one backstay. The two centreline stays are inset *fore and aft* and
 * the four shrouds *athwartships*, which is the same 6 inches applied along
 * whichever axis the fitting is near an edge on.
 *
 * The headstay's station is `STATIONS.jibTack` itself rather than a separately
 * computed point half a foot aft of the stem. They are the same number and
 * saying so once means the jib's tack sits *on* its dot however either moves.
 */
export function stayStations(): readonly StayStation[] {
  const shroud = (name: string, y: Meters, side: number, carriesTelltale: boolean): StayStation => ({
    name,
    at: { x: side * (sheerHalfBeamAt(y) - DECK_INSET), y },
    carriesTelltale,
  });

  return [
    { name: "headstay", at: STATIONS.jibTack, carriesTelltale: false },
    shroud("starboard upper", CHAINPLATES.upper, 1, true),
    shroud("port upper", CHAINPLATES.upper, -1, true),
    shroud("starboard lower", CHAINPLATES.lower, 1, false),
    shroud("port lower", CHAINPLATES.lower, -1, false),
    { name: "backstay", at: { x: 0, y: STATIONS.stern.y - DECK_INSET }, carriesTelltale: true },
  ];
}

/**
 * A deck fitting's drawn radius: 0.023 m, about a fifth of the mast dot's 0.11.
 *
 * The first attempt was 0.07 m in a lightened ink and it read as *dirt* — big
 * enough to be a shape rather than a point, pale enough to look unresolved. The
 * fix runs both dials the other way at once, and they are the same decision
 * rather than two: a chainplate is a place where a wire lands, so it wants to be
 * nearly dimensionless, and **being small is exactly what lets it take the
 * hull's ink at full strength** without competing with the mast. A faint mark
 * reads as a mistake; a tiny sharp one reads as a fitting.
 *
 * So the ranking against the mast is now carried by size alone, with no
 * difference in weight to help — which is the honest way round, since they are
 * the same kind of thing and differ only in importance.
 *
 * A dimension *of the boat*, so it is in metres and shrinks with the drawing
 * (§4.1): about 3.8 px across on an iPad and 2 px on a phone. The phone is thin
 * enough to be worth an eye on real glass rather than a screenshot — pos-740.4.
 */
const STAY_RADIUS: Meters = 0.07 / 3;

// --- The drawn layer --------------------------------------------------------

/**
 * The hull and the mast, as one static group. It has no update function
 * because nothing about it moves — the heading rotation lives on the parent.
 *
 * **The standing rigging is drawn as six deck dots** (§4.1, pos-aax), which is
 * the option that bead left open. Not as spans: the boat has six stays, drawing
 * only one misrepresents the rig, and a stay's horizontal reach is not something
 * anyone thinks about while sailing — this is a roughly deck-level drawing and a
 * stay is very nearly vertical. Where each one *lands* is the part a deck-level
 * drawing can honestly show, and it earns its place twice over: the lowers are
 * what the boom fetches up on, so `SWING_LIMIT` stops being merely enforced and
 * becomes visible, and the uppers and backstay are where pos-32n's telltales
 * would be tied.
 */
export function createHullLayer(): SVGGElement {
  const group = svgElement("g", { class: "pos-hull" });

  group.append(
    svgElement("path", {
      class: "pos-hull-outline",
      d: hullPathData(),
      "vector-effect": "non-scaling-stroke",
    }),
  );

  for (const stay of stayStations()) {
    group.append(
      svgElement("circle", {
        class: "pos-stay",
        cx: stay.at.x,
        cy: stay.at.y,
        r: STAY_RADIUS,
      }),
    );
  }

  // After the stays, so the mast reads on top where the forward chainplates
  // come close to it — they land an inch forward of the mast station.
  group.append(
    svgElement("circle", {
      class: "pos-mast",
      cx: STATIONS.mast.x,
      cy: STATIONS.mast.y,
      r: MAST_RADIUS,
    }),
  );

  return group;
}
