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
 * All four targets turn out to be the same gesture with a different centre and
 * a different thing to write:
 *
 * | Target | Centre | Frame | Writes |
 * | --- | --- | --- | --- |
 * | Main | `STATIONS.mast` | boat | `trim.mainAngle` |
 * | Jib | `STATIONS.jibTack` | boat | `trim.jibAngle` |
 * | Hull | the pivot | **world** | `motion.heading` |
 * | Wind | the pivot | **world** | `wind.from` |
 *
 * The frame column is the one thing that is not symmetric, and it is not an
 * accident. A sail angle is measured *against the boat*, so its bearing has to
 * be taken in the boat frame; a heading is what relates the boat frame to the
 * world, so taking its bearing in the boat frame would feed the rotation back
 * into its own input and the boat would run away from the finger.
 *
 * **The hull and the wind share a row of that table down to the last column,
 * and that is §1 rather than a shortcut.** Rotating the hull and rotating the
 * wind are the same operation — only the angle between them enters the model —
 * so the arithmetic here is deliberately identical, and forcing the two apart
 * in this module would invent a difference the design says is not there. What
 * §1 requires is that they *feel* like different events, and that is a property
 * of the drawing, not of the bearing: `motion.heading` turns the boat group
 * while the graduations hold still, and `wind.from` sweeps the arrow and the
 * graduations while the boat holds still. `gestures.test.ts` pins both halves,
 * so routing the wind through the boat's transform — the one change that would
 * collapse them into one animation — cannot pass silently.
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
import { SCENE } from "../render/scene.ts";
import { ARROW_REACH } from "../render/wind.ts";

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

/**
 * How far *outside* the drawn wind ring still counts as the wind, in CSS pixels.
 *
 * A separate constant from the clew radius, though they are the same number for
 * the same reason, because the two are bounded by different things: the disc's
 * cap gives way to half the clew gap, and this one gives way to the water
 * between the ring and the boat. Sharing a name would tie them together at the
 * point where they stop agreeing.
 *
 * **The band is not symmetric**, and the reason is the arrow. Inward it runs to
 * `render/wind.ts`'s `ARROW_REACH` — the arrowhead is the mark a student reaches
 * for, and a symmetric 22 px band would leave most of it dead: 17 px of its
 * 39 px on a 390 px phone, 61 px of 83 px on an iPad, the whole arrowhead in
 * both. Outward there is nothing to reach for, so 22 px is enough.
 *
 * **Outward, rather than claiming everything beyond the ring.** The generous
 * reading is tempting, since nothing else is out there to want the touch. It is
 * rejected for the case §5 designs for: an iPad flat on a table collects resting
 * palms at the screen edges, and because a target belongs to one pointer at a
 * time (§5, multi-touch), the first palm to land would own the wind and every
 * deliberate ring drag after it would get nothing at all.
 *
 * **That protection is real on two edges of four, not on all of them**, which is
 * worth stating because the arithmetic is easy to get backwards. The scene is
 * scaled off the *short* axis, so the ring sits 24 px inside the short edge on
 * an 834 px iPad and 11 px inside it on a 390 px phone — closer than the band is
 * wide, so along the short axis the viewport ends inside the band and there is
 * no outer water to leave unclaimed anyway. It is the **long** axis that gains:
 * an iPad in landscape has 182 px of unclaimed water beyond the band at each of
 * the left and right edges, which are the edges a hand actually rests on. So the
 * choice buys the two long edges and the alternative buys none of the four.
 */
export const WIND_BAND_PX = 22;

/** §5's pixel sizes, converted to metres at the scene's live scale. */
export interface TouchScale {
  /** Radius of each clew's grab disc — {@link GRAB_RADIUS_PX}, or half the clew gap. */
  readonly grab: Meters;
  /** Radius of the dead zone about a rotation's centre — {@link DEAD_ZONE_PX}. */
  readonly deadZone: Meters;
  /** The annulus that belongs to the wind, as radii from the scene origin. */
  readonly windRing: WindRing;
}

/** The wind's hit band, as an annulus rather than a half-width — it is not symmetric. */
export interface WindRing {
  readonly inner: Meters;
  readonly outer: Meters;
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
  const grab = gap === null ? cap : Math.min(cap, gap / 2);
  return {
    grab,
    deadZone: pixelsToMeters(DEAD_ZONE_PX),
    windRing: windRingFor(grab, pixelsToMeters(WIND_BAND_PX)),
  };
}

/**
 * The annulus that belongs to the wind, kept clear of anything the boat can
 * claim.
 *
 * **Outward** is the easy half: 22 px beyond the drawn ring, and nothing out
 * there competes for it.
 *
 * **Inward** runs to the arrow's own tip, {@link ARROW_REACH}, so that the mark
 * a student reaches for is inside the target that moves it. That is a distance
 * in metres rather than in pixels, because the arrow is a dimension *of the
 * drawing* (§4.1's first rule) and the target should follow it.
 *
 * It is then **floored off the boat**, the same shape of rule as
 * `min(22px, gap / 2)` in {@link touchScale}, and for the same reason: a target
 * eventually meets something it must not. `SCENE.boatRadius` is the disc the
 * boat sweeps at *any* heading and any legal trim, 3.590 m, and a touchdown can
 * claim a clew from a further `grab` out — so the innermost point that may
 * belong to the wind is `boatRadius + grab`.
 *
 * **The floor is slack down to a 308 px short axis** — that is where
 * `boatRadius + 22px` reaches the arrow's tip — and binds below it, taking the
 * arrowhead first and the rest of the arrow after. Both sides are tested, since
 * a guard that only ever passes says nothing about its own resolution. On a
 * 390 px phone the band runs in to 4.450 m against a clew disc reaching out to
 * 4.267 m: 6 px of open water between the two targets. That is thinner than the
 * 23 px a symmetric band left, and it is the price of the arrowhead — the two
 * targets still cannot overlap, which is the property that matters.
 *
 * **There is deliberately no 22 px floor under the inward reach**, and a draft
 * of this had one. It would have kept the band 44 px across on a display too
 * small for the arrow to be 22 px long — and it is unreachable, which is how it
 * was caught: mutation-testing it left all 450 tests green. For that floor to
 * bind, `band` must exceed the arrow's 1.2 m, which needs a short axis under
 * 220 px; but `grab` is the same 22 px, so `boatRadius + grab` is then over
 * 4.79 m and the `max` below has already won. It could never change an answer,
 * so it is gone rather than left as a guard nothing can test.
 */
function windRingFor(grab: Meters, band: Meters): WindRing {
  return {
    inner: Math.max(SCENE.boatRadius + grab, ARROW_REACH),
    outer: SCENE.windRingRadius + band,
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
export type GrabTarget = "main" | "jib" | "hull" | "wind";

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
    case "wind":
      return {
        // The ring is concentric with the world origin (`render/wind.ts` draws
        // it at cx=0, cy=0 on an untransformed layer), so the bearing that
        // grabs it and the bearing it *is* are the same measurement.
        centre: ZERO_VECTOR,
        boatFrame: false,
        angle: state.wind.from,
        // The arrow's tail stands on the ring at the bearing the wind blows
        // *from*, so a pointer's bearing about the centre is `wind.from`
        // directly. The identity here is the whole reason the arrow tracks a
        // finger laid on it.
        fromBearing: (bearing) => bearing,
        apply: (of, angle) => ({
          ...of,
          wind: { ...of.wind, from: normalizeSigned(angle) },
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

/** Whether a **world-frame** point lies in the wind ring's hit band. */
export function onWindRing(world: Vec2, ring: WindRing): boolean {
  const radius = magnitude(world);
  return radius >= ring.inner && radius <= ring.outer;
}

/**
 * What a touchdown at `world` claims, or `null` if it claims nothing.
 *
 * The order is §5's, and all of its rules are here:
 *
 * 1. **The clews first, nearer one wins.** A disc that another pointer already
 *    owns is not a candidate, so two fingers can never land on one sail — and
 *    it does not become hull either, for the reason given at the fall-through
 *    below.
 * 2. **Then the hull silhouette**, which is everything else the boat is.
 * 3. **Then the wind ring's band**, the annulus from the arrow's tip out to a
 *    touch target's worth of water beyond the drawn ring.
 *
 * The order is legible rather than load-bearing between 2 and 3: `windRingFor`
 * keeps the band clear of every point a clew disc or the hull can reach, so no
 * touchdown is a candidate for both. Stating it in this order says which one the
 * single tangent point belongs to on a display too small for the two to be
 * strictly separated, and nothing else.
 *
 * Anything else — the open water between the boat and the ring, the water
 * outside the band, a sail's cloth away from its clew — returns `null` and the
 * pointer is left alone. That is deliberate rather than unfinished: a touch
 * given to the nearest anything is how a student ends up turning a boat they
 * meant to miss.
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
  if (reserved) return null;

  if (!taken.has("hull") && insideHull(point)) {
    return reference({ target: "hull", offset: null }, state, world, scale.deadZone);
  }

  // The ring is measured in the world frame — it belongs to the world, not to
  // the boat, which is the whole of §5's argument for putting the wind out
  // here. A second finger reaches it while a first holds a sail, because the
  // band and the clew discs are disjoint by construction and `wind` is a target
  // of its own for the exclusivity rule.
  if (!taken.has("wind") && onWindRing(world, scale.windRing)) {
    return reference({ target: "wind", offset: null }, state, world, scale.deadZone);
  }

  return null;
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

/** A live pointer: what it has hold of, and the last place it was seen. */
export interface Held {
  readonly grab: Grab;
  readonly at: Vec2;
}

/**
 * Re-applies the pointers that did **not** move, after one that did changed the
 * world underneath them.
 *
 * A finger that is holding still sends no `pointermove`, so without this the
 * only gesture recomputed on a frame is the one whose finger moved. That is
 * fine for two sails, whose inputs are independent — and wrong the moment the
 * hull is one of them, because a sail's bearing is taken in the boat frame at
 * the live heading. One student turning the boat while another holds a clew
 * would leave that clew where the *boat* put it rather than where the finger
 * is, and the sail would then jump the whole accumulated rotation the instant
 * that finger twitched. Both halves are worse than tracking.
 *
 * One pass is enough, and that is a property rather than an optimism. Each
 * gesture is idempotent in the state it does not write: re-applying a sail
 * reads the heading and its own world point, neither of which another sail can
 * touch; re-applying the hull or the wind reads its world point and nothing
 * else. So no re-application can invalidate one already done.
 *
 * The wind is the one target that needs no re-application at all — it is a
 * world-frame bearing about a fixed centre, so nothing another finger can do
 * moves it under its own. It goes through the same pass anyway, because the
 * alternative is a special case that has to stay true as the model grows.
 */
export function reapply(
  state: SimState,
  held: readonly Held[],
  deadZone: Meters,
): { readonly state: SimState; readonly held: readonly Held[] } {
  let next = state;
  const updated = held.map((one) => {
    const result = dragTo(next, one.grab, one.at, deadZone);
    next = result.state;
    return { grab: result.grab, at: one.at };
  });
  return { state: next, held: updated };
}
