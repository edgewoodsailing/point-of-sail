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
 * Linear in speed, out to the wind ring; asymptotic past it:
 *
 * ```text
 * linear = SPEED_REACH · |speed| / SPEED_FULL_SCALE
 * length = linear                                          (linear ≤ SPEED_KNEE)
 *        = SPEED_KNEE + H · (1 − e^(−(linear − SPEED_KNEE) / H))   (beyond it)
 *        where H = SPEED_LIMIT − SPEED_KNEE
 * ```
 *
 * `SPEED_REACH` is derived rather than declared — it is what is left of
 * `SCENE.contentRadius` once the bow and the gap between hull and arrow are
 * accounted for, which is the same figure astern because the pivot is the
 * midpoint of LOA. `SPEED_FULL_SCALE` is hull speed. So the tip lands *exactly*
 * on `contentRadius` at hull speed, which is what that band was reserved for,
 * and everything at or below hull speed is drawn by the plain linear law.
 *
 * Above hull speed the arrow keeps growing and crosses the wind ring. That is
 * deliberate, and §4.1 says so in as many words: `contentRadius` is a
 * reservation, not a clamp. Clamping there would make 5.6 kt and 8 kt draw
 * identically — the drawing would stop reporting speed at exactly the point
 * where the boat is being driven hardest — and crossing the ring is a legible
 * thing in its own right: she is past hull speed. `scene.ts` paints the ring
 * above the boat so the overrun passes behind it, and `scene.css` gives
 * `.pos-speed` `pointer-events: none` so it can never intercept a drag pos-bwd.2
 * means for the ring.
 *
 * ## Why the law bends at all (pos-w4v)
 *
 * The linear law was unbounded, and the drawing is not: past the ring there is
 * only `SCENE.shortRadius` to spend, and `sceneExtent` maps exactly that radius
 * onto the *shorter* side of any surface. So a tip beyond 6 m is off the screen
 * — not overrunning a reservation, which is fine, but leaving the viewBox, which
 * nothing in §4 ever contemplated. It took 7.82 kt to do that, and pos-lcz
 * raised what the model can reach to 8.915 kt, which put 0.4 m of arrow outside
 * the box on any square-or-portrait viewport.
 *
 * The bend is placed at the ring rather than at hull speed on purpose, and it
 * is what makes this change invisible: **every speed out to 6.87 kt draws
 * exactly what it drew before**, because that is where the linear tip reaches
 * `windRingRadius`. What compresses is only the 0.25 m between the ring and the
 * edge — the one band in the drawing that nothing else uses, since `wind.ts`
 * deliberately runs its graduations *inward* for the same reason this stops
 * short of the edge: a mark clipped by the viewport reads as a rendering fault.
 * Bending at hull speed instead would have shortened the arrow across 5.6–8 kt,
 * which is where the boat actually sails, and pushed the ring crossing out to
 * 7.6 kt. That crossing is the one landmark a student can actually see the
 * arrow pass: `contentRadius` is a budget, not a drawn circle, so "she is past
 * hull speed" is read off the ring at 5.65 m and nothing else. Moving it would
 * have been the only perceptible regression on offer, and this avoids it.
 *
 * ## Why this stays, once nothing can reach the clip
 *
 * pos-d7u depowers the rig in a breeze and drops the fastest reachable speed
 * from 8.9 kt to about 6.4 — *below* the 6.87 kt ring crossing. So once it
 * lands the knee never engages in normal use and the arrow is linear over the
 * whole reachable range, which can make this look like dead weight. It is not,
 * and the reason is the same one that made it wrong to clamp at a measured top
 * speed in the first place: nothing guarantees a future model, a retuned
 * constant, or a raised wind slider stays under the ring, and the 30 kt ceiling
 * is scaffolding pos-bwd.1 deletes. This is the drawing refusing to depend on
 * the model's range at all. Do not delete it on the grounds that the range no
 * longer reaches it — measure the invariant, not the reachable speeds.
 *
 * Three properties, and they are the point:
 *
 * - **Bounded.** `SPEED_LIMIT` bounds the length at *every* speed, including the
 *   ones no boat reaches and `Infinity`. Not "fast enough that nobody gets
 *   there" — the 30 kt wind slider is scaffolding pos-bwd.1 deletes, so no top
 *   speed is safe to build on. In exact arithmetic the limit is approached and
 *   never reached; in float64 it is reached, at 30.35 kt, where what is still to
 *   be added has fallen below one ulp of the sum. Past there this is a clamp
 *   outright rather than in all but name — which is why the limit is placed
 *   where a clamped arrow is still a legal one, 0.1 m inside the edge.
 * - **Monotone** everywhere, and strictly increasing until it is within a
 *   nanometre of the limit, so the arrow never stops answering the question
 *   while the answer can still be heard. The last few ulps are flat for the
 *   same rounding reason as above, well past where anything is drawable.
 * - **Smooth.** The exponential has slope 1 at the knee, so it leaves the linear
 *   law tangentially rather than at a visible corner.
 *
 * The cost, stated plainly: above about 10 kt successive speeds differ by
 * fractions of a pixel, so up there this is a clamp in all but name. That is
 * the right place to give up — it is past anything the model produces, and no
 * law can keep resolving speed inside a finite box forever.
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
import { SCENE, VELOCITY_SCALE, type Layer } from "./scene.ts";
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
 * How far the arrow's *tail* sits from the pivot, ≈ 3.12 m, and therefore the
 * offset between any drawn length below and the radius its tip reaches.
 *
 * One figure rather than three, because every band in `SCENE` has to be turned
 * into a length the same way, and doing it once is what keeps them from drifting
 * apart. Because `STATIONS.pivot` is the midpoint of LOA the figure is the same
 * astern, so sternway gets exactly the room headway does — `scene.test.ts` pins
 * that symmetry from the other side.
 */
const TAIL_RADIUS: Meters = magnitude(subtract(STATIONS.bow, STATIONS.pivot)) + HULL_GAP;

/**
 * The speed at which the arrow is exactly {@link SPEED_REACH} long.
 *
 * Hull speed rather than a number chosen to look right: it is already the
 * boat's own scale — `model/hull.ts` builds its resistance wall around it — and
 * it is the speed a student is trying to reach.
 *
 * Declared above `SPEED_REACH` rather than below it, as it was, because that
 * constant now derives from this one and a module's constants initialise in
 * source order.
 */
export const SPEED_FULL_SCALE: MetersPerSecond = HULL.hullSpeed;

/**
 * PROTOTYPE (pos-bwd.5) — how long the arrow is at hull speed, ≈ 1.60 m.
 *
 * **Derived from `VELOCITY_SCALE` now, not from `SCENE.contentRadius`.** That is
 * the whole of the change: the two arrows are both velocities, so their lengths
 * come off one scale and the drawing becomes a vector diagram instead of three
 * separate readouts. The old figure was 2.08 m — what was left of the
 * `contentRadius` band once the bow and the gap were accounted for — and it was
 * a fine length chosen for the wrong reason. It made the boat's arrow 30% longer
 * per knot than the wind's, so a 5 kt boat in a 5 kt wind out-drew the wind
 * pushing it.
 *
 * Two consequences, both intended and both stated rather than discovered:
 *
 * - **The arrow shrinks about 1.30×.** Not a regression: the boat genuinely *is*
 *   several times slower than the top of the wind range, and the proportions
 *   being true is the entire point. pos-bwd.5's table measured exactly this row.
 * - **`contentRadius` no longer has a tenant.** The band it reserved is now
 *   unspent, which is a space question this prototype opens rather than closes.
 *
 * Hull speed is still the *speed* this length is quoted at, because it is still
 * the boat's own scale — what has changed is that the length is no longer chosen
 * to fill a band.
 */
export const SPEED_REACH: Meters = VELOCITY_SCALE * SPEED_FULL_SCALE;

/**
 * The longest arrow still drawn by the plain linear law, ≈ 2.53 m — the one
 * whose tip lands on the wind ring, at about 6.87 kt.
 *
 * Everything at or below this is untouched by pos-w4v's bend, which is the
 * whole reason the knee is here rather than at `SPEED_REACH`: the ring is the
 * only landmark in the drawing a student can see the arrow cross, and moving
 * the speed that crosses it would be a real change to what the picture says.
 */
export const SPEED_KNEE: Meters = SCENE.windRingRadius - TAIL_RADIUS;

/**
 * How much clear water the tip leaves inside the short-axis edge.
 *
 * It has to cover the stroke, which is the one dimension here that is not in
 * metres: `--pos-rule-speed` is `clamp(1.6px, 0.45vmin, 4px)`, round-capped, so
 * half of it overhangs the tip. Two lengths go into that and they are easy to
 * conflate — the clamp's `vmin` is the **viewport's** short side, while metres
 * per pixel is `SHORT_SPAN / surfaceShort`, the **surface's**. §6.2 stacks the
 * control strip below the surface, so in landscape the strip comes off the
 * short axis and the two part company.
 *
 * Portrait is the easy case and holds at 0.027–0.030 m. Landscape is the one
 * that binds: with the current seven-row scaffolding strip a 568×320 phone
 * leaves only 160 px of surface, and the overhang reaches 0.060 m.
 *
 * 0.1 m covers even that with 40% to spare, and the surplus is not slack. A tip
 * hard against the edge reads as a clipped mark whether or not it is one, which
 * is exactly why `wind.ts` runs its graduations inward instead of outward.
 * `speed.test.ts` derives the figure across a table of viewports and strip
 * heights rather than restating it, because the first version of this comment
 * quietly assumed the two short sides were the same and was wrong by a factor
 * of two. It reads the clamp's three terms out of `scene.css` rather than
 * copying them, so raising `--pos-rule-speed` fails a test here instead of
 * leaving this paragraph stale (pos-7nt).
 */
const EDGE_KEEP_OUT: Meters = 0.1;

/**
 * The length the arrow eases onto and never exceeds, ≈ 2.78 m.
 *
 * `SCENE.shortRadius` is the binding constraint on the whole drawing and not
 * merely the tightest one: `sceneExtent` scales by the surface's *shorter* side,
 * so `min(halfWidth, halfHeight)` is that radius exactly, on every viewport
 * there is. Stay inside it and the arrow is inside the viewBox at every heading,
 * because the bound is radial and the boat group only rotates.
 */
export const SPEED_LIMIT: Meters = SCENE.shortRadius - EDGE_KEEP_OUT - TAIL_RADIUS;


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

/**
 * How long the arrow is, for a signed speed. Unsigned: the sign is a direction.
 *
 * Linear out to `SPEED_KNEE`, then the linear length's *overrun* past the knee
 * is squeezed into what is left before `SPEED_LIMIT`. Written as the fraction of
 * the remaining headroom that gets spent, `1 − e^(−overrun/headroom)`, which is
 * a number in [0, 1] — never above, so `SPEED_LIMIT` bounds the result at any
 * speed at all, and `Infinity` in yields `SPEED_LIMIT` rather than `NaN`.
 */
export function speedArrowLength(speed: MetersPerSecond): Meters {
  const linear = (SPEED_REACH * Math.abs(speed)) / SPEED_FULL_SCALE;
  if (linear <= SPEED_KNEE) return linear;

  const headroom = SPEED_LIMIT - SPEED_KNEE;
  return SPEED_KNEE + headroom * (1 - Math.exp(-(linear - SPEED_KNEE) / headroom));
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
