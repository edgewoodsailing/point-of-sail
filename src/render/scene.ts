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
 *    the mast dot, a sail's camber, a clew handle's visual radius.
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
import { jibClewPosition, mainClewPosition, STATIONS, SWING_LIMIT } from "../model/boat.ts";
import type { Meters, Radians, Vec2 } from "../model/units.ts";
import { magnitude, radiansToDegrees, subtract } from "../model/units.ts";
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
   * A reservation, not a clamp. The speed indicator is not directly
   * manipulable, so pos-qmk.3 may legitimately draw past this and let it pass
   * behind the ring; overlapping the ring costs nothing as long as it cannot
   * intercept a drag meant for it. That also leaves room for the indicator to
   * become a wake at the stern rather than an arrow off the bow (§4.3), which
   * the symmetric budget now supports either way.
   */
  contentRadius: 5.2,

  /** Centreline of the drawn wind ring (pos-qmk.3). */
  windRingRadius: 5.65,

  /** Half the span mapped across the surface's *shorter* dimension. */
  shortRadius: 6.0,
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
  /** World frame. The perimeter wind ring (pos-qmk.3). */
  readonly wind: SVGGElement;
  /** Boat frame, **below** the hull, so a stern arrow never paints over the boom. */
  readonly speed: SVGGElement;
  /** Boat frame, **above** the hull, so the boom reads as lying on the deck. */
  readonly sails: SVGGElement;
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
  /** How many metres a CSS pixel is worth right now — for pos-bwd's touch-target sizes. */
  pixelsToMeters(pixels: number): Meters;

  /** Stops observing the host. */
  destroy(): void;
}

/**
 * Builds the scene into `host` and returns the handle every other layer mounts
 * onto.
 *
 * Group order is document order is paint order, and it is deliberate: the speed
 * arrow sits below the hull so a stern arrow can never paint over the boom, and
 * the sails sit above it so the boom reads as lying on the deck.
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
    apparent: svgElement("g", { class: "pos-apparent" }),
  };

  boat.append(layers.speed, createHullLayer(), layers.sails);
  world.append(layers.wind, boat, layers.apparent);
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
