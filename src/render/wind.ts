/**
 * The wind ring: the true wind drawn as a graduated circle around the whole
 * scene (DESIGN.md §4.1, §5).
 *
 * Everything here is in **world-frame metres**. The ring mounts on
 * `scene.layers.wind`, which carries no transform at all, because a wind bearing
 * is absolute: swinging the heading moves the boat under a wind that stays put,
 * which is the relationship the sails are supposed to be answering.
 *
 * ## Why a ring rather than a vector near the boat
 *
 * §5's whole argument in one line: an iPad flat on a table has no hover state,
 * touch targets have to be large, and targets will overlap. A wind vector drawn
 * near the boat competes with the sails for exactly the space the sails need. A
 * ring at the perimeter cannot collide with anything — `windRingRadius` is
 * 5.65 m against a boat that sweeps 3.59 m at any heading and any legal trim —
 * and it gives the wind an enormous, always-reachable target.
 *
 * ## What the graduations are
 *
 * Seven ticks, every 45°, anchored to `wind.from` rather than to the compass, so
 * they turn with the wind instead of with the boat. That is what makes them the
 * *points of sail* rather than a compass rose: read where the bow aims on the
 * ring and you have the answer. The arrow's own bearing is head to wind, ±45° is
 * close-hauled, ±90° a beam reach, ±135° a broad reach, and 180° a run.
 *
 * The eighth graduation is not drawn, because the arrow already occupies it.
 *
 * ## What this module deliberately does not do
 *
 * No hit-testing and no drag. The gesture lives in `input/gestures.ts`, which
 * claims an annulus running from {@link ARROW_REACH} out to 22 CSS px beyond
 * `windRingRadius` — far wider than the drawn line, whose job here is to show
 * where that band is. Hit-testing is geometric and never reads an event's
 * target, so nothing below needs to set `pointer-events` in either direction:
 * the drawn track is not what makes the ring grabbable, and hiding it from the
 * pointer would not make it ungrabbable.
 *
 * ## Why a wind drag is drawn here and not in `scene.ts`
 *
 * §1 asks that turning the boat and shifting the wind *feel* like different
 * events although they change the same number, and this module is one half of
 * how that is true. The wind layer carries no transform: a wind drag rewrites
 * the arrow and the graduations in place while `boatTransform` is untouched, so
 * the marks sweep and the boat holds still. A hull drag does the exact opposite.
 *
 * The mistake to guard against is not rotating this group. That would be a fair
 * economy — the ring does turn rigidly — and it would still move the right half
 * of the picture. It is orienting the *world* to the wind: draw the arrow at a
 * fixed bearing and turn everything else beneath it, and a wind shift becomes a
 * boat that swings, which is pixel for pixel what a hull drag does.
 * `input/gestures.test.ts` pins that the two gestures move disjoint halves of
 * the drawing, so that cannot be taken by accident.
 */

import type { SimState } from "../model/simulation.ts";
import type { Meters, Radians, Vec2 } from "../model/units.ts";
import { TAU, add, degreesToRadians, vectorFromAngle } from "../model/units.ts";
import { SCENE, type Layer } from "./scene.ts";
import { formatNumber, svgElement } from "./svg.ts";

// --- Drawing taste ----------------------------------------------------------

/**
 * How far the arrow flies in from the ring.
 *
 * It reaches 4.45 m, which is inside `contentRadius` — and that is fine, because
 * the reservation runs the other way: `contentRadius` bounds how far the *speed*
 * indicator reaches before it starts crossing the ring, not how far in the ring's
 * own marks may come. The two can only be co-located with the bow aimed straight
 * at the arrow, which is head to wind, where the boat is making no way forward to
 * draw. What actually matters is that the arrow stays clear of the boat's swept
 * disc at every heading, with 0.86 m to spare; `wind.test.ts` sweeps it.
 */
const ARROW_LENGTH: Meters = 1.2;

/** Barb length and how far the barbs splay back from the tip. */
const ARROW_BARB: Meters = 0.4;
const ARROW_SPREAD: Radians = degreesToRadians(28);

/**
 * The innermost radius the drawn arrow reaches — its tip, at 4.45 m.
 *
 * Exported because it is the **inner edge of the wind's hit band** (§5), not
 * merely a drawing dimension. The arrow is the mark a student reaches for, and a
 * band sized only in pixels about the ring leaves most of it outside: a
 * symmetric 22 px band starts at 4.97 m on a phone and 5.33 m on an iPad, which
 * misses 17 px of the arrow's 39 px on the one and 61 px of its 83 px on the
 * other — the whole arrowhead in both cases, since the barb tips stand at
 * 4.807 m. `input/gestures.ts` reads this so the target follows the drawing
 * instead of a number that has to be remembered when the drawing changes.
 *
 * The barbs cannot be the binding point: they splay *back* from the tip toward
 * the ring, so the tip is the minimum by construction, and `wind.test.ts`
 * measures the path data to say so rather than taking it on trust.
 */
export const ARROW_REACH: Meters = SCENE.windRingRadius - ARROW_LENGTH;

/**
 * How far each graduation reaches in from the ring.
 *
 * Inward rather than outward on purpose. Outward there are only 0.35 m to the
 * short-axis edge — about 11 px on a 390 px phone — and a tick clipped by the
 * viewport reads as a rendering fault. Inward it stops at 5.40 m, still outside
 * `contentRadius`, so the graduations never intrude on the speed indicator's
 * band either.
 */
const TICK_LENGTH: Meters = 0.25;

/** The points of sail: eight 45° marks, less the one the arrow stands on. */
const TICK_COUNT = 8;

// --- Path data --------------------------------------------------------------

/** `x y`, the way path data wants a point. */
function point(v: Vec2): string {
  return `${formatNumber(v.x)} ${formatNumber(v.y)}`;
}

/**
 * The arrow, tail on the ring at the bearing the wind blows *from*, flying
 * inward along the same radial — the way the wind is actually going.
 *
 * The head is path geometry in metres rather than a `marker`. Markers are sized
 * in stroke widths by default, and every stroke in this drawing is
 * `non-scaling-stroke` (§4.5), so a marker would size itself off a length that
 * has been taken out of user space — which draws an arrowhead the size of the
 * boat.
 */
export function windArrowPathData(from: Radians): string {
  const tail = vectorFromAngle(from, SCENE.windRingRadius);
  const tip = vectorFromAngle(from, SCENE.windRingRadius - ARROW_LENGTH);
  // Barbs splay back upwind from the tip, which is bearing `from` again.
  const barb = (sign: number): Vec2 =>
    add(tip, vectorFromAngle(from + sign * ARROW_SPREAD, ARROW_BARB));

  return [
    `M ${point(tail)} L ${point(tip)}`,
    `M ${point(barb(-1))} L ${point(tip)} L ${point(barb(1))}`,
  ].join(" ");
}

/**
 * The seven graduations, as one path.
 *
 * One element rather than seven because they are one mark: they always move
 * together, and a single `d` rewrite per frame is cheaper than seven.
 */
export function windTickPathData(from: Radians): string {
  const marks: string[] = [];
  // From 1, not 0: the arrow stands on the head-to-wind mark already.
  for (let i = 1; i < TICK_COUNT; i += 1) {
    const bearing = from + (i * TAU) / TICK_COUNT;
    const outer = vectorFromAngle(bearing, SCENE.windRingRadius);
    const inner = vectorFromAngle(bearing, SCENE.windRingRadius - TICK_LENGTH);
    marks.push(`M ${point(outer)} L ${point(inner)}`);
  }
  return marks.join(" ");
}

// --- The drawn layer --------------------------------------------------------

/**
 * The ring, as a layer for `main.ts` to mount on `scene.layers.wind`.
 *
 * The circle is a `<circle>` rather than a path because it never changes: only
 * the arrow and the graduations turn with the wind, and giving the track its own
 * never-touched element says so. Order inside the group is track, graduations,
 * arrow — lightest to heaviest, so the arrow reads on top of its own scale.
 */
export function createWindLayer(): Layer {
  const element = svgElement("g", { class: "pos-wind-ring" });

  const track = svgElement("circle", {
    class: "pos-wind-track",
    cx: 0,
    cy: 0,
    r: SCENE.windRingRadius,
    "vector-effect": "non-scaling-stroke",
  });
  const ticks = svgElement("path", {
    class: "pos-wind-ticks",
    "vector-effect": "non-scaling-stroke",
  });
  const arrow = svgElement("path", {
    class: "pos-wind-arrow",
    "vector-effect": "non-scaling-stroke",
  });

  element.append(track, ticks, arrow);

  return {
    element,
    update(state: SimState): void {
      ticks.setAttribute("d", windTickPathData(state.wind.from));
      arrow.setAttribute("d", windArrowPathData(state.wind.from));
    },
  };
}
