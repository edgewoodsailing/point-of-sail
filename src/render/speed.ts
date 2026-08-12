/**
 * The speed arrow: how fast the boat is going, and which way (DESIGN.md §4.1,
 * §4.3).
 *
 * Boat-frame metres, like `render/hull.ts` and `render/sail.ts` — the arrow
 * mounts on `scene.layers.speed`, which rides inside the boat group, so the
 * heading rotation is somebody else's problem and there is no rotation
 * arithmetic here at all. It projects off the bow, or off the stern when speed
 * is negative, which is the whole of §3.4's sternway made visible.
 *
 * ## The length law
 *
 * Linear in speed, and **not clamped**:
 *
 * ```text
 * length = SPEED_REACH · |speed| / SPEED_FULL_SCALE
 * ```
 *
 * `SPEED_REACH` is derived rather than declared — it is what is left of
 * `SCENE.contentRadius` once the bow and the gap between hull and arrow are
 * accounted for, which is the same figure astern because the pivot is the
 * midpoint of LOA. `SPEED_FULL_SCALE` is hull speed. So the tip lands *exactly*
 * on `contentRadius` at hull speed, which is what that band was reserved for.
 *
 * Above hull speed the arrow keeps growing and crosses the wind ring. That is
 * deliberate, and §4.1 says so in as many words: `contentRadius` is a
 * reservation, not a clamp. Clamping would make 5.6 kt and 8 kt draw
 * identically — the drawing would stop reporting speed at exactly the point
 * where the boat is being driven hardest — and crossing the ring is a legible
 * thing in its own right: she is past hull speed. `scene.ts` paints the ring
 * above the boat so the overrun passes behind it, and `scene.css` gives
 * `.pos-speed` `pointer-events: none` so it can never intercept a drag pos-bwd.2
 * means for the ring.
 *
 * At the fastest the model produces — about 8 kt, which wants 30 kt of wind on a
 * reach — the tip reaches 6.07 m, just past the short-axis edge. It is only
 * clipped there when it also points athwartships, and the long axis has room to
 * spare. Worth knowing about; not worth a clamp.
 *
 * ## Colour is not set here
 *
 * pos-dmg.3 colours this arrow against a ghost boat's optimal-trim speed. It
 * will do that by adding the twin of `setSailInk` to `render/palette.ts` and
 * setting `--pos-speed-ink` on this layer's group — `scene.css` already reads
 * `stroke: var(--pos-speed-ink, var(--pos-ink))`, so this bead ships in plain
 * ink and pos-dmg.3 needs no change here or in the CSS. `palette.ts` stays the
 * only module in `render/` that hands a colour to the DOM (§4.4).
 */

import { HULL, STATIONS } from "../model/boat.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, MetersPerSecond, Radians, Vec2 } from "../model/units.ts";
import { add, degreesToRadians, magnitude, subtract, vectorFromAngle } from "../model/units.ts";
import { SCENE, type Layer } from "./scene.ts";
import { formatNumber, svgElement } from "./svg.ts";

// --- The scale --------------------------------------------------------------

/**
 * Clear water between the boat and the arrow.
 *
 * An arrow welded to the stem reads as a bowsprit — part of the boat rather than
 * a thing said about it — and the layer paints below the hull, so at the stern
 * it would appear to slide out from under the transom. A gap says the arrow is
 * an annotation.
 *
 * In metres, so it scales with the boat, while the stroke it has to out-read is
 * in CSS pixels and scales with the viewport (§4.5). Those sound like they would
 * drift apart and do not: both are pinned to the viewport's short side, so this
 * holds at a steady ~3.5 stroke widths from a 390 px phone to a desktop.
 */
const HULL_GAP: Meters = 0.2;

/**
 * How long the arrow is at hull speed: what is left of `SCENE.contentRadius`
 * once the bow and the gap are accounted for, ≈ 2.08 m.
 *
 * Measured rather than declared, the way `SCENE.boatRadius` is. Refair the hull
 * or move the mast station and this follows, instead of quietly disagreeing with
 * the band it is supposed to fill. Because `STATIONS.pivot` is the midpoint of
 * LOA, the same figure is available astern, so sternway gets exactly the room
 * headway does — `scene.test.ts` pins that symmetry from the other side.
 *
 * Note which end the gap is taken out of: the *arrow's*, not the band's. The
 * clear water is a drawing decision and the band is a budget, so the gap comes
 * out of what the arrow may spend rather than being added on top of it — which
 * is what keeps the tip landing exactly on `contentRadius` at hull speed.
 */
export const SPEED_REACH: Meters =
  SCENE.contentRadius - magnitude(subtract(STATIONS.bow, STATIONS.pivot)) - HULL_GAP;

/**
 * The speed at which the arrow is exactly `SPEED_REACH` long.
 *
 * Hull speed rather than a number chosen to look right: it is already the
 * boat's own scale — `model/hull.ts` builds its resistance wall around it — and
 * it is the speed a student is trying to reach. That makes a full-length arrow
 * mean something rather than merely being the biggest one.
 */
export const SPEED_FULL_SCALE: MetersPerSecond = HULL.hullSpeed;

/**
 * Below this drawn length there is no arrow at all.
 *
 * At 0.05 m — about 0.14 kt — the shape is smaller than its own stroke is wide.
 * Drawing it anyway would leave a dot off the stem in a flat calm, because the
 * stroke is round-capped, and a mark that never goes away stops reading as
 * "moving". A boat this slow is not under way.
 */
const MIN_LENGTH: Meters = 0.05;

/** Barb length at any arrow long enough to carry one, and its splay from the tip. */
const ARROW_BARB: Meters = 0.4;
const ARROW_SPREAD: Radians = degreesToRadians(28);

/** Set on the group when the boat is not under way; `scene.css` hides it. */
const STOPPED_CLASS = "pos-stopped";

// --- Geometry ---------------------------------------------------------------

/** How long the arrow is, for a signed speed. Unsigned: the sign is a direction. */
export function speedArrowLength(speed: MetersPerSecond): Meters {
  return (SPEED_REACH * Math.abs(speed)) / SPEED_FULL_SCALE;
}

/** Whether there is enough way on to draw an arrow at all. */
export function underWay(speed: MetersPerSecond): boolean {
  return speedArrowLength(speed) >= MIN_LENGTH;
}

/** `x y`, the way path data wants a point. */
function point(v: Vec2): string {
  return `${formatNumber(v.x)} ${formatNumber(v.y)}`;
}

/**
 * The arrow, starting `HULL_GAP` clear of the bow and running forward, or clear
 * of the stern and running aft.
 *
 * The head shrinks with the shaft below ~2.2 kt — `min(ARROW_BARB, length / 2)`
 * — so a slow boat draws a small arrow rather than a barb with a tail poking out
 * of the wrong end of it.
 */
export function speedArrowPathData(speed: MetersPerSecond): string {
  const astern = speed < 0;
  const station = astern ? STATIONS.stern : STATIONS.bow;
  // Bearings, so the sign never has to be threaded through the gap or the barbs
  // by hand: 0 is screen-up, which at heading zero is dead ahead.
  const travel: Radians = astern ? Math.PI : 0;

  const length = speedArrowLength(speed);
  const tail = add(station, vectorFromAngle(travel, HULL_GAP));
  const tip = add(tail, vectorFromAngle(travel, length));
  const barbLength = Math.min(ARROW_BARB, length / 2);
  const barb = (sign: number): Vec2 =>
    add(tip, vectorFromAngle(travel + Math.PI + sign * ARROW_SPREAD, barbLength));

  return [
    `M ${point(tail)} L ${point(tip)}`,
    `M ${point(barb(-1))} L ${point(tip)} L ${point(barb(1))}`,
  ].join(" ");
}

// --- The drawn layer --------------------------------------------------------

/**
 * The arrow, as a layer for `main.ts` to mount on `scene.layers.speed`.
 *
 * The path sits inside a group it does not need for grouping's sake: the group
 * is what pos-dmg.3 sets `--pos-speed-ink` on, and the property inherits down to
 * the path from there. Same arrangement as a sail's cloth, and for the same
 * reason — the caller paints a layer, not a shape.
 *
 * A stopped boat is hidden by class rather than by a `display` presentation
 * attribute, matching `pos-struck` in `render/sail.ts`, and no stale geometry is
 * computed for it.
 */
export function createSpeedLayer(): Layer {
  const element = svgElement("g", { class: "pos-speed-arrow" });
  const mark = svgElement("path", {
    class: "pos-speed-mark",
    "vector-effect": "non-scaling-stroke",
  });
  element.append(mark);

  return {
    element,
    update(state: SimState): void {
      const speed = state.motion.speed;
      element.classList.toggle(STOPPED_CLASS, !underWay(speed));
      if (!underWay(speed)) return;
      mark.setAttribute("d", speedArrowPathData(speed));
    },
  };
}
