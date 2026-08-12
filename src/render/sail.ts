/**
 * The two sails: a chord, a camber, and the seam the luffing animation hangs on
 * (DESIGN.md §4.1).
 *
 * Everything here is in **boat-frame metres**, like `render/hull.ts` — the sails
 * mount on `scene.layers.sails`, which rides inside the boat group, so the
 * heading rotation is somebody else's problem. Both chords come straight out of
 * `model/boat.ts`; nothing about the rig geometry is re-derived here.
 *
 * ## Which side the sail bulges
 *
 * The camber offset runs along `perpendicular(chordDirection)` — 90° clockwise
 * of tack→clew — scaled by a signed depth whose sign is `sin α`. That is not a
 * convention, it is forced, and the one-line proof is worth keeping because it
 * is also the acceptance criterion:
 *
 * ```text
 * chordBearing = π − sailAngle          flowBearing = chordBearing + α
 * dot(perpendicular(chordUnit), flowUnit) = cos((chordBearing + 90°) − flowBearing)
 *                                         = cos(90° − α) = sin α
 * ```
 *
 * so an offset of `sin α · perpendicular(chordUnit)` has dot product `|sin α|`
 * with the direction the wind is blowing *toward*: **the belly is on the
 * downwind side of the chord at every trim, on either tack, by construction.**
 * A test asserts it over a grid rather than at a few spot checks.
 *
 * Note what that says about the acceptance criterion's wording: crossing the
 * *centreline* does not flip the bulge — crossing the *wind* does. A boom swept
 * from port to starboard under a beam wind keeps its belly to leeward the whole
 * way.
 *
 * **The invariant is against the flow, not against lift.** They agree wherever
 * the flow is attached, but `foil.ts`'s flat-plate limb makes `Cl = 2 sinα cosα`,
 * which reverses at |α| = 90° where the belly does not. Anchoring the rule to
 * lift would leave a reader thinking the sign needs a second case past the
 * stall. It does not.
 *
 * ## Why `sin α` sets the depth and not just the sign
 *
 * `sin α` is the component of the flow across the chord, which is the thing that
 * inflates a sail, and using it whole rather than only for its sign buys two
 * knife edges for nothing:
 *
 * - **α → 0** — the sail is edge-on and luffing. Depth → 0, so the side flip at
 *   the luff happens through a flat sail and is invisible.
 * - **α → ±180°** — the flow arrives at the leech instead (a boom eased to
 *   starboard with the wind on the starboard beam; `foil.ts` contemplates this
 *   case explicitly, and `Cl = 0, Cd = Cd0` there — a flogging sail making
 *   nothing). Depth → 0 again, so there is no pop there either. This case is
 *   easy to miss: `luffFraction` is blind to it, reporting a fully-drawing sail,
 *   so `(1 − luffFraction)` alone would draw full camber on an arbitrary side
 *   and flip it as α crossed 180°.
 *
 * The visible consequence, chosen deliberately: a close-hauled sail reads
 * distinctly flatter than a reaching one. That is true on the water.
 *
 * ## The camber really is a Bézier arc
 *
 * §4.1 asks for a Bézier, and with the two control points placed at exactly 1/3
 * and 2/3 *along the chord*, the curve's chordwise coordinate is
 *
 * ```text
 * u(t) = (1−t)²t + 2(1−t)t² + t³ = t     identically
 * ```
 *
 * so the curve parameter **is** the chord fraction. Sampling uniformly in `s`
 * therefore lands exactly on the cubic rather than near it, which is what lets
 * {@link sailPathData} emit the bare Bézier when nothing is deforming it and a
 * sampled polyline when something is, with no discontinuity between the two.
 * `sail.test.ts` pins the two against each other to 1e-12.
 *
 * ## Drawing taste stays here
 *
 * The draft fractions and the pressure reference below are drawing decisions and
 * live in this file, not in `model/tuning.ts`, for the reason `hull.ts` gives
 * about its fairing constants: that file's job is to separate physics from taste
 * *in the model*, and camber affects no force. Nothing in `render/` feeds back
 * into what the boat does.
 */

import type { Sail } from "../model/boat.ts";
import { JIB, MAIN, STATIONS, jibClewPosition, mainClewPosition } from "../model/boat.ts";
import { angleOfAttack, dynamicPressure, luffFraction } from "../model/sail.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, Radians, Vec2 } from "../model/units.ts";
import {
  add,
  knotsToMetersPerSecond,
  magnitude,
  perpendicular,
  scale,
  sin,
  subtract,
} from "../model/units.ts";
import type { ApparentWind } from "../model/wind.ts";
import { apparentWind } from "../model/wind.ts";
import { cubicTo, type CubicSegment } from "./hull.ts";
import type { Layer } from "./scene.ts";
import { formatNumber, svgElement } from "./svg.ts";

// --- Drawing taste ----------------------------------------------------------

/**
 * Peak camber as a fraction of the chord, reached at α = 90° in full pressure.
 *
 * Deliberately over-drawn: real mains carry 8–12%, and what a student has to see
 * here is not a draft number but *which side the sail is on*. The binding case
 * is the jib on a phone, where the chord is ~74 px; at 10% that is 7 px of
 * deviation carrying a ~2.4 px stroke, which reads as a bent line rather than a
 * sail. This is the knob to move by eye against the running drawing.
 */
const MAX_DRAFT_FRACTION = 0.16;

/**
 * Where the deepest point sits along the chord, as a fraction from the luff.
 *
 * Draft carried forward is most of what makes an abstract arc read as a sail
 * rather than a lens. The jib's sits further forward than the main's, which is
 * both true of headsails and enough to tell the two shapes apart at a glance.
 *
 * Must stay above 1/3: at exactly 1/3 the after handle falls to zero and below
 * it the handle goes negative, which would put an S-bend in the sail.
 */
const DRAFT_POSITION_MAIN = 0.45;
const DRAFT_POSITION_JIB = 0.38;

/**
 * The apparent wind speed at which the sail holds half its camber.
 *
 * Deliberately low, and this is the one place §4.1's "camber depth is a function
 * of … apparent wind pressure" wants reading carefully. Taken as a *growth* law
 * it teaches the wrong lesson: a real sail in 15 kt is flatter than the same
 * sail in 5 kt, because you flatten it. The honest job of this factor is a
 * soft-sail floor near calm — a drifter, where the cloth hangs and makes
 * nothing — and nothing else. At 3 kt the curve gives exactly that: from 8 kt to
 * 20 kt of apparent wind the depth moves by a tenth, about a pixel, while below
 * 5 kt it visibly softens and at a flat calm the sail is a straight line.
 */
const CAMBER_HALF_PRESSURE_SPEED = knotsToMetersPerSecond(3);

/** Chord intervals in the deformed polyline. See {@link sailPathData}. */
export const SAIL_SAMPLES = 32;

// --- The camber profile -----------------------------------------------------

/**
 * The Bézier handle weights that put the profile's peak at `position` with a
 * peak value of exactly 1.
 *
 * Both handles are normal offsets on a curve whose chordwise handles are pinned
 * at 1/3 and 2/3, so the profile is `B(s) = 3s(1−s)[(1−s)·luff + s·leech]`.
 * Writing `leech = (1 + k)·luff` and asking for `B′(position) = 0` gives
 * `k = (2p − 1) / (p(2 − 3p))` in closed form; the peak value then normalises
 * both. Solved rather than typed in, so moving a draft position moves the shape
 * instead of quietly moving the depth as well.
 */
interface HandleWeights {
  readonly luff: number;
  readonly leech: number;
}

function handleWeights(position: number): HandleWeights {
  const k = (2 * position - 1) / (position * (2 - 3 * position));
  const peak = 3 * position * (1 - position) * (1 + k * position);
  return { luff: 1 / peak, leech: (1 + k) / peak };
}

/** The profile once its weights are already solved. */
function profileAt(weights: HandleWeights, s: number): number {
  return 3 * s * (1 - s) * ((1 - s) * weights.luff + s * weights.leech);
}

/** The straight line a sail's camber is measured from, and how deep it bulges. */
export interface SailShape {
  /** `s = 0`: the luff. The mast for the main, {@link STATIONS.jibTack} for the jib. */
  readonly tack: Vec2;
  /** `s = 1`: the clew. */
  readonly clew: Vec2;
  /**
   * Signed peak camber, in metres. Positive bulges 90° clockwise of the
   * tack→clew bearing; the module docblock proves that is always leeward.
   */
  readonly depth: Meters;
  /** Where the peak sits along the chord, 0..1 from the luff. */
  readonly draftPosition: number;
  /**
   * How much of the sail has collapsed, from the luff aft — the model's number,
   * carried through untouched for pos-dmg.2. `s < luffFraction` is the
   * fluttering region, because `s` and this are measured on the same axis.
   */
  readonly luffFraction: number;
}

/**
 * The camber's shape, unscaled: 0 at the luff, exactly 1 at the draft position,
 * 0 at the clew, and strictly positive between.
 */
export function camberProfile(chordFraction: number, draftPosition: number): number {
  return profileAt(handleWeights(draftPosition), chordFraction);
}

/**
 * How hard the wind is pressing the cloth into shape, 0..1.
 *
 * `q / (q + q_half)` — monotone, smooth, saturating, and needing no clamp. Since
 * `q ∝ V²` this is `V²/(V² + V_half²)`, but writing it in pressure reads truer
 * to §4.1 and costs nothing.
 */
export function pressureFactor(q: number): number {
  const half = dynamicPressure(CAMBER_HALF_PRESSURE_SPEED);
  return q / (q + half);
}

/**
 * Signed peak camber for a trim.
 *
 * ```text
 * depth = foot · MAX_DRAFT_FRACTION · (1 − luffFraction) · pressureFactor(q) · sin α
 * ```
 *
 * `(1 − luffFraction)` is what ties the drawing to the model: §3.3 asks that one
 * number drive both the flutter and the force reduction, and this makes it drive
 * the depth too, so what the student sees and what the boat does cannot
 * disagree. `sin α` supplies the side and the two edge-on collapses; see the
 * module docblock.
 */
export function camberDepth(sail: Sail, sailAngle: Radians, apparent: ApparentWind): Meters {
  const alpha = angleOfAttack(sailAngle, apparent);
  return (
    sail.foot *
    MAX_DRAFT_FRACTION *
    (1 - luffFraction(alpha)) *
    pressureFactor(dynamicPressure(apparent.speed)) *
    sin(alpha)
  );
}

function shapeOf(
  sail: Sail,
  sailAngle: Radians,
  tack: Vec2,
  clew: Vec2,
  draftPosition: number,
  apparent: ApparentWind,
): SailShape {
  return {
    tack,
    clew,
    depth: camberDepth(sail, sailAngle, apparent),
    draftPosition,
    luffFraction: luffFraction(angleOfAttack(sailAngle, apparent)),
  };
}

/** The main: chord from the mast to the boom end, which is also the drawn boom. */
export function mainShape(mainAngle: Radians, apparent: ApparentWind): SailShape {
  return shapeOf(
    MAIN,
    mainAngle,
    STATIONS.mast,
    mainClewPosition(mainAngle),
    DRAFT_POSITION_MAIN,
    apparent,
  );
}

/**
 * The jib: chord from its **tack** to its clew.
 *
 * Not from the stemhead. `STATIONS.jibTack` sits half a foot abaft the bow
 * because the tack rides a foot up a stay that rakes aft (§4.1), and the clew
 * swings about the tack — drawing to the bow would put a curve on the wrong
 * radius and leave a gap that looks like a bug.
 */
export function jibShape(jibAngle: Radians, apparent: ApparentWind): SailShape {
  return shapeOf(
    JIB,
    jibAngle,
    STATIONS.jibTack,
    jibClewPosition(jibAngle),
    DRAFT_POSITION_JIB,
    apparent,
  );
}

/**
 * Both sails for a state — the renderer's one entry point.
 *
 * The jib is `null` when it is struck, so a caller cannot draw a sail that is
 * not there (§3.7). Derives the apparent wind itself: it is ten flops, it keeps
 * `Layer.update(state)` as the whole contract, and it keeps `SimState` free of
 * render caches. When pos-dmg.1 and pos-dmg.3 make a per-frame derived bundle
 * worth sharing, this is the one call site to change.
 *
 * Note what it does *not* call: `sailForce` and `rigForce` would compute foil
 * coefficients and a driving force the drawing throws away. Camber depends on no
 * force at all, which is what keeps this module clear of the trim-quality
 * machinery pos-dmg.1 is about to add next door.
 */
export function rigShapes(state: SimState): { main: SailShape; jib: SailShape | null } {
  const apparent = apparentWind(state.wind, state.motion);
  return {
    main: mainShape(state.trim.mainAngle, apparent),
    jib: state.trim.jibSet ? jibShape(state.trim.jibAngle, apparent) : null,
  };
}

// --- Points and paths -------------------------------------------------------

/**
 * A per-point deformation of the sail, for pos-dmg.2's travelling sine.
 *
 * `chordFraction` runs 0 at the luff to 1 at the clew — **the same axis
 * `luffFraction` is measured on**, so the fluttering region is literally
 * `s < shape.luffFraction`. `camberOffset` is the undeformed offset there, in
 * metres, already signed.
 *
 * **It returns a replacement, not an addend, and that is load-bearing.** §4.1
 * wants the collapsed forward portion to go flat while the after portion keeps
 * its camber, so pos-dmg.2 needs to write `offset · collapse(s) + ripple(s)` —
 * an addend hook could not attenuate what it was given and would have forced a
 * rewrite of exactly the code this seam exists to protect.
 *
 * Two deliberate limits. The hook is **never called at the endpoints**: the tack
 * and clew are physical attachments, and the clew is pos-bwd.1's grab point, so
 * a flutter cannot walk the touch target off the drawn sail. And it displaces
 * only *normal* to the chord — an inextensible-cloth correction is second order
 * at this size, and along-chord motion would break the monotone `s ↦ chord
 * fraction` map a travelling wave's phase depends on. If it is ever wanted,
 * widening the return type to `{ along, normal }` is an extension rather than a
 * rewrite.
 */
export type SailDeformation = (chordFraction: number, camberOffset: Meters) => Meters;

/**
 * The chord as a vector, and the **unit** normal the camber runs along.
 *
 * `along` is the whole chord, because a chord fraction scales it directly;
 * `normal` is normalised, because a camber is a length in metres and must not
 * pick up a factor of the chord. Both are taken from the drawn endpoints rather
 * than from `sailChordBearing`, so the normal is exactly perpendicular to the
 * line on screen — and so this file needs no trigonometry to find it.
 */
function frame(shape: SailShape): { along: Vec2; normal: Vec2 } {
  const along = subtract(shape.clew, shape.tack);
  return { along, normal: scale(perpendicular(along), 1 / magnitude(along)) };
}

/**
 * The exact cubic §4.1 asks for, with its handles at 1/3 and 2/3 along the
 * chord. Exposed as *data* rather than only as a `d` string, the way
 * `hull.ts` exposes its outline, so a test can measure it.
 */
export function sailBezier(shape: SailShape): CubicSegment {
  const { along, normal } = frame(shape);
  const { luff, leech } = handleWeights(shape.draftPosition);
  return {
    control1: add(add(shape.tack, scale(along, 1 / 3)), scale(normal, luff * shape.depth)),
    control2: add(add(shape.tack, scale(along, 2 / 3)), scale(normal, leech * shape.depth)),
    end: shape.clew,
  };
}

/**
 * One point, from a frame and weights the caller already has.
 *
 * Both are pure functions of the `SailShape`, and neither changes across a
 * sweep of `s` — so the loop in {@link sailPoints} solves them once rather than
 * paying for a `hypot`, a divide and the handle quadratic at every sample. That
 * costs nothing today, because an undeformed sail emits the bare Bézier and
 * never samples at all; it is worth doing now because the moment pos-dmg.2
 * passes a deformation this becomes 31 redundant solves a frame, per sail, and
 * the seam it would be paid on is the one this bead exists to leave clean.
 */
function pointAt(
  shape: SailShape,
  chord: { along: Vec2; normal: Vec2 },
  weights: HandleWeights,
  s: number,
  deform?: SailDeformation,
): Vec2 {
  const camber = shape.depth * profileAt(weights, s);
  const offset = deform === undefined ? camber : deform(s, camber);
  return add(add(shape.tack, scale(chord.along, s)), scale(chord.normal, offset));
}

/** The drawn point at a chord fraction, with any deformation applied. */
export function sailPoint(shape: SailShape, s: number, deform?: SailDeformation): Vec2 {
  return pointAt(shape, frame(shape), handleWeights(shape.draftPosition), s, deform);
}

/**
 * `SAIL_SAMPLES + 1` points from tack to clew, endpoints exactly on their
 * stations.
 */
export function sailPoints(shape: SailShape, deform?: SailDeformation): Vec2[] {
  const chord = frame(shape);
  const weights = handleWeights(shape.draftPosition);

  const points: Vec2[] = [shape.tack];
  for (let i = 1; i < SAIL_SAMPLES; i += 1) {
    points.push(pointAt(shape, chord, weights, i / SAIL_SAMPLES, deform));
  }
  points.push(shape.clew);
  return points;
}

function moveTo(point: Vec2): string {
  return `M ${formatNumber(point.x)} ${formatNumber(point.y)}`;
}

/**
 * The sail's curve as SVG path data, in metres.
 *
 * Two emitters over one curve. With nothing deforming it the exact cubic goes
 * out — six numbers, and §4.1's "Bézier arc" is literally what lands in the DOM.
 * With a deformation it is sampled at {@link SAIL_SAMPLES} intervals and emitted
 * as a polyline.
 *
 * They are the same curve, not two approximations of one: the `u(t) ≡ t`
 * identity above means the samples sit *on* the Bézier, and `sail.test.ts` pins
 * that to 1e-12 so the sampler can never drift into being a second definition of
 * the shape. What is left is faceting between samples, which at 32 intervals is
 * 0.4 mm on the base camber — a fortieth of a pixel — so a flutter fading in
 * cannot pop. `stroke-linejoin: round` covers the rest.
 */
export function sailPathData(shape: SailShape, deform?: SailDeformation): string {
  if (deform === undefined) {
    return `${moveTo(shape.tack)} ${cubicTo(sailBezier(shape))}`;
  }
  const points = sailPoints(shape, deform);
  return points
    .map((point, index) =>
      index === 0 ? moveTo(point) : `L ${formatNumber(point.x)} ${formatNumber(point.y)}`,
    )
    .join(" ");
}

// --- The drawn layer --------------------------------------------------------

/** Set on the jib's group when the jib is struck; `scene.css` hides it. */
const STRUCK_CLASS = "pos-struck";

/** One sail's group and the path its cloth is drawn on. */
function createSail(className: string): { group: SVGGElement; cloth: SVGPathElement } {
  const group = svgElement("g", { class: `pos-sail ${className}` });
  const cloth = svgElement("path", {
    class: "pos-sailcloth",
    "vector-effect": "non-scaling-stroke",
  });
  group.append(cloth);
  return { group, cloth };
}

/**
 * Both sails, as a layer for `main.ts` to mount on `scene.layers.sails`.
 *
 * The jib group is drawn after the main so the smaller shape is not lost beneath
 * the larger one, and it is hidden by class rather than by a `display`
 * presentation attribute. That is the *inverse* of §4.5's belt-and-braces
 * argument for `vector-effect`, and deliberately so: `display: none` is
 * universally supported, so there is no failure to guard against, while a
 * presentation attribute loses to any CSS rule that later touches the same
 * property. Hiding rather than unmounting also keeps the node identity stable
 * across a switch a student may flip repeatedly — and `display: none` is
 * genuinely absent from rendering, hit-testing and the accessibility tree, which
 * is what "absent entirely" has to mean for pos-bwd.1.
 *
 * pos-dmg.2 widens `update` to take an elapsed time; a method with a defaulted
 * second parameter stays assignable to {@link Layer}, so `scene.ts` need not
 * change for it.
 */
export function createSailLayer(): Layer {
  const element = svgElement("g", { class: "pos-rig" });
  const main = createSail("pos-main");
  const jib = createSail("pos-jib");

  // The boom is a `<line>` rather than a path because the mast end never moves,
  // so only x2/y2 are rewritten per frame. It goes in *before* the cloth: the
  // sail is the subject and the spar is a reference line under it.
  const boom = svgElement("line", {
    class: "pos-boom",
    x1: STATIONS.mast.x,
    y1: STATIONS.mast.y,
    "vector-effect": "non-scaling-stroke",
  });
  main.group.prepend(boom);

  element.append(main.group, jib.group);

  return {
    element,
    update(state: SimState): void {
      const shapes = rigShapes(state);

      boom.setAttribute("x2", formatNumber(shapes.main.clew.x));
      boom.setAttribute("y2", formatNumber(shapes.main.clew.y));
      main.cloth.setAttribute("d", sailPathData(shapes.main));

      // Struck: hidden, and no stale geometry computed or written for it.
      jib.group.classList.toggle(STRUCK_CLASS, shapes.jib === null);
      if (shapes.jib === null) return;
      jib.cloth.setAttribute("d", sailPathData(shapes.jib));
    },
  };
}
