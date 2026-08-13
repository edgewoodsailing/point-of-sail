/**
 * The SVG root, the viewBox, and the coordinate story every other renderer
 * inherits (DESIGN.md §4.1, §4.5, §6).
 *
 * **The SVG user unit is the metre, and the origin is the mast.** The
 * world→user transform is the identity, so any `Vec2` the model produces —
 * `STATIONS.bow`, `mainClewPosition()`, a force vector for the apparent-wind
 * overlay — is drawing coordinates already, with no scale factor anywhere. That
 * is the whole story, and it is worth the small oddity of path data reading
 * `-2.1336`: a reviewer can recognise that as the 7 ft mast station, which is
 * not true of any abstract scene unit.
 *
 * It works because two things in §9 are settled: the boat frame and the world
 * frame share the mast as their origin, so they differ by a pure rotation and
 * one `<g transform="rotate(…)">` converts between them; and the boat never
 * translates, so that origin is fixed for the life of the page.
 *
 * Two rules follow, and everything downstream depends on them:
 *
 * 1. **A dimension *of the boat* is in metres** and scales with the drawing —
 *    the mast dot, a stay's deck fitting, a sail's camber, a telltale's length.
 * 2. **A *line weight* is in CSS pixels** and scales with the viewport, not
 *    with the drawing (§4.5). `vector-effect="non-scaling-stroke"` is what makes
 *    that possible inside a metre-valued viewBox; see `scene.css`.
 *
 * A note on §4.4's colour rule and its boundary: it bans *colour* presentation
 * attributes, because `oklch()` in one only parses in Safari. Geometry
 * attributes are not affected, and `transform` in particular should be the
 * attribute rather than the CSS property — the CSS property rotates about the
 * reference box's centre by default, not the user-space origin.
 */

import type { SimState } from "../model/simulation.ts";
import { HULL, jibClewPosition, mainClewPosition, STATIONS, SWING_LIMIT } from "../model/boat.ts";
import { WIND_SPEED_KT } from "../input/windSpeed.ts";
import type { Meters, MetersPerSecond, Radians, Vec2 } from "../model/units.ts";
import { knotsToMetersPerSecond, magnitude, radiansToDegrees, subtract } from "../model/units.ts";
import { createHullLayer, outlineRadius } from "./hull.ts";
import { formatNumber, svgElement } from "./svg.ts";
import "./scene.css";

// --- Extent -----------------------------------------------------------------

/** The clew arcs across their legal travel, measured from the pivot. */
function clewRadius(): Meters {
  const from = (point: Vec2): number => magnitude(subtract(point, STATIONS.pivot));
  let farthest = 0;
  const steps = 64;
  for (let i = 0; i <= steps; i += 1) {
    const angle = -SWING_LIMIT + (2 * SWING_LIMIT * i) / steps;
    farthest = Math.max(farthest, from(mainClewPosition(angle)), from(jibClewPosition(angle)));
  }
  return farthest;
}

/**
 * The clear water between the stem and the speed arrow's tail.
 *
 * An arrow welded to the stem reads as a bowsprit — part of the boat rather than
 * a thing said about it. Lives here rather than in `render/speed.ts` because the
 * ring's radius is now derived from it; see {@link ARROW_TAIL_RADIUS}.
 */
const BOW_GAP: Meters = 0.2;

/**
 * How far the speed arrow's *tail* stands from the pivot, ≈ 3.12 m.
 *
 * Because `STATIONS.pivot` is the midpoint of LOA the figure is the same astern,
 * so sternway gets exactly the room headway does.
 */
export const ARROW_TAIL_RADIUS: Meters =
  magnitude(subtract(STATIONS.bow, STATIONS.pivot)) + BOW_GAP;

/** The two speeds that between them fix the whole drawing's scale. */
const WIND_FULL_SCALE: MetersPerSecond = knotsToMetersPerSecond(WIND_SPEED_KT.max);
const BOAT_FULL_SCALE: MetersPerSecond = HULL.hullSpeed;

/**
 * PROTOTYPE — **the ring's radius is solved for, not chosen.**
 *
 * Both velocity arrows are drawn on one scale, and each has a natural maximum
 * that lands on something already in the drawing:
 *
 * - The **wind** arrow hangs its tail on the ring and flies inward. Its longest
 *   useful length is the one that puts the tip on the centre — further and the
 *   radial control's handle would have to pass through the origin, where a
 *   bearing stops existing. So full-scale wind draws `R`.
 * - The **speed** arrow starts at the bow and flies outward. Its longest useful
 *   length is the one that puts the tip on the ring. So hull speed draws
 *   `R − ARROW_TAIL_RADIUS`.
 *
 * One scale through both:
 *
 * ```text
 *   R / Vwind = (R − Rtail) / Vhull
 *   R = Rtail · Vwind / (Vwind − Vhull)
 * ```
 *
 * The ring is then whatever radius makes those two statements consistent, and
 * `shortRadius` follows it out to the viewport. The drawing zooms until the
 * proportion is satisfied, which is what turns the space the wind gave up — it
 * is an overlay now, not a reservation — into a bigger boat rather than more
 * water.
 *
 * Note the sign condition, which is not academic: the wind's full scale must
 * exceed the boat's, or `R` goes negative. It does, comfortably, and it is the
 * true statement about a keelboat — but it means the ring's radius is now
 * sensitive to hull speed and to §5's 20 kt ceiling in a way nothing was before.
 * Lower the ceiling toward hull speed and the ring runs away to infinity.
 */
const SOLVED_RING_RADIUS: Meters =
  (ARROW_TAIL_RADIUS * WIND_FULL_SCALE) / (WIND_FULL_SCALE - BOAT_FULL_SCALE);

/**
 * How much water is left outside the ring, as a fraction of it.
 *
 * A fraction rather than a length, so the margin is the same number of *pixels*
 * whatever the derivation above does to the radius — which is what it has to be,
 * since its whole job is to keep the graduations from being clipped by the
 * viewport edge. Matches what 0.35 m of 5.65 m bought before: 22 px on an iPad
 * and 11 px on a phone.
 */
const EDGE_FRACTION = 0.35 / 5.65;

/**
 * Concentric bands, as radii in metres from the mast. Everything but
 * `boatRadius` is a reservation this bead makes on behalf of later ones, so
 * that they inherit a budget instead of each inventing their own margin.
 */
export const SCENE = {
  /**
   * The disc the boat sweeps at *any* heading and any legal trim, ≈ 3.59 m,
   * measured from {@link STATIONS.pivot} rather than the mast. Measured, not
   * declared: the binding point is the jib clew at full ease, which swings out
   * abeam near the bow — further from the pivot than the transom corners.
   * Because the boat turns about the pivot, rotating the heading cannot change
   * this.
   */
  boatRadius: Math.max(outlineRadius(), clewRadius()),

  /**
   * How far the speed indicator can reach *without overlapping the wind ring*.
   * It leaves 2.28 m clear of the bow and, because the pivot is the midpoint of
   * LOA, exactly the same astern — so sternway is no longer the cramped case it
   * was when the boat turned about the mast.
   *
   * A reservation, not a clamp, and `render/speed.ts` took it up on exactly
   * that: the arrow's tip lands on this radius at hull speed, and above hull
   * speed it keeps growing and crosses the ring rather than pretending 5.6 kt
   * and 8 kt are the same length. Overlapping the ring costs nothing as long as
   * the arrow cannot intercept a drag meant for it — which is what
   * `pointer-events: none` on `.pos-speed` guarantees, not the paint order.
   */
  contentRadius: SOLVED_RING_RADIUS,

  /**
   * Centreline of the drawn wind ring — now {@link SOLVED_RING_RADIUS} rather
   * than the declared 5.65 m.
   *
   * `contentRadius` above is left pointing at the same number rather than
   * deleted, and it is worth saying why it is now redundant instead of quietly
   * leaving it at 5.2: it existed to reserve the band the speed arrow's tip
   * landed on at hull speed, and under the derivation that band *is* the ring.
   * The reservation and the mark it was reserving space for have become the
   * same circle, which is the whole of what this change buys.
   */
  windRingRadius: SOLVED_RING_RADIUS,

  /** Half the span mapped across the surface's *shorter* dimension. */
  shortRadius: SOLVED_RING_RADIUS * (1 + EDGE_FRACTION),
} as const;

/**
 * World metres across the surface's shorter dimension.
 *
 * Boat scale is pinned to the short axis, so the boat reads the same size on a
 * phone in portrait as on a desktop in landscape. The longer axis simply gains
 * world space — see {@link sceneExtent}.
 */
export const SHORT_SPAN: Meters = 2 * SCENE.shortRadius;

/** The world rectangle a surface of a given pixel size shows. */
export interface SceneExtent {
  readonly halfWidth: Meters;
  readonly halfHeight: Meters;
  /**
   * Metres per CSS pixel — **or exactly `0`** when the surface has no area yet
   * and there is therefore no scale to report. A real scale is always positive,
   * so zero is unambiguous as a sentinel, but it is a sentinel: dividing by it
   * yields `Infinity` and multiplying by it yields zero-sized everything.
   * Check it before doing either.
   *
   * At runtime, prefer `Scene.pixelsToMeters`, which measures the live screen
   * transform and so cannot be consulted before there is one.
   */
  readonly metersPerPixel: number;
}

/**
 * Maps a measured surface box onto the world rectangle it shows.
 *
 * The scale comes from the **shorter** side, so `SHORT_SPAN` metres always
 * exactly span it; the longer side then shows more world than it strictly
 * needs. That extra space is the point rather than waste: it is what lets the
 * wind ring sit out near the real edge of a tall phone instead of being
 * inscribed in the narrow dimension and stealing from the boat.
 *
 * A surface with no area yet — the first frame, before layout — falls back to a
 * square of `SHORT_SPAN`, so the viewBox is usable immediately and there is
 * never a frame painted without one. The ResizeObserver replaces it as soon as
 * the box is measured. Note that the fall-back reports `metersPerPixel: 0`,
 * because a scale onto zero pixels does not exist; see {@link SceneExtent}.
 */
export function sceneExtent(widthPx: number, heightPx: number): SceneExtent {
  const shortSide = Math.min(widthPx, heightPx);
  if (!(shortSide > 0)) {
    return {
      halfWidth: SCENE.shortRadius,
      halfHeight: SCENE.shortRadius,
      metersPerPixel: 0,
    };
  }
  const metersPerPixel = SHORT_SPAN / shortSide;
  return {
    halfWidth: (widthPx * metersPerPixel) / 2,
    halfHeight: (heightPx * metersPerPixel) / 2,
    metersPerPixel,
  };
}

/**
 * PROTOTYPE (pos-bwd.5) — **metres of drawing per metre per second, shared by
 * both velocity arrows.**
 *
 * The wind arrow and the speed arrow are both velocities, and until this
 * constant existed they were drawn on scales that differed by 30% *and* ran the
 * wrong way round: the boat's arrow was the longer per knot, so a 5 kt boat in a
 * 5 kt wind drew a longer arrow than the wind moving it. Three readouts, not one
 * picture.
 *
 * One number, read by both, so they cannot drift — pos-bwd.5's acceptance
 * criterion in as many words: *one exported scale constant, not two
 * coincidentally-equal numbers.*
 *
 * **Full scale is the top of §5's wind range**, because that is the whole of the
 * wind a student is ever taught in, and pinning it there keeps the composition
 * true at every wind they can set. A knee or a clamp inside the range would make
 * the triangle a lie exactly where the breeze gets interesting. It works out at
 * **0.2174 m per knot**, measured. (An earlier draft of this docblock said
 * 0.2825, which was the figure while `windRingRadius` was still the declared
 * 5.65 m; solving the radius moved it and the number here did not follow. It is
 * `windRingRadius / 20 kt` by construction, so it is derived rather than quoted
 * — but a stale figure in prose is exactly as misleading as one in code.)
 *
 * Where this constant should *live* is a real question this prototype ducks: it
 * is stated here because both renderers already import the scene, and it reaches
 * into `input/windSpeed.ts` for the range, which is the wrong direction across
 * §6's layering. The range is arguably not an input concern at all.
 */
export const VELOCITY_SCALE: number =
  SCENE.windRingRadius / knotsToMetersPerSecond(WIND_SPEED_KT.max);

/** The `viewBox` attribute for an extent: origin centred, so the mast is mid-screen. */
export function viewBoxAttribute(extent: SceneExtent): string {
  return [
    formatNumber(-extent.halfWidth),
    formatNumber(-extent.halfHeight),
    formatNumber(2 * extent.halfWidth),
    formatNumber(2 * extent.halfHeight),
  ].join(" ");
}

// --- Heading ----------------------------------------------------------------

/**
 * The transform that carries boat-frame geometry into the world frame:
 * `world = rotate(heading) · (boat − pivot)`.
 *
 * Read right to left, as SVG applies it. The translate slides the boat frame so
 * that {@link STATIONS.pivot} — not the mast — lands on the scene origin; the
 * rotate then turns about that origin. So the boat turns about a point near its
 * keel, the way a keelboat does, while the model goes on measuring its rig from
 * the mast. Those are two different questions and this is where they meet.
 *
 * SVG's `rotate(a)` about the origin is `x' = x·cos a − y·sin a`,
 * `y' = x·sin a + y·cos a` — character for character `units.rotateVector`. It
 * turns visually clockwise because the axis is y-down, which is exactly §2's
 * convention, so there is no sign flip here and, usefully, no trigonometry
 * either: SVG does it, and `no-raw-trig.test.ts` stays satisfied for free.
 *
 * Heading 0 puts the bow screen-up; heading 90° puts it screen-right.
 */
export function boatTransform(heading: Radians): string {
  const rotate = `rotate(${formatNumber(radiansToDegrees(heading))})`;
  const translate = `translate(${formatNumber(-STATIONS.pivot.x)} ${formatNumber(-STATIONS.pivot.y)})`;
  return `${rotate} ${translate}`;
}

// --- The scene --------------------------------------------------------------

/**
 * A drawn layer. `update` is omitted by layers that do not read state — the
 * hull is the whole boat's worth of geometry that never changes.
 */
export interface Layer {
  readonly element: SVGElement;
  update?(state: SimState): void;
}

/**
 * Where each later bead hangs its drawing. One named group per layer, created
 * and ordered by the scene, so paint order is a property of this module rather
 * than of the order beads happen to land in.
 *
 * The scene deliberately does **not** expose the world or boat groups
 * themselves. Appending to those would put the new layer last, which is exactly
 * the mistake the ordering exists to prevent: a speed arrow appended after the
 * hull paints over the boom on sternway.
 */
export interface SceneLayers {
  /**
   * World frame, and **above** the boat group. The perimeter wind ring.
   *
   * Painting it last costs nothing — the ring sits at 5.65 m and the boat sweeps
   * 3.59 m, so the two cannot overlap — and it buys the one case that does
   * overlap: above hull speed the speed arrow runs past `contentRadius` and
   * crosses the ring, and it should pass behind rather than through it.
   *
   * That is the aesthetic half. The structural half is `pointer-events: none` on
   * `.pos-speed` in `scene.css`, so the overrunning arrow cannot intercept a
   * drag meant for the ring. Do not mistake the ordering for the guard — and
   * note that the guard is belt to the braces of `input/gestures.ts` arbitrating
   * geometrically rather than by event target, which is what actually decides
   * the case today.
   */
  readonly wind: SVGGElement;
  /**
   * Boat frame, **below** the hull, so a stern arrow never paints over the boom
   * and the arrow emerges from the stem rather than lying across the deck.
   */
  readonly speed: SVGGElement;
  /** Boat frame, **above** the hull, so the boom reads as lying on the deck. */
  readonly sails: SVGGElement;
  /**
   * Boat frame, above the cloth. The rigging telltale (pos-32n).
   *
   * **It no longer holds clew fittings, and that is a decision rather than a
   * deletion.** §5 argued for a small ring at each clew so the grab points would
   * announce themselves without a label. In the running drawing it did the
   * opposite: the ring is sized as *hardware*, in metres, while the target is
   * sized as a *touch*, in pixels, and the two are nowhere near each other — on
   * a phone the invisible disc is several times the visible ring. So the mark
   * advertised an affordance at a size the geometry never honoured, which is a
   * worse failure than no advertisement at all. The corner of a sail marks its
   * own clew.
   *
   * What is left here is above the cloth for the same reason the fittings were:
   * a sail may be eased across it, and this is the one mark on the boat that
   * reports the wind the sails are answering.
   *
   * It is transparent to the pointer (`scene.css`), which costs nothing and
   * says the true thing: hit-testing is geometric (`input/gestures.ts`) and
   * never reads an event's target, so no drawn mark is ever a target.
   */
  readonly handles: SVGGElement;
  /** World frame, on top. The apparent-wind overlay (§3.1). */
  readonly apparent: SVGGElement;
}

export interface Scene {
  /**
   * The `<svg>` root. Note that **pointer listeners belong on the host
   * element, not here**: an `<svg>` with no painted background receives events
   * only over painted geometry, whereas the host is an HTML element and
   * receives them over its whole box. The host already carries
   * `touch-action: none` (§6.2).
   */
  readonly element: SVGSVGElement;
  /** Mount points, already in paint order. Append to the one your layer belongs to. */
  readonly layers: SceneLayers;

  render(state: SimState): void;

  /**
   * Screen (`clientX`/`clientY`) to world metres — the inverse of everything
   * above. The world origin is the boat's **pivot**, so getting from here to
   * the boat frame, whose origin is the mast, is
   * `add(rotateVector(p, -heading), STATIONS.pivot)`. Left to the caller
   * deliberately: that is model arithmetic, testable in node, and reading it
   * off the boat group's CTM instead would bury it in the DOM.
   */
  toWorld(clientX: number, clientY: number): Vec2;
  /** How many metres a CSS pixel is worth right now — for §5's touch-target sizes. */
  pixelsToMeters(pixels: number): Meters;

  /** Stops observing the host. */
  destroy(): void;
}

/**
 * Builds the scene into `host` and returns the handle every other layer mounts
 * onto.
 *
 * Group order is document order is paint order, and it is deliberate: the speed
 * arrow sits below the hull so a stern arrow can never paint over the boom, the
 * sails sit above it so the boom reads as lying on the deck, the clew fittings
 * sit above the cloth so an eased sail cannot bury its own grab point, and the
 * wind ring sits above the whole boat so the speed arrow passes behind it when
 * it overruns `contentRadius`. See {@link SceneLayers}.
 */
export function createScene(host: HTMLElement): Scene {
  const element = svgElement("svg", { class: "pos-scene" });
  const title = svgElement("title");
  title.textContent = "Top-down view of a sailboat";

  const world = svgElement("g", { class: "pos-world" });
  const boat = svgElement("g", { class: "pos-boat" });
  const layers: SceneLayers = {
    wind: svgElement("g", { class: "pos-wind" }),
    speed: svgElement("g", { class: "pos-speed" }),
    sails: svgElement("g", { class: "pos-sails" }),
    handles: svgElement("g", { class: "pos-handles" }),
    apparent: svgElement("g", { class: "pos-apparent" }),
  };

  boat.append(layers.speed, createHullLayer(), layers.sails, layers.handles);
  world.append(boat, layers.wind, layers.apparent);
  element.append(title, world);
  host.append(element);

  function applyExtent(widthPx: number, heightPx: number): void {
    element.setAttribute("viewBox", viewBoxAttribute(sceneExtent(widthPx, heightPx)));
  }

  applyExtent(host.clientWidth, host.clientHeight);

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      applyExtent(entry.contentRect.width, entry.contentRect.height);
    }
  });
  observer.observe(host);

  /**
   * Measured on the world group rather than the root, so any transform later
   * applied to it comes along for free. `getScreenCTM` folds in the viewBox
   * scale, the element's page position, scroll, and any ancestor CSS transform
   * — which is why none of that is computed by hand anywhere in `render/` or
   * `input/`.
   */
  function screenMatrix(): DOMMatrix {
    const matrix = world.getScreenCTM();
    if (matrix === null) {
      throw new Error("Scene is not in the document, so it has no screen transform.");
    }
    return matrix;
  }

  return {
    element,
    layers,
    render(state: SimState): void {
      boat.setAttribute("transform", boatTransform(state.motion.heading));
    },
    toWorld(clientX: number, clientY: number): Vec2 {
      const point = new DOMPoint(clientX, clientY).matrixTransform(screenMatrix().inverse());
      return { x: point.x, y: point.y };
    },
    pixelsToMeters(pixels: number): Meters {
      // The length of the matrix's x basis vector, not `a` alone. Under a pure
      // scale they are the same, and `a` reads more simply — but `screenMatrix`
      // above deliberately folds in any transform on the world group or on an
      // ancestor, and under a rotation `a` is s·cos θ: 41% high at 45°, and
      // infinite at 90°. Taking the vector's length is right for any of them.
      const matrix = screenMatrix();
      return pixels / Math.hypot(matrix.a, matrix.b);
    },
    destroy(): void {
      observer.disconnect();
      element.remove();
    },
  };
}
