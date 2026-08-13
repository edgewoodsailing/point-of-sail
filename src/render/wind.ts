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

import { WIND_SPEED_KT } from "../input/windSpeed.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, MetersPerSecond, Radians, Vec2 } from "../model/units.ts";
import {
  TAU,
  add,
  degreesToRadians,
  knotsToMetersPerSecond,
  vectorFromAngle,
} from "../model/units.ts";
import { SCENE, VELOCITY_SCALE, type Layer } from "./scene.ts";
import { formatNumber, svgElement } from "./svg.ts";

// --- Drawing taste ----------------------------------------------------------

/**
 * PROTOTYPE — the arrow's length is the wind's *speed*, and its **tip** is the
 * radial control's handle.
 *
 * The arrow's tail stays on the ring, where it has always been, and only the tip
 * moves: it flies in from the perimeter by `arrowLength(speed)`, reaching the
 * scene origin — the mast — at the top of the range and vanishing into the ring
 * in a calm. So:
 *
 * - **Its length is the wind**, on one scale, and 20 kt is full scale because
 *   20 kt is the whole of the range §5 teaches in. That is pos-bwd.5's shared
 *   scale — 0.2174 m/kt once the ring's radius is solved from it.
 * - **It is not buried.** An arrow anchored at the origin instead is entirely
 *   inside the boat's swept disc below 12.7 kt — most of the teaching range —
 *   and at 5 kt reads as deck hardware lying across the sails. Anchored at the
 *   ring, the whole arrow is clear of the boat's disc up to **3.49 kt** and its
 *   *tail* is clear at every wind, so there is always a length of it out in open
 *   water to read and to grab. (An earlier draft of this bullet claimed it was
 *   "always outside the boat", which was true of the 5.65 m ring it was written
 *   against and stopped being true when the radius was solved down to 4.35 m.
 *   The arrow crossing the sails in a breeze is the intent — that is what the
 *   translucent layer is for — but "always outside" was simply wrong.)
 * - **Its tip is under the finger**, which is what makes the water one radial
 *   control: a pointer's radius is where the arrowhead goes, and its bearing is
 *   where the wind comes from.
 *
 * The consequence worth judging rather than reasoning about: **dragging inward
 * makes more wind**, because the tip is the handle and the tip travels inward as
 * the wind builds. {@link WIND_CONTROL} is the switch, and neither setting is
 * free:
 *
 * - **Inward (the default) tracks.** Your finger is the arrowhead and the
 *   arrowhead is under your finger, which is what direct manipulation means, and
 *   it is pos-bwd.6's "drag the arrowhead" with the requirement to hit the
 *   arrowhead removed. Against it: "further out is more" is what a dial teaches,
 *   and this is the reverse.
 * - **Outward reads the way a dial does** — and then the arrowhead moves the
 *   opposite way to the hand moving it, which is usually the worse of the two
 *   mistakes. Under relative dragging the finger is not on any drawn point
 *   anyway, so it is not incoherent; it just has nothing to track.
 */
export const WIND_CONTROL = { inward: true };

function arrowLength(speed: MetersPerSecond): Meters {
  const full = knotsToMetersPerSecond(WIND_SPEED_KT.max);
  return VELOCITY_SCALE * Math.min(Math.max(speed, 0), full);
}

/**
 * What wind a pointer at this radius is asking for, clamped to the range the
 * control offers.
 *
 * Exported for `input/gestures.ts`, which is the whole point — the mapping is
 * one pair of functions read both ways, so the arrow cannot end up drawn on a
 * different scale from the one the finger is moving it on.
 */
export function speedForRadius(radius: Meters): MetersPerSecond {
  const travel = WIND_CONTROL.inward ? SCENE.windRingRadius - radius : radius;
  const full = knotsToMetersPerSecond(WIND_SPEED_KT.max);
  return Math.min(Math.max(travel / VELOCITY_SCALE, 0), full);
}

/**
 * Where this wind speed puts the control's handle.
 *
 * Under `inward` that is the arrowhead itself, so the drawn mark and the grabbed
 * point are the same place. Under `outward` it is a radius with nothing drawn on
 * it — which is the honest thing to say about that setting.
 */
export function radiusForWind(speed: MetersPerSecond): Meters {
  const length = arrowLength(speed);
  return WIND_CONTROL.inward ? SCENE.windRingRadius - length : length;
}

/** Barb length and how far the barbs splay back from the tip. */
const ARROW_BARB: Meters = 0.4;
const ARROW_SPREAD: Radians = degreesToRadians(28);

/**
 * Retained only so nothing that imported it breaks while the prototype is being
 * looked at. It no longer bounds a hit band: the wind's region is now everything
 * the boat does not claim (`input/gestures.ts`), so there is no inner edge to
 * state.
 */
export const ARROW_REACH: Meters = 0;

/**
 * How far each graduation reaches in from the ring.
 *
 * Inward rather than outward on purpose. Outward there is only the edge margin
 * to the short-axis edge — about 11 px on a 390 px phone — and a tick clipped by
 * the viewport reads as a rendering fault.
 *
 * **A fraction of the ring, not a length.** It was 0.25 m against a ring of
 * 5.65, and both of those were declared. The ring is solved now (`SCENE`), so a
 * fixed 0.25 m grew from 4.4% of the radius to 5.7% and reached inside
 * `contentRadius` — the graduations began intruding on the speed arrow's band
 * without anybody changing them. Held at the proportion it always had, it
 * follows the ring wherever the derivation puts it.
 */
const TICK_LENGTH: Meters = SCENE.windRingRadius * (0.25 / 5.65);

/** The points of sail: eight 45° marks, less the one the arrow stands on. */
const TICK_COUNT = 8;

// --- Path data --------------------------------------------------------------

/** `x y`, the way path data wants a point. */
function point(v: Vec2): string {
  return `${formatNumber(v.x)} ${formatNumber(v.y)}`;
}

/**
 * The arrow: tail on the ring at the bearing the wind blows *from*, flying
 * inward along the same radial by however hard it is blowing — so it points the
 * way the wind is going and its length is the speed.
 *
 * The head is path geometry in metres rather than a `marker`. Markers are sized
 * in stroke widths by default, and every stroke in this drawing is
 * `non-scaling-stroke` (§4.5), so a marker would size itself off a length that
 * has been taken out of user space — which draws an arrowhead the size of the
 * boat.
 *
 * **A calm draws nothing**, and needs to draw nothing. The zero-wind edge case
 * pos-bwd.6 had to design a grabbable minimum for is dissolved rather than
 * solved: the whole water is the control, so a wind dragged away to nothing is
 * recoverable from anywhere on the surface.
 *
 * The barbs shrink with the shaft below `4 × ARROW_BARB`, so a light air draws a
 * small arrow rather than an arrowhead with no arrow behind it. Without it the
 * mark inverts at the bottom of the range, which is precisely where a student is
 * trying to read whether there is any wind at all.
 */
export function windArrowPathData(from: Radians, speed: MetersPerSecond): string {
  const length = arrowLength(speed);
  if (length <= 0) return "";

  const tail = vectorFromAngle(from, SCENE.windRingRadius);
  const tip = vectorFromAngle(from, SCENE.windRingRadius - length);
  const barbLength = Math.min(ARROW_BARB, length / 4);
  // Barbs splay back upwind from the tip, which is bearing `from` again.
  const barb = (sign: number): Vec2 =>
    add(tip, vectorFromAngle(from + sign * ARROW_SPREAD, barbLength));

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
      arrow.setAttribute("d", windArrowPathData(state.wind.from, state.wind.speed));
    },
  };
}
