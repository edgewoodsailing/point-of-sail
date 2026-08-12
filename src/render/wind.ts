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
 * No hit-testing and no drag. pos-bwd.2 owns the gesture, and it wants a hit
 * band far wider than the drawn line — the ring's job here is to show where that
 * band is. Nothing below sets `pointer-events`, so the drawn geometry stays
 * grabbable and the band pos-bwd.2 adds can sit alongside it.
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
