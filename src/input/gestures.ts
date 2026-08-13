/**
 * What a touchdown claims, and what dragging it means (DESIGN.md §5).
 *
 * Everything here is a **pure function of `SimState` and a world-frame point**,
 * with no DOM anywhere: `input/pointer.ts` owns the events, the capture and the
 * multi-touch bookkeeping, and this module owns the arithmetic. That split is
 * what makes the arbitration testable in node — which matters, because the
 * arbitration is the part §5 spent its argument on.
 *
 * ## Every gesture is a rotation about a centre
 *
 * All three targets turn out to be the same gesture with a different centre and
 * a different thing to write:
 *
 * | Target | Centre | Frame | Writes |
 * | --- | --- | --- | --- |
 * | Main | `STATIONS.mast` | boat | `trim.mainAngle` |
 * | Jib | `STATIONS.jibTack` | boat | `trim.jibAngle` |
 * | Hull | the pivot | **world** | `motion.heading` |
 *
 * The frame column is the one thing that is not symmetric, and it is not an
 * accident. A sail angle is measured *against the boat*, so its bearing has to
 * be taken in the boat frame; a heading is what relates the boat frame to the
 * world, so taking its bearing in the boat frame would feed the rotation back
 * into its own input and the boat would run away from the finger.
 *
 * A consequence worth having on purpose: with two fingers down, one turning the
 * hull and one holding a clew, the clew stays under its finger while the boat
 * turns beneath it — so the trim changes. That is what happens on the water
 * when you hold a sheet and the boat turns, and it falls out of measuring the
 * sail's bearing against the live heading rather than the one at touchdown.
 *
 * ## Drags preserve where you grabbed
 *
 * A touchdown records the angle between what the pointer's bearing implies and
 * what the state actually holds, and every later move adds it back. Grab a clew
 * 20 px off centre and the sail does not jump 13° to meet your finger; it
 * follows the finger from where it was. The offset is captured once and the
 * target recomputed from the live bearing each move, so nothing accumulates and
 * a drag pushed past {@link clampTrim}'s limit comes straight back off it
 * instead of unwinding.
 */

import {
  clampTrim,
  jibClewPosition,
  mainClewPosition,
  sailChordBearing,
  STATIONS,
} from "../model/boat.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, Radians, Vec2 } from "../model/units.ts";
import {
  add,
  angleOfVector,
  magnitude,
  normalizeSigned,
  rotateVector,
  subtract,
  ZERO_VECTOR,
} from "../model/units.ts";
import { cubicPoint, HULL_OUTLINE } from "../render/hull.ts";

// --- Frames -----------------------------------------------------------------

/**
 * A world-frame point in the boat frame.
 *
 * `render/scene.ts` hands back world metres about the **pivot** and leaves this
 * step to its caller deliberately: the boat frame's origin is the **mast**, and
 * `world = rotate(heading) · (boat − pivot)` inverts to exactly this. Doing it
 * here rather than reading it off the boat group's CTM keeps it model
 * arithmetic, testable in node, and out of the DOM.
 */
export function toBoatPoint(world: Vec2, heading: Radians): Vec2 {
  return add(rotateVector(world, -heading), STATIONS.pivot);
}

// --- Touch sizes ------------------------------------------------------------

/**
 * The grab disc's radius in CSS pixels — §5's ~44 px target, halved.
 *
 * A **cap**, not the radius: {@link touchScale} takes the lesser of this and
 * half the gap between the two clews, so the two discs can never overlap
 * however hard the sails are eased. On a 390 px phone the boat is ~190 px and
 * the worst legal trim puts the clews ~42 px apart, which is narrower than two
 * 44 px discs side by side — so on a phone this cap is genuinely not always the
 * binding one.
 */
export const GRAB_RADIUS_PX = 22;

/**
 * How close to a rotation's centre a bearing stops being usable, in CSS pixels.
 *
 * A pointer at radius *r* turns its target by 57.3/*r* degrees per pixel it
 * moves across, so the gain rises without bound as the finger approaches the
 * centre. At 24 px it is 2.4°/px — fast, but still a boat that tracks a finger
 * rather than outrunning it — and inside that radius {@link dragTo} holds the
 * angle and re-references on the way out instead of following noise.
 *
 * The hull is the case that needs it: the pivot sits inside the silhouette,
 * about a foot abaft the mast, so a student can and will put a finger on it.
 * The sails reach it only if a drag is pulled deep into the boat, since a clew
 * can never be nearer its own tack than the length of the foot.
 */
export const DEAD_ZONE_PX = 24;

/** §5's two pixel sizes, converted to metres at the scene's live scale. */
export interface TouchScale {
  /** Radius of each clew's grab disc — {@link GRAB_RADIUS_PX}, or half the clew gap. */
  readonly grab: Meters;
  /** Radius of the dead zone about a rotation's centre — {@link DEAD_ZONE_PX}. */
  readonly deadZone: Meters;
}

/**
 * How far apart the two clews are right now, or `null` when the jib is struck
 * and there is no second grab point to keep clear of.
 */
export function clewGap(state: SimState): Meters | null {
  if (!state.trim.jibSet) return null;
  return magnitude(
    subtract(mainClewPosition(state.trim.mainAngle), jibClewPosition(state.trim.jibAngle)),
  );
}

/**
 * The grab disc and dead-zone radii in metres, for a scene's live pixel scale.
 *
 * `pixelsToMeters` is `Scene.pixelsToMeters`, which measures the screen
 * transform rather than assuming a scale — §5's correction to its own pixel
 * figures is that the boat is ~190 px on a phone and ~438 px on a desktop, so a
 * fixed metre radius would be a 44 px target on exactly one display.
 */
export function touchScale(
  state: SimState,
  pixelsToMeters: (pixels: number) => Meters,
): TouchScale {
  const cap = pixelsToMeters(GRAB_RADIUS_PX);
  const gap = clewGap(state);
  return {
    grab: gap === null ? cap : Math.min(cap, gap / 2),
    deadZone: pixelsToMeters(DEAD_ZONE_PX),
  };
}

// --- The hull silhouette ----------------------------------------------------

/**
 * Samples per cubic segment when the outline is turned into a polygon.
 *
 * The polygon is inscribed, so it is very slightly inside the drawn curve; at
 * 64 samples over the boat's longest segment that shortfall is under a tenth of
 * a millimetre, which is a thousandth of a pixel at any scale the scene uses.
 */
const OUTLINE_SAMPLES = 64;

/** The same point with its x negated: starboard → port. */
function mirror(point: Vec2): Vec2 {
  return { x: -point.x, y: point.y };
}

/**
 * The hull outline as a closed polygon in boat-frame metres, sampled once.
 *
 * Built from `render/hull.ts`'s control points rather than from a second set of
 * numbers. That module exposes the outline as data precisely so it can be
 * measured, and the alternative — hit-testing against the DOM path, or
 * re-typing the fairing constants here — would either drag the DOM into a pure
 * module or create a silhouette that could drift from the drawn one. `input/`
 * importing geometry from `render/` reads oddly against §6's layering, but the
 * rule there is that input does not *render*, and reading a shared outline is
 * not rendering.
 *
 * Mirrored rather than written down twice, for the same reason `hullPathData`
 * mirrors: the boat cannot drift out of symmetry.
 */
function buildHullPolygon(): readonly Vec2[] {
  const starboard: Vec2[] = [HULL_OUTLINE.bow];
  let start = HULL_OUTLINE.bow;
  for (const segment of HULL_OUTLINE.starboard) {
    for (let i = 1; i <= OUTLINE_SAMPLES; i += 1) {
      starboard.push(cubicPoint(start, segment, i / OUTLINE_SAMPLES));
    }
    start = segment.end;
  }
  // Reversed and mirrored runs the port side transom → bow. The bow itself is
  // dropped because it is where the ring closes, and it is on the centreline,
  // so its mirror is the point the polygon already starts at.
  const port = [...starboard].reverse().slice(0, -1).map(mirror);
  return [...starboard, ...port];
}

const HULL_POLYGON = buildHullPolygon();

/**
 * Whether a **boat-frame** point lies inside the hull silhouette.
 *
 * The standard even-odd ray crossing: count the polygon edges that a ray cast
 * in −x from the point crosses. Linear algebra only, so `no-raw-trig.test.ts`
 * has nothing to object to.
 *
 * The point is compared against the *fill*, not the stroke, which is what §5
 * means by "everything else on the hull silhouette": the hull is drawn filled
 * (`--pos-deck`) exactly so the whole deck is a target rather than the sheer
 * line alone.
 */
export function insideHull(point: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = HULL_POLYGON.length - 1; i < HULL_POLYGON.length; j = i, i += 1) {
    const a = HULL_POLYGON[i];
    const b = HULL_POLYGON[j];
    if (a.y > point.y !== b.y > point.y) {
      const crossing = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (point.x < crossing) inside = !inside;
    }
  }
  return inside;
}

// --- Targets ----------------------------------------------------------------

/** What a pointer has hold of. */
export type GrabTarget = "main" | "jib" | "hull";

/**
 * A pointer's claim on a target, and where it grabbed it.
 *
 * `offset` is the angle between what the pointer's bearing implies and what the
 * state holds — the "you grabbed it 13° off centre" correction that keeps the
 * sail from jumping to meet a finger. It is `null` whenever the pointer is
 * inside the dead zone, which is the same thing as "there is no usable bearing
 * right now"; {@link dragTo} re-derives it on the way out.
 */
export interface Grab {
  readonly target: GrabTarget;
  readonly offset: Radians | null;
}

/** What a target turns about, and what writing to it does. */
interface Axis {
  /** The centre the pointer's bearing is measured about, in {@link Axis.boatFrame}'s frame. */
  readonly centre: Vec2;
  /** True when the centre and the pointer are boat-frame; false for the world frame. */
  readonly boatFrame: boolean;
  /** What the state currently holds for this target. */
  readonly angle: Radians;
  /** The angle a bare bearing implies, before the grab offset is added back. */
  fromBearing(bearing: Radians): Radians;
  /** The state with this target's angle set — including whatever clamp it owes. */
  apply(state: SimState, angle: Radians): SimState;
}

/**
 * The trim whose clew lies on a given bearing from its tack.
 *
 * `sailChordBearing` maps trim → bearing as `π − trim`, which is its own
 * inverse, so this is that same function read the other way. Named here so the
 * direction is legible at the call site, and routed through `boat.ts` so §2's
 * one sign flip in the rig geometry stays in the one place that owns it.
 */
function trimFromBearing(bearing: Radians): Radians {
  return sailChordBearing(bearing);
}

function axisFor(target: GrabTarget, state: SimState): Axis {
  switch (target) {
    case "main":
      return {
        centre: STATIONS.mast,
        boatFrame: true,
        angle: state.trim.mainAngle,
        fromBearing: trimFromBearing,
        // §5: every site that sets a sail angle routes through the clamp, so a
        // drag can ease the boom to the shrouds and no further.
        apply: (of, angle) => ({ ...of, trim: { ...of.trim, mainAngle: clampTrim(angle) } }),
      };
    case "jib":
      return {
        centre: STATIONS.jibTack,
        boatFrame: true,
        angle: state.trim.jibAngle,
        fromBearing: trimFromBearing,
        apply: (of, angle) => ({ ...of, trim: { ...of.trim, jibAngle: clampTrim(angle) } }),
      };
    case "hull":
      return {
        // The world frame's origin *is* the pivot (`render/scene.ts`), so the
        // point the boat turns about is the origin here rather than
        // `STATIONS.pivot` — that vector is the pivot in the *boat* frame.
        centre: ZERO_VECTOR,
        boatFrame: false,
        angle: state.motion.heading,
        fromBearing: (bearing) => bearing,
        apply: (of, angle) => ({
          ...of,
          motion: { ...of.motion, heading: normalizeSigned(angle) },
        }),
      };
  }
}

/** The pointer's bearing about a target's centre, or `null` inside the dead zone. */
function bearingOn(axis: Axis, world: Vec2, heading: Radians, deadZone: Meters): Radians | null {
  const point = axis.boatFrame ? toBoatPoint(world, heading) : world;
  const offset = subtract(point, axis.centre);
  return magnitude(offset) < deadZone ? null : angleOfVector(offset);
}

/** The grab with its offset taken afresh from where the pointer is now. */
function reference(grab: Grab, state: SimState, world: Vec2, deadZone: Meters): Grab {
  const axis = axisFor(grab.target, state);
  const bearing = bearingOn(axis, world, state.motion.heading, deadZone);
  if (bearing === null) return { target: grab.target, offset: null };
  return {
    target: grab.target,
    offset: normalizeSigned(axis.angle - axis.fromBearing(bearing)),
  };
}

/**
 * What a touchdown at `world` claims, or `null` if it claims nothing.
 *
 * The order is §5's, and both of its rules are here:
 *
 * 1. **The clews first, nearer one wins.** A disc that another pointer already
 *    owns is not a candidate, so two fingers can never land on one sail — and
 *    it does not become hull either, for the reason given at the fall-through
 *    below.
 * 2. **Then the hull silhouette**, which is everything else the boat is.
 *
 * Anything else — open water, the wind ring, a sail's cloth away from its clew
 * — returns `null` and the pointer is left alone. That is deliberate rather
 * than unfinished: pos-bwd.2 claims the perimeter for the wind, and a `null`
 * here is what leaves it free to.
 *
 * The tie-break is load-bearing on a phone and cheap everywhere else. Sizing
 * the discs at half the clew gap already stops them overlapping, so in practice
 * the nearer test decides nothing — but the two guards fail differently and
 * only one of them is a function of the trim, so §5 keeps both.
 */
export function beginGrab(
  state: SimState,
  world: Vec2,
  scale: TouchScale,
  taken: ReadonlySet<GrabTarget>,
): Grab | null {
  const point = toBoatPoint(world, state.motion.heading);

  const clews: readonly (readonly [GrabTarget, Vec2])[] = state.trim.jibSet
    ? [
        ["main", mainClewPosition(state.trim.mainAngle)],
        ["jib", jibClewPosition(state.trim.jibAngle)],
      ]
    : [["main", mainClewPosition(state.trim.mainAngle)]];

  let nearest: GrabTarget | null = null;
  let nearestDistance = Infinity;
  /** Whether the touchdown landed in *any* clew's disc, available or not. */
  let reserved = false;
  for (const [target, clew] of clews) {
    const distance = magnitude(subtract(point, clew));
    if (distance > scale.grab) continue;
    reserved = true;
    if (taken.has(target)) continue;
    if (distance < nearestDistance) {
      nearest = target;
      nearestDistance = distance;
    }
  }

  if (nearest !== null) {
    return reference({ target: nearest, offset: null }, state, world, scale.deadZone);
  }

  // **A disc belongs to its sail whether or not that sail is available.** Both
  // clews lie over the deck at ordinary trim, so without this a second finger
  // landing on a clew someone else is holding would fall through and get the
  // *heading* — and by the live-heading rule above, turning the boat would then
  // drag the first student's sail around under their own stationary finger.
  // Blocking is the quiet answer: the finger that landed on a held sail does
  // nothing, and moves a centimetre.
  if (reserved || taken.has("hull") || !insideHull(point)) return null;
  return reference({ target: "hull", offset: null }, state, world, scale.deadZone);
}

/**
 * The state a drag to `world` asks for, and the grab to carry to the next move.
 *
 * Returns the state unchanged — the same object, so a caller can compare by
 * identity — whenever the pointer has no usable bearing: inside the dead zone,
 * and on the single move that re-references on the way out of it. Both cases
 * are "hold what you have", which is the only honest answer when the thing the
 * gesture reads has momentarily stopped existing.
 */
export function dragTo(
  state: SimState,
  grab: Grab,
  world: Vec2,
  deadZone: Meters,
): { readonly state: SimState; readonly grab: Grab } {
  const axis = axisFor(grab.target, state);
  const bearing = bearingOn(axis, world, state.motion.heading, deadZone);

  if (bearing === null) return { state, grab: { target: grab.target, offset: null } };
  if (grab.offset === null) {
    return { state, grab: reference(grab, state, world, deadZone) };
  }
  return { state: axis.apply(state, axis.fromBearing(bearing) + grab.offset), grab };
}
