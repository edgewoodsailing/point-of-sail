/**
 * The two sails: a chord, a camber, the trim-quality ratio the traffic light
 * reads, and the seam the luffing animation hangs on (DESIGN.md §4.1, §4.2).
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
 *   easy to miss, and when this module was written it had to carry it alone:
 *   `luffFraction` was blind to the leech-first state and reported a fully
 *   drawing sail, so `(1 − luffFraction)` would have drawn full camber on an
 *   arbitrary side and flipped it as α crossed 180°. pos-aa2 has since folded
 *   §3.3 about 90° too, so the two now agree rather than one covering for the
 *   other — but `sin α` is still what supplies the *side*, and it collapses the
 *   depth over a far wider band than the 7° §3.3 collapses over, so it stays.
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
 * ## The traffic light's ratio
 *
 * §4.2's colour scale is a *ratio of driving forces*, not an angular error, and
 * {@link trimQuality} is the whole of it: what this sail is driving with,
 * divided by what the best trim at this apparent wind would drive with. The
 * division happens here and the colour happens in `render/palette.ts`; neither
 * knows about the other's half.
 *
 * It sits in this module rather than in `model/sail.ts` because it is not
 * physics: the model already answers both halves — `sailForce` and
 * `optimalTrim` — and nothing the boat does depends on the ratio between them.
 * It is a thing the drawing says about the model, which is exactly the line
 * §6 draws between the two directories.
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
import {
  angleOfAttack,
  dynamicPressure,
  luffFraction,
  optimalTrim,
  sailForce,
} from "../model/sail.ts";
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
import { setSailInk } from "./palette.ts";
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
   *
   * **One band where that axis is wrong, and pos-dmg.2 should know before it
   * wires the shake.** Past |α| = 173° the flow arrives at the leech (§3.3
   * collapses the sail there too, since pos-aa2), and the cloth breaks at the
   * *leech* and runs forward — so `s < luffFraction` shakes the forward end of
   * a sail whose after end is the one letting go. It is not a sliver: the
   * fraction is 0.35 at α = 175° and only reaches 1 at 178°. pos-83f owns
   * reporting which end it breaks from and drawing it that way.
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

// --- Trim quality -----------------------------------------------------------

/**
 * The drive coefficient below which no trim is a good trim.
 *
 * A *coefficient* — `driving / (q·A)` — rather than a force in newtons, and
 * that is the whole reason this constant is safe to have. Driving force scales
 * with dynamic pressure, so a floor of "so many newtons" would be a floor on
 * the wind: perfectly trimmed sails would refuse to go green in light air and
 * the ramp would be answering a question nobody asked. Divided out, the same
 * number means the same thing at 2 kt as at 25 kt — measured, not assumed;
 * `sail.test.ts` sweeps a grid of trims at four wind speeds and pins the
 * quality to the same value at each.
 *
 * 0.05 is reached at an apparent wind angle of 8.2°, deep inside the no-go
 * zone: the main's peak coefficient is 0.006 at AWA 5°, 0.047 at 8°, 0.21 at
 * 15°, 0.59 at 30° and 1.57 on a beam reach. So it binds only where the answer
 * is "bear away", and every point of sail a student can actually sail is
 * untouched by it — see {@link trimQuality} for what it does when it binds.
 */
const MINIMUM_USEFUL_DRIVE_COEFFICIENT = 0.05;

/**
 * §4.2's traffic light, as a number: this trim's driving force over the best
 * available at this apparent wind.
 *
 * Keyed to force rather than to angle, which is the pedagogical point. A fixed
 * 10° error would look equally bad everywhere if the scale were angular; keyed
 * to force the falloff is sharp where the physics is sharp and forgiving where
 * it is forgiving, because it *is* the physics. Measured on the main in 10 kt:
 * close hauled the quality falls below 0.8 within 5.25° of sheeting in past
 * the optimum and 6.25° of easing past it, where on a run it survives 27°; the
 * 0.5 contour is 8.75° and 12.25° against 45.75°. Nothing states that rule
 * anywhere; it falls out of the ratio.
 *
 * **The denominator is floored, and only where the optimum itself is vanishing.**
 * `optimalTrim` reports the honest in-irons answer — a non-positive best
 * force, and exactly zero below AWA 4.3°: the main is still at zero *at* 4.3°
 * and first drives at 4.4°, with 0.06 N, while the jib crosses a tenth of a
 * degree sooner. Not because everything luffs there — a boom right out at AWA
 * 4° is fully attached, and pulling 200 N *astern*. Every trim that holds its
 * shape drives backwards, so the maximum lands on a luffing trim at exactly
 * zero. That is handed to this side as §4.2's problem, and taken bare it is
 * 0/0 — worse than undefined:
 * a sail sitting on the optimum at AWA 5° would read *fully green* while making
 * 1 N and going nowhere, then snap to red as the best force crossed zero. So
 * the denominator is `max(best, MINIMUM_USEFUL_DRIVE_COEFFICIENT · q · A)`.
 * Above the floor — every point of sail — this is §4.2's ratio unchanged.
 * Below it the best trim can no longer read green but fades with what is
 * actually available: on the main, 0.13 of the ramp at AWA 5°, 0.36 at 6°,
 * 0.95 at 8°, full green at 8.2°. "No trim can save this" is the true lesson
 * in the no-go zone, and the fade is continuous through the boundary rather
 * than a threshold pretending to be one.
 *
 * **A flat calm is the one case with no answer at all**, since every trim ties
 * at zero force, so it returns 0 and paints red. Guarding on `q·A` rather than
 * on the forces is what keeps the sole division safe: the floor is positive
 * whenever there is any wind at all.
 *
 * The result is deliberately *not* clamped to `0..1`. Both ends overshoot in
 * normal use — a backed sail drives hard astern, and a trim between two samples
 * of the optimum search can beat it by a hair — and `render/palette.ts` owns
 * the fold onto the ramp, in one place, for the reasons its `clampQuality`
 * gives.
 */
export function trimQuality(sail: Sail, sailAngle: Radians, apparent: ApparentWind): number {
  // `q·A`: the force a coefficient of 1 would make on this sail in this wind,
  // and so what turns the coefficient above back into newtons.
  const forceScale = dynamicPressure(apparent.speed) * sail.area;
  if (!(forceScale > 0)) return 0;

  const best = optimalTrim(sail, apparent).driving;
  const driving = sailForce(sail, sailAngle, apparent).driving;
  return driving / Math.max(best, MINIMUM_USEFUL_DRIVE_COEFFICIENT * forceScale);
}

/** One sail's frame: the shape to draw and the quality to paint it with. */
export interface SailDrawing {
  readonly shape: SailShape;
  readonly quality: number;
}

/** Both sails. The jib is `null` when it is struck (§3.7). */
export interface RigDrawing {
  readonly main: SailDrawing;
  readonly jib: SailDrawing | null;
}

/**
 * Both sails for a state — the renderer's one entry point.
 *
 * The jib is `null` when it is struck, so a caller cannot draw a sail that is
 * not there (§3.7). Derives the apparent wind itself: it keeps
 * `Layer.update(state)` as the whole contract, and it keeps `SimState` free of
 * render caches. This is the per-frame derived bundle the shapes-only version
 * of this function predicted pos-dmg.1 would need; pos-dmg.3 adds the speed
 * arrow's reference to it the same way.
 *
 * The quality is what makes it cost anything: `optimalTrim` sweeps the sail's
 * legal range, so a frame is the 60–150 sail-force evaluations its own docblock
 * budgets for, against the handful the camber needs. Measured at 33 µs a sail,
 * which is the price §4.2 accepts when it calls the search negligible — and it
 * is why the two halves are computed together here rather than separately by
 * two callers, which would double it.
 */
export function rigDrawing(state: SimState): RigDrawing {
  const apparent = apparentWind(state.wind, state.motion);
  return {
    main: {
      shape: mainShape(state.trim.mainAngle, apparent),
      quality: trimQuality(MAIN, state.trim.mainAngle, apparent),
    },
    jib: state.trim.jibSet
      ? {
          shape: jibShape(state.trim.jibAngle, apparent),
          quality: trimQuality(JIB, state.trim.jibAngle, apparent),
        }
      : null,
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
      const rig = rigDrawing(state);

      boom.setAttribute("x2", formatNumber(rig.main.shape.clew.x));
      boom.setAttribute("y2", formatNumber(rig.main.shape.clew.y));
      main.cloth.setAttribute("d", sailPathData(rig.main.shape));
      // On the group, not the path: the property inherits down to the cloth,
      // and a later bead colouring a telltale or a clew handle inherits the
      // same value rather than deriving a second one (§4.2).
      setSailInk(main.group, rig.main.quality);

      // Struck: hidden, and no stale geometry or colour computed or written for
      // it. What is left behind on the group is stale, and harmlessly so — the
      // group is `display: none`, and the frame that unstrikes the jib rewrites
      // both before anything paints.
      jib.group.classList.toggle(STRUCK_CLASS, rig.jib === null);
      if (rig.jib === null) return;
      jib.cloth.setAttribute("d", sailPathData(rig.jib.shape));
      setSailInk(jib.group, rig.jib.quality);
    },
  };
}
