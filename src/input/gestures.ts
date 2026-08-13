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
import { apparentWind } from "../model/wind.ts";
import { jibChord, jibSheetFor } from "../model/sail.ts";
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
import { radiusForWind, speedForRadius } from "../render/wind.ts";

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
 * **DEAD, and kept only until the tests that read it are rewritten (pos-d0w).**
 *
 * There is no band any longer: the wind is the fall-through in {@link beginGrab}
 * and takes everything the boat does not claim. Everything below this line
 * argues the annulus design that replaced — the asymmetry that covered the
 * arrowhead, and the outward 22 px that kept a resting palm from owning the
 * wind. Both are answered in DESIGN §5, the second by dropping the premise: the
 * wind is not exclusive, so a palm holds it and cannot move it.
 *
 * The argument is left standing rather than deleted because it is the reasoning
 * a reader would otherwise reconstruct and believe. It is history now.
 *
 * ---
 *
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
 * reading is tempting, since nothing else is out there to want the touch, and it
 * will look like an obvious improvement to whoever reads this next. It is
 * rejected for the case §5 designs for: an iPad flat on a table collects resting
 * palms at the screen edges, and because a target belongs to one pointer at a
 * time (§5, multi-touch), the first palm to land would own the wind and every
 * deliberate ring drag after it would get nothing at all.
 *
 * Worth spelling out because of how that failure would arrive: not as a bug
 * anyone could diagnose, but as "the wind control sometimes doesn't work" —
 * intermittent, dependent on where someone's hand happened to be resting, and
 * gone by the time anyone looked.
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
  return magnitude(subtract(mainClewPosition(state.trim.mainAngle), liveJibClew(state)));
}

/**
 * The jib's clew where it actually is, belly and all.
 *
 * The grab disc has to sit on the drawn clew, and the drawn clew rides the
 * *chord* rather than the cloth's full length now (`model/sail.ts`'s
 * `chordForArc`). Taking the default here instead would put the target a few
 * centimetres outboard of the mark a student is reaching for — small, and
 * exactly the kind of small that reads as "it didn't take my finger".
 */
function liveJibClew(state: SimState): Vec2 {
  const apparent = apparentWind(state.wind, state.motion);
  return jibClewPosition(state.trim.jibAngle, jibChord(state.trim.jibAngle, apparent));
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
  // PROTOTYPE — there is no annulus any more. The wind is the fall-through in
  // {@link beginGrab}, so its region is everything the boat does not claim,
  // which has no inner or outer edge to state. Reported as a disc reaching well
  // past any viewport so `render/geometry.ts` can still draw the region, and so
  // the two constants above still have somewhere to be read.
  void grab;
  void band;
  return { inner: 0, outer: SCENE.shortRadius * 3 };
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
 *
 * `radiusOffset` is the same correction on the radial axis, and only the wind
 * has one. It is metres of *radius*, not of speed, so the two halves of a wind
 * drag are corrected in the same coordinates the pointer moves in.
 */
export interface Grab {
  readonly target: GrabTarget;
  readonly offset: Radians | null;
  readonly radiusOffset?: Meters;
}

/**
 * PROTOTYPE — whether a wind drag's radius is *absolute* (the arrow's tail
 * lands under the finger the instant it touches down) or *relative* (the arrow
 * keeps its length and follows the finger from where it was).
 *
 * The one thing about this design that cannot be reasoned out from a
 * description, so it is a switch rather than a decision. Relative is the
 * default because it matches every other gesture in the simulator — §5's "drags
 * preserve where you grabbed" — and because it is what makes an accidental
 * touch cost nothing: a finger that lands on the water and does not move
 * changes no wind at all. Under absolute, the same stray touch snaps the wind
 * to wherever the hand happened to land, which is §5's objection to giving the
 * open water away, arriving by a different road.
 */
export const RADIAL = { absolute: false };

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
  /**
   * The target's **second** degree of freedom, if it has one. Only the wind
   * does: the same drag that sweeps its bearing round the origin sets its speed
   * by how far out it is.
   *
   * That the two are one gesture is the design rather than a compromise. A ring
   * that meant bearing going round and speed going in and out was §5's argument
   * *against* dragging the arrow's length — an argument made when the target was
   * a thin annulus, where the radial half had almost no travel to work in. Given
   * the whole water it has the full radius, and the coupling turns out to be
   * mild in the hand: motion along a circle about the origin is pure bearing,
   * motion along a radius is pure speed, and a hand drawing an arc does the
   * first without being asked to.
   */
  readonly radial?: {
    /** The radius the state's current value already stands at. */
    readonly radius: Meters;
    /** The state with the value that radius asks for. */
    applyRadius(state: SimState, radius: Meters): SimState;
  };
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
        radial: {
          radius: radiusForWind(state.wind.speed),
          applyRadius: (of, radius) => {
            // `speedForRadius` clamps to the control's range at both ends.
            // Under the default inward polarity that means dragging to the
            // centre holds at 20 kt and dragging out past the ring floors at a
            // calm — the opposite way round from what this comment used to say,
            // which is the one behaviour a reader would check it for.
            const speed = speedForRadius(radius);
            // Identity when nothing moved, because `input/pointer.ts` compares
            // by identity to decide whether a move was worth writing. A drag
            // held against the clamp would otherwise report a change every frame.
            if (speed === of.wind.speed) return of;
            return { ...of, wind: { ...of.wind, speed } };
          },
        },
      };
  }
}

/** How far the pointer is from a target's centre, in that target's frame. */
function radiusOn(axis: Axis, world: Vec2, heading: Radians): Meters {
  const point = axis.boatFrame ? toBoatPoint(world, heading) : world;
  return magnitude(subtract(point, axis.centre));
}

/** The pointer's bearing about a target's centre, or `null` inside the dead zone. */
function bearingOn(axis: Axis, world: Vec2, heading: Radians, deadZone: Meters): Radians | null {
  const point = axis.boatFrame ? toBoatPoint(world, heading) : world;
  const offset = subtract(point, axis.centre);
  return magnitude(offset) < deadZone ? null : angleOfVector(offset);
}

/**
 * The radial correction a touchdown records, so a drag preserves the length it
 * grabbed exactly as it preserves the angle. Zero under {@link RADIAL}.absolute,
 * which is what makes the arrow's tail snap to the finger.
 */
function radialOffsetFor(axis: Axis, world: Vec2, heading: Radians): Meters {
  if (axis.radial === undefined || RADIAL.absolute) return 0;
  return axis.radial.radius - radiusOn(axis, world, heading);
}

/** The grab with its offsets taken afresh from where the pointer is now. */
function reference(grab: Grab, state: SimState, world: Vec2, deadZone: Meters): Grab {
  const axis = axisFor(grab.target, state);
  const radiusOffset = radialOffsetFor(axis, world, state.motion.heading);
  const bearing = bearingOn(axis, world, state.motion.heading, deadZone);
  if (bearing === null) return { target: grab.target, offset: null, radiusOffset };
  return {
    target: grab.target,
    offset: normalizeSigned(axis.angle - axis.fromBearing(bearing)),
    radiusOffset,
  };
}

/**
 * Whether a **world-frame** point lies in the wind ring's hit band.
 *
 * **DEAD** — nothing in the app calls this; the wind is the fall-through now.
 * Read only by the tests pos-d0w will rewrite, and removable with them.
 */
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
 * **Anything else is the wind**, which is the reverse of what this docblock
 * used to say. It said open water returned `null` and the pointer was left
 * alone, on the argument that a touch given to the nearest anything is how a
 * student ends up turning a boat they meant to miss. That argument is answered
 * in DESIGN §5: the water is a control now, and it is safe to give away because
 * a drag references itself relatively — a finger that lands and does not move
 * changes nothing at all.
 *
 * `null` survives as the *narrow* case: a clew disc another finger holds, or the
 * deck while the hull is held. Both are blocks rather than gaps.
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
        ["jib", liveJibClew(state)],
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

  if (insideHull(point)) {
    // **The deck is the boat's whether or not the hull is free.** A second finger
    // landing on a held deck used to fall through to the wind, so a pointer
    // demonstrably *on the boat* drove a world-frame control — which is exactly
    // the "everything else is the wind" rule failing the one case where it is
    // visibly untrue. Blocking is the quiet answer, and it is the same answer a
    // clew disc already gives to a second finger.
    if (taken.has("hull")) return null;
    return reference({ target: "hull", offset: null }, state, world, scale.deadZone);
  }

  // **Everything else is the wind**, and it is deliberately last: the water is
  // the fall-through, so the boat's targets are never contended for and the wind
  // gets whatever is left. That is the whole of "the manipulation layer sits
  // beneath the boat" — there is no drawn layer to sit beneath, because
  // hit-testing here is geometric and reads no element at all. Paint order and
  // arbitration order are separate facts, and this is the one that decides.
  //
  // **The wind is not exclusive**, and that is what makes claiming the whole
  // surface survivable. §5's objection to giving away the water outside the ring
  // was the resting palm: a target belongs to one pointer at a time, so the
  // first palm down would own the wind and every deliberate drag after it would
  // get nothing. Giving the wind to *every* pointer that asks dissolves it —
  // a palm that never moves never moves the wind, and a finger that does is
  // never blocked by it. `reapply` re-references the still ones rather than
  // re-applying them, so the held offsets stay fresh and no pointer fights
  // another for the same number.
  return reference({ target: "wind", offset: null }, state, world, scale.deadZone);
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

  // The radial half runs first and runs unconditionally. A radius has no
  // singularity at the centre the way a bearing does, so the dead zone — which
  // exists because the angular gain rises without bound there — has nothing to
  // say about it. Dragging a finger into the middle of the boat is a legitimate
  // way to ask for a calm even though it is no way at all to ask for a bearing.
  const radial = axis.radial;
  const afterRadius =
    radial === undefined
      ? state
      : radial.applyRadius(
          state,
          radiusOn(axis, world, state.motion.heading) + (grab.radiusOffset ?? 0),
        );

  if (bearing === null) {
    return {
      state: afterRadius,
      grab: { target: grab.target, offset: null, radiusOffset: grab.radiusOffset },
    };
  }
  if (grab.offset === null) {
    return { state: afterRadius, grab: reference(grab, afterRadius, world, deadZone) };
  }
  // Re-derived against the state the radial half just produced, so the angular
  // half writes on top of it rather than over it.
  const settled = axisFor(grab.target, afterRadius);
  return {
    state: settled.apply(afterRadius, settled.fromBearing(bearing) + grab.offset),
    grab,
  };
}

/**
 * A touchdown on a sail is **a hand on the boom**, so the model stops moving it.
 *
 * `mainHeld` has been in `SimState` since it was added and inert until now
 * (§3.4). This is the seam it was left for: while a finger is down the boom is
 * where the finger says, and the wind does not get a vote.
 */
export function holdFor(state: SimState, target: GrabTarget): SimState {
  if (target === "main") return { ...state, mainHeld: true };
  if (target === "jib") return { ...state, jibHeld: true };
  return state;
}

/**
 * Letting go of the boom: **the angle you were holding becomes the sheet.**
 *
 * That is the whole of the gesture's new meaning, and it is what a hand on a
 * mainsheet actually does — you haul the boom to where you want it and cleat it
 * there, and what you have set is how far out it may go, not where it will be.
 * The boom then goes wherever the wind and that limit put it
 * ({@link naturalMainAngle}), which is usually exactly where you left it, and
 * occasionally somewhere you have to think about:
 *
 * - Drag it **in** and let go: the wind is still pushing out, so it stays. The
 *   ordinary case, and it feels like nothing changed — which is right.
 * - Drag it **out past the apparent wind** and let go: the sheet is now slacker
 *   than the wind angle, so the boom stops at the weathervane and the sail
 *   flogs. Ease too much and it luffs, which is the lesson.
 * - Drag it **across to windward** and let go: the sheet is `|angle|`, the wind
 *   is on the other side, so it swings to the *mirror* — same trim, other tack.
 *   pos-bql.2's swing-back, with no swing-back code.
 *
 * The magnitude is what is kept, deliberately. A sheet has no sign; taking one
 * from the drag would make the rope remember which side of the boat it had been
 * on, which is the thing about the old model this replaces.
 */
export function releaseFrom(state: SimState, target: GrabTarget, world: Vec2): SimState {
  if (target === "main") {
    return {
      ...state,
      mainHeld: false,
      trim: { ...state.trim, mainSheet: Math.abs(state.trim.mainAngle) },
    };
  }
  if (target === "jib") {
    // **Which side the hand let go on chooses the working sheet**, and it is the
    // only thing that ever does (`RigTrim.jibSheetSide`). Dragging the clew
    // across and releasing on the new side is therefore one gesture that casts
    // off one sheet and hauls the other — which is the real foredeck action, and
    // it needs no second control to express.
    //
    // Taken from the pointer's own position rather than from where the clew
    // ended up, because those disagree exactly when it matters: a clew dragged
    // near the centreline is ambiguous while the hand holding it is not.
    // A release on the centreline itself keeps the side it had, so nothing
    // flips on a rounding difference.
    const at = toBoatPoint(world, state.motion.heading);
    const side = at.x === 0 ? state.trim.jibSheetSide : Math.sign(at.x);
    return {
      ...state,
      jibHeld: false,
      trim: {
        ...state.trim,
        jibSheetSide: side,
        // Measured against the clew where it actually is, belly and all — the
        // same chord the model will use on the next frame, so letting go does
        // not move the sail.
        jibSheet: jibSheetFor(
          state.trim.jibAngle,
          side,
          jibChord(state.trim.jibAngle, apparentWind(state.wind, state.motion)),
        ),
      },
    };
  }
  return state;
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
    // **The wind is re-referenced, not re-applied.** It is the one non-exclusive
    // target, so several pointers may hold it at once, and re-applying a still
    // one would write back the wind it grabbed and undo the drag the moving one
    // just made. Re-referencing instead updates its offsets to the wind as it
    // now is, so that pointer picks up smoothly from here if it ever moves.
    if (one.grab.target === "wind") {
      return { grab: reference(one.grab, next, one.at, deadZone), at: one.at };
    }
    const result = dragTo(next, one.grab, one.at, deadZone);
    next = result.state;
    return { grab: result.grab, at: one.at };
  });
  return { state: next, held: updated };
}
