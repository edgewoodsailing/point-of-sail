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
 * inflates a sail. It has to supply the *side* — nothing else in the depth
 * expression is signed — and pos-83f re-measured whether it earns the rest of
 * its keep now that §3.3 collapses `(1 − collapsedFraction)` at *both* edge-on
 * states. It does, but not for the reason originally written here.
 *
 * **The two knife edges no longer need it**, and they were the original
 * argument. At α → 0 the sail is edge-on and luffing, and at α → ±180° the flow
 * arrives at the leech instead (a flogging sail making nothing; `foil.ts`
 * contemplates that case explicitly and reports `Cl = 0, Cd = Cd0`). The belly
 * changes sides at both, and `sin α` took the depth to zero so each flip
 * happened through a flat sail. Since pos-aa2 folded §3.3 about 90°,
 * `(1 − collapsedFraction)` is *already* 0 at both — not approaching 0 but
 * identically 0 across the whole plateau `|α| ≤ 2°` and `|α| ≥ 178°`, because
 * `smoothstep` clamps. Each flip therefore happens in the middle of a 2°-wide
 * band of exactly flat sail. Reduce `sin α` to `sign(sin α)` and both flips are
 * still invisible. (Resist quoting a slope at those junctions: `smoothstep`'s
 * derivative is exactly zero there, so any finite difference reports its own
 * step size rather than a property of the curve.)
 *
 * **What it does still buy is depth against incidence**, which turns out to be
 * worth more than the knife edges were. Measured on the main, whose full draft
 * is `foot · MAX_DRAFT_FRACTION` = 0.473 m, at saturated pressure — the
 * pressure factor is common to both columns and cancels: with `sin α` the drawn
 * camber is 0.058 m at α = 7°, 0.122 m at 15° and 0.473 m at 90°; with only the
 * sign it is 0.473 m at all three — full camber on a sail 7° off luffing, and a
 * close-hauled sail indistinguishable from one on a beam reach. A close-hauled
 * sail reading distinctly flatter than a reaching one is §4.1's deliberate
 * visible consequence and is true on the water, so `sin α` stays whole.
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
 * The draft *position* below is still a drawing decision and lives here. The
 * camber **depth** no longer does: it moved to `model/sail.ts` when the jib's
 * foot began conserving its arc length, because the depth now sets the chord,
 * the chord sets where the clew is, and that sets the force. The old claim in
 * this docblock — "camber affects no force" — stopped being true on that day and
 * is corrected rather than deleted, because it is exactly the assumption a
 * reader would otherwise carry forward.
 */

import type { Sail } from "../model/boat.ts";
import { JIB, MAIN, STATIONS, jibClewPosition, mainClewPosition } from "../model/boat.ts";
import type { CollapseEdge } from "../model/sail.ts";
import {
  angleOfAttack,
  camberDepth,
  jibChord,
  collapseFrom,
  collapsedFraction,
  dynamicPressure,
  optimalTrim,
  sailForce,
} from "../model/sail.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, Radians, Seconds, Vec2 } from "../model/units.ts";
import {
  TAU,
  add,
  magnitude,
  perpendicular,
  scale,
  sin,
  smoothstep,
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
   * How much of the sail has collapsed — the model's number, carried through
   * untouched. Measured from {@link collapseFrom}'s edge, so it does not locate
   * the fluttering region on its own; {@link collapseAt} is what turns the pair
   * into a position on the chord, and pos-dmg.2 should hang the shake on that
   * rather than on either field.
   */
  readonly collapsedFraction: number;
  /**
   * Which edge the collapse ran in from, so the drawing shakes the end that is
   * actually letting go rather than always the luff.
   *
   * Past |α| = 173° the flow arrives at the leech, and the cloth breaks there
   * and runs forward. That band is not a sliver to draw wrongly: the fraction is
   * 0.35 at α = 175° and only reaches 1 at 178°, so a renderer measuring from
   * the luff would shake the forward third of a sail whose after end is going.
   */
  readonly collapseFrom: CollapseEdge;
}

/**
 * The camber's shape, unscaled: 0 at the luff, exactly 1 at the draft position,
 * 0 at the clew, and strictly positive between.
 */
export function camberProfile(chordFraction: number, draftPosition: number): number {
  return profileAt(handleWeights(draftPosition), chordFraction);
}



function shapeOf(
  sail: Sail,
  sailAngle: Radians,
  tack: Vec2,
  clew: Vec2,
  draftPosition: number,
  apparent: ApparentWind,
): SailShape {
  const alpha = angleOfAttack(sailAngle, apparent);
  return {
    tack,
    clew,
    depth: camberDepth(sail, sailAngle, apparent),
    draftPosition,
    collapsedFraction: collapsedFraction(alpha),
    collapseFrom: collapseFrom(alpha),
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
    // The live chord, so the drawn clew is where the model put it: a bellied
    // foot spans less than 7'6" and the cloth is drawn between tack and clew.
    jibClewPosition(jibAngle, jibChord(jibAngle, apparent)),
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
 * How deep into the collapsed region a chord fraction lies: 0 outside it, 1 at
 * the edge the cloth is breaking from, rising linearly between.
 *
 * **This is where the collapse's axis is settled**, so that nothing downstream
 * has to know that it has two limbs. `s` runs 0 at the luff to 1 at the clew,
 * always — it is a position on the drawn chord, and a travelling wave's phase
 * depends on it staying monotone — while the collapse runs aft from `s = 0` when
 * the flow arrives at the luff and forward from `s = 1` when it arrives at the
 * leech. Asking "how far into the collapse is this point" answers both without a
 * branch at the call site, and reads the same in either band: 0 at the boundary,
 * 1 at the breaking edge.
 *
 * A ratio rather than a chord distance, deliberately: it is the natural argument
 * for a flutter's amplitude ramp (pos-dmg.2), which wants to fade in from the
 * boundary regardless of how wide the collapsed region currently is. Multiply by
 * `shape.collapsedFraction` for the distance in chord fractions if that is what
 * is wanted.
 *
 * **This is the *aerodynamic* ramp, and at full collapse that stops being the
 * whole story.** What it measures is depth into the **detached** region, which
 * is where a partly collapsed sail really does shake: the flow has left the
 * cloth at the breaking edge and is still attached further along. Once the
 * fraction reaches 1 there is no pressure gradient left to measure, and this
 * goes on peaking at the edge the collapse arrived from — head to wind, 1 at the
 * luff, which is the end pinned to the mast, and 0 at the clew. A sail flogging
 * head to wind moves most at its **unsupported** edge, the leech, because
 * nothing is holding it.
 *
 * Both are real, in different regimes, which is why no single word covers this
 * number: "detached" is what it measures, "unsupported" is what a flogging sail
 * responds to, and they point at opposite ends of the cloth. A flutter that
 * wants the second must blend toward the free edge as `collapsedFraction`
 * approaches 1 — deliberately not done here, because it is an animation
 * decision. §4.1 says the same thing in the same terms.
 */
export function collapseAt(shape: SailShape, chordFraction: number): number {
  // Guards the divide, and says the honest thing besides: with nothing
  // collapsed there is no region to be inside, at either end.
  if (shape.collapsedFraction <= 0) return 0;

  const into =
    shape.collapseFrom === "luff"
      ? shape.collapsedFraction - chordFraction
      : chordFraction - (1 - shape.collapsedFraction);

  return into <= 0 ? 0 : Math.min(into / shape.collapsedFraction, 1);
}

/**
 * A per-point deformation of the sail, for pos-dmg.2's travelling sine.
 *
 * `chordFraction` runs 0 at the luff to 1 at the clew — a position on the drawn
 * chord, never on the collapse's own axis. Which end is shaking is
 * {@link collapseAt}'s business: `collapseAt(shape, s) > 0` is the fluttering
 * region, in either band. `camberOffset` is the undeformed offset there, in
 * metres, already signed.
 *
 * **It returns a replacement, not an addend, and that is load-bearing.** §4.1
 * wants the collapsed portion to go flat while the portion still drawing keeps
 * its camber, so pos-dmg.2 needs to write `offset · (1 − collapseAt(shape, s)) +
 * ripple(s)` — an addend hook could not attenuate what it was given and would
 * have forced a rewrite of exactly the code this seam exists to protect.
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

// --- The luffing flutter (pos-dmg.2) ----------------------------------------

/**
 * Peak ripple, as a fraction of the chord.
 *
 * Over-drawn for the same reason {@link MAX_DRAFT_FRACTION} is, and calibrated
 * against the same binding case: the jib on a 320 px phone, where `SHORT_SPAN`
 * puts its 2.29 m foot at 61 px. A wholly collapsed jib shivers 4.4 px peak to
 * peak there against a 2.2 px stroke — a shiver rather than a thickened line —
 * and the main 5.7 px.
 *
 * **Head to wind is not where the ripple is largest**, which is worth knowing
 * before quoting either of those as a maximum. {@link flutterEnvelope} reaches
 * **0.945** at the cross-fade's midpoint,
 * `collapsedFraction = (FLOG_ONSET + 1) / 2 = 0.95` — α = 2.6768° — and at
 * `s = FLUTTER_END_TAPER`, where it is `cf − FLUTTER_END_TAPER · (1 − cf)`. So
 * the largest ripple the drawing shows is 5% above the figures above:
 * **5.96 px** on the main and **4.61 px** on the jib.
 *
 * **0.945 is the value at the taper's corner, not the supremum**, and the
 * distinction is recorded because it was got wrong twice. The `cf` coordinate
 * is exact — at the midpoint `smoothstep(0.5) = 0.5` puts both ends of the
 * mixture at 0.5, where the normaliser's two branches meet in a kink, and a
 * kink is a true argmax. The `s` coordinate is a hair early: just inside the
 * taper its slope is `6u(1 − u)/τ = 60(1 − u)`, still beating the mixture's
 * fall of `0.05/0.95`, so the true maximum sits at `s ≈ 0.09991` and is
 * `2.2 × 10⁻⁶` higher. **`smoothstep`'s derivative is zero *at* 1, not near
 * it** — the module docblock warns of the same thing at §3.3's plateau edges,
 * and this is that property met from the other side. Nothing physical turns on
 * 2.2 × 10⁻⁶, which is about 10⁻⁵ px; what turns on it is whether this
 * paragraph may say "maximum", and it may not.
 *
 * A quarter of full camber, so a fluttering sail can never be mistaken for a
 * drawing one at a glance. This is a knob to move by eye against the running
 * drawing; the pixel sizes are pinned so that moving it is a deliberate act.
 */
const FLUTTER_AMPLITUDE_FRACTION = 0.04;

/**
 * Ripples across the whole chord, so a sail's wavelength scales with its own
 * size and the shorter-footed jib shivers finer than the main — which is what a
 * pair of flogging sails does.
 *
 * Three across the chord means the 35% of cloth gone at α = 175° carries about
 * one wave: a single bulge shivering at the leech, not a corrugation.
 */
const FLUTTER_WAVES = 3;

/** Flaps per second. A real sail beats at a few hertz; 20 frames a cycle at 60 fps. */
const FLUTTER_HZ = 3;

/**
 * How far in from each end the ripple fades, in chord fractions.
 *
 * **Both ends of the drawn chord are attachments**, whatever the flow is doing:
 * the tack is the mast or `STATIONS.jibTack`, and the clew is on the boom end or
 * the jib sheet. {@link sailPathData} pins the endpoints by never calling the
 * hook there, but that alone would leave the first interior sample — at
 * `1/SAIL_SAMPLES` of the chord — carrying nearly full amplitude next to a fixed
 * point, which draws a spike at the mast rather than a shivering sail. The taper
 * is what turns that corner into a ripple that grows out of the attachment.
 *
 * At 0.1 the fade spans a little over three samples at each end, so the flutter
 * is at full amplitude across the middle 80% of the chord while the sample
 * beside either attachment never moves more than 0.027 m — 0.7 px on a 320 px
 * phone, 2.3 px on a 1024 px tablet, a quarter of the largest ripple the drawing
 * ever shows. `sail.test.ts` sweeps both sails and every collapse for that,
 * **in metres rather than as a share of the shape's own peak**: at a collapse so
 * slight that only one sample falls inside the region, that sample necessarily
 * *is* the peak, and a ratio would read 0.99 of a motion two hundredths of a
 * pixel wide.
 */
const FLUTTER_END_TAPER = 0.1;

/**
 * The collapsed fraction at which the amplitude ramp starts crossing from the
 * aerodynamic answer to the structural one. See {@link flutterEnvelope}.
 *
 * 0.9 is reached at |α| = 2.98° — inside a band where `(1 − collapsedFraction)`
 * has already taken the camber to a tenth and the sail is drawn as very nearly a
 * straight line. Nothing §4.1 asks the *partial* collapse to teach survives that
 * far in, which is why the cross-fade can be put here without touching the case
 * the bead is about.
 *
 * **Two facts keep this from being a magic number**, and both are worth having
 * here rather than only in {@link flutterEnvelope}:
 *
 * - **Below it the cross-fade weight is exactly 0**, because `smoothstep`
 *   clamps. So every partial collapse — the whole of what §4.1 and this bead are
 *   about — is left byte for byte where `collapseAt` puts it, with no ripple
 *   outside the collapsed region at all. This constant cannot reach the case a
 *   reader is most likely to worry about.
 * - **On the leech-first limb the cross-fade is the identity, not a mirror.** At
 *   `collapsedFraction = 1` breaking from the leech, `collapseAt(shape, s)` *is*
 *   `s` — 0.25 reads 0.250, 0.90 reads 0.900 — so mixing the two changes
 *   nothing there at any weight. The entire effect of this constant is one case:
 *   a sail head to wind, on the luff limb, where `collapseAt` is `1 − s` and
 *   would otherwise shake the sail hardest against its own mast.
 */
const FLOG_ONSET = 0.9;

/** Fades the ripple into the chord's two fixed ends. See {@link FLUTTER_END_TAPER}. */
function endTaper(chordFraction: number): number {
  return (
    smoothstep(chordFraction / FLUTTER_END_TAPER) *
    smoothstep((1 - chordFraction) / FLUTTER_END_TAPER)
  );
}

/**
 * The ripple's amplitude at a chord fraction, as a fraction of its peak: 0
 * where the sail is still drawing, rising to 1 where it is shaking hardest.
 *
 * Three factors, and each answers a different sentence of §4.1.
 *
 * **Where it shakes** is {@link collapseAt}, not `s < collapsedFraction` — the
 * region is `collapseAt(shape, s) > 0`, which runs aft from the luff or forward
 * from the leech according to where the flow arrives, without this function
 * having to know which.
 *
 * **How hard it shakes** is `collapsedFraction` as a plain scalar, which is what
 * makes "a sail that is *just* starting to break shows a **small** ripple"
 * literally true: `collapseAt` alone is 1 at the breaking edge however little
 * cloth has gone, so a sail 1% collapsed would shiver at full amplitude in a
 * sliver. Multiplying by the fraction ties the ripple's size to the same number
 * that is flattening the camber and taking the force off (§3.3).
 *
 * **Which end whips at full collapse** is the one thing §4.1 left to the
 * animation, and this is where it is settled. `collapseAt` is an *aerodynamic*
 * ramp — depth into the **detached** region — and it is right while the collapse
 * is partial. Once the whole chord has let go there is no pressure gradient left
 * to measure and the honest question is structural: a flogging sail moves most
 * at its **unsupported** edge, which is the leech, because nothing holds it. So
 * the ramp cross-fades from `collapseAt` to a plain `s` — 0 at the luff, 1 at
 * the leech — over `collapsedFraction ∈ [FLOG_ONSET, 1]`.
 *
 * **On the leech-first limb the cross-fade is the identity.** At
 * `collapsedFraction = 1` with the collapse from the leech, `collapseAt(s)` is
 * already exactly `s`. So the whole effect is on the luff-first limb — head to
 * wind — where the aerodynamic ramp would otherwise peak at the end pinned to
 * the mast.
 *
 * **The normalisation is what makes the cross-fade survivable, and it is not
 * decoration.** On that limb the two ramps point at opposite ends, so mixing
 * them *cancels*: halfway across, the raw mixture is nearly flat at half height,
 * and the ripple would visibly shrink by a third and swell again as a sail came
 * head to wind. Dividing by the mixture's own peak fixes the amplitude while
 * letting the shape slide, and the peak is available in closed form rather than
 * by scanning, because the mixture is piecewise linear in `s` with its only
 * interior breakpoint at the collapse boundary — where it can never exceed both
 * ends. So the maximum is at `s = 0` or `s = 1`, and those are the two terms
 * below. It reduces to exactly 1 wherever it should: at `flogging = 0`, and
 * everywhere on the leech-first limb.
 *
 * What the transition then draws is a progression rather than a swap: the sail
 * breaks at the luff, the shake spreads over the whole cloth, and once the
 * chord is wholly gone it concentrates at the leech.
 *
 * **It can ripple a little cloth the model still calls "drawing".** The `s` term
 * is not gated on the region, so above `FLOG_ONSET` it reaches past the
 * boundary — which by then is within `1 − collapsedFraction < 0.1` of the leech,
 * inside {@link endTaper}'s fade, on cloth whose remaining camber is under a
 * tenth of full. `sail.test.ts` measures that overhang rather than arguing it
 * away. Gating it would trade a smear for a discontinuity in the drawn shape at
 * the boundary, which is the worse of the two.
 */
export function flutterEnvelope(shape: SailShape, chordFraction: number): number {
  return envelopeAt(shape, rampTerms(shape), chordFraction);
}

/**
 * **Where** the shake sits along the chord, normalised to a peak of exactly 1 —
 * the cross-fade above with neither the depth scalar nor the end taper on it.
 *
 * Split out from {@link flutterEnvelope} and exported because it is the only
 * form in which the normaliser can be *checked*. The invariant the closed form
 * stands on is `mixed / peak ≤ 1` with equality reached, and the envelope
 * multiplies that by `collapsedFraction` and by {@link endTaper} — both of which
 * bite hardest exactly where the mixture peaks. On the luff limb at full
 * collapse the peak is at `s = 1`, where the taper is *zero*, so sweeping the
 * envelope cannot see the quantity at all: it tops out around 0.945 and would
 * wave through a normaliser understated by 5%. `sail.test.ts` sweeps this
 * instead, and reaches exactly 1.
 *
 * It is also the honest name for what §4.1 calls the amplitude ramp, so this is
 * a shape the module should have had either way.
 */
export function flutterRamp(shape: SailShape, chordFraction: number): number {
  return rampAt(shape, rampTerms(shape), chordFraction);
}

/**
 * The two numbers {@link flutterRamp} would otherwise re-solve at every sample.
 * Both are pure functions of the `SailShape` and neither varies across a sweep
 * of `s`, so they are hoisted for the reason {@link pointAt} gives about the
 * handle weights: a deformation is evaluated `SAIL_SAMPLES − 1` times a frame,
 * per sail.
 */
interface RampTerms {
  /** How far the ramp has crossed toward the free edge: 0 partial, 1 flogging. */
  readonly flogging: number;
  /** What the mixture peaks at — the normaliser the docblock above derives. */
  readonly peak: number;
}

function rampTerms(shape: SailShape): RampTerms {
  const flogging = smoothstep((shape.collapsedFraction - FLOG_ONSET) / (1 - FLOG_ONSET));
  const mix = (from: number, to: number): number => from + flogging * (to - from);
  return {
    flogging,
    // The mixture is piecewise linear in `s` with its only interior breakpoint
    // at the collapse boundary, which can never exceed both ends — so its
    // maximum is at one end or the other, and these are those two.
    peak: Math.max(mix(collapseAt(shape, 0), 0), mix(collapseAt(shape, 1), 1)),
  };
}

/** {@link flutterRamp}, once the per-shape numbers are already solved. */
function rampAt(shape: SailShape, terms: RampTerms, chordFraction: number): number {
  // Guards the divide: with nothing collapsed both ends of the mixture are
  // zero, and there is no ripple to normalise in the first place.
  if (shape.collapsedFraction <= 0) return 0;

  const detached = collapseAt(shape, chordFraction);
  return (detached + terms.flogging * (chordFraction - detached)) / terms.peak;
}

/** {@link flutterEnvelope}, once the per-shape numbers are already solved. */
function envelopeAt(shape: SailShape, terms: RampTerms, chordFraction: number): number {
  return rampAt(shape, terms, chordFraction) * shape.collapsedFraction * endTaper(chordFraction);
}

/**
 * §4.1's travelling sine, as a {@link SailDeformation} — or `undefined` when
 * nothing has collapsed, which is what makes an undrawn flutter free.
 *
 * `undefined` is exactly what {@link sailPathData} wants to emit the bare
 * Bézier, so a sail that is drawing costs six numbers and no sampling at all;
 * the polyline appears only while there is something to shake.
 *
 * The deformation is §4.1's form verbatim —
 * `offset · (1 − collapseAt(shape, s)) + ripple(s)` — so the collapsed portion
 * goes flat *and* ripples while the portion still drawing keeps its camber.
 * That is the whole reason the seam returns a replacement rather than an addend.
 *
 * **The wave travels with the flow**, which is the one place this function reads
 * `collapseFrom`, and it is not the axis error §4.1 warns about: *where* it
 * shakes is {@link flutterEnvelope}'s business and comes from `collapseAt`. This
 * is only the sign of the phase gradient — the ripple runs aft when the flow
 * arrives at the luff, and forward when it arrives at the leech, which is what
 * sailing by the lee (§3.3) actually looks like. `s` stays a monotone position
 * on the drawn chord either way, which is what the phase depends on.
 */
export function luffFlutter(shape: SailShape, time: Seconds): SailDeformation | undefined {
  if (shape.collapsedFraction <= 0) return undefined;

  const amplitude = magnitude(subtract(shape.clew, shape.tack)) * FLUTTER_AMPLITUDE_FRACTION;
  const travel = shape.collapseFrom === "luff" ? -1 : 1;
  const phase = travel * FLUTTER_HZ * time;
  const terms = rampTerms(shape);

  return (chordFraction, camberOffset) =>
    camberOffset * (1 - collapseAt(shape, chordFraction)) +
    amplitude *
      envelopeAt(shape, terms, chordFraction) *
      sin(TAU * (FLUTTER_WAVES * chordFraction + phase));
}

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

/**
 * How far ahead of the main the jib's ripple runs, in seconds.
 *
 * Two sails flogging on the same phase read as one mechanism rather than as two
 * pieces of cloth, and head to wind is exactly where both collapse at once.
 * Deliberately not half a period (0.167 s at {@link FLUTTER_HZ}), which would
 * only trade lockstep for antiphase; 0.13 s is 0.39 of a beat, so the two never
 * settle into a pattern. Applied as an offset on the *clock* rather than as a
 * parameter, so {@link luffFlutter} needs to know nothing about which sail it is
 * deforming.
 */
const JIB_FLUTTER_LEAD: Seconds = 0.13;

/**
 * The phase the ripple is frozen at when the viewer has asked for less motion.
 *
 * Held rather than flattened, deliberately. The flutter is *information* — it is
 * how §4.2 keeps an undertrimmed sail distinguishable from an overtrimmed one,
 * which are otherwise both red — so removing it would remove a reading rather
 * than an ornament. A still crinkle says "this sail has let go" without anything
 * on the page moving.
 */
const STILL_PHASE: Seconds = 0;

/** Named so the one place that consults the viewer's preference is greppable. */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

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
 * ## The flutter drives itself
 *
 * An earlier note here predicted pos-dmg.2 would widen `update` to take an
 * elapsed time. It did not, and the reason is worth recording: `update` is
 * called when the *state* changes, and a travelling wave has to move when
 * nothing changes at all. Widening the signature would have made every caller
 * responsible for running a clock — and there is exactly one caller, `main.ts`,
 * whose whole design is that state changes drive drawing.
 *
 * So this layer keeps a `requestAnimationFrame` loop of its own, and the split
 * is where the cost is:
 *
 * - **`update` does the expensive half, once per state change.** {@link
 *   rigDrawing} measures 55 µs for the rig, nearly all of it `optimalTrim`
 *   sweeping each sail's range for §4.2's denominator. Nothing about it changes
 *   between animation frames, so the result is cached and the loop never
 *   re-derives it.
 * - **The loop does the cheap half**, which is two {@link sailPathData} calls
 *   over {@link SAIL_SAMPLES} intervals — the trim quality, the camber depth and
 *   the collapsed fraction are all read off the cached shapes. Measured at 27 µs
 *   for both cloths with the flutter applied, against 2 µs for two sails
 *   drawing, so a whole animated frame costs less than half of one state change.
 *
 * **And it only runs while something is shaking.** A drawing sail has
 * `collapsedFraction === 0`, {@link luffFlutter} returns `undefined`, the bare
 * Bézier goes out, and no frame is scheduled — so the ordinary case costs
 * nothing per frame rather than a little. The loop stops on the frame that stops
 * the flutter, and `update` restarts it.
 *
 * Both figures are node measurements of this file's arithmetic and string
 * building. **They say nothing about SVG path parsing, layout or rasterisation
 * on a tablet**, which is the half of the bead's 60 fps criterion that no test
 * in this repo can reach.
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

  /** The last state's geometry, which the animation redraws without re-deriving. */
  let rig: RigDrawing | null = null;

  // Whether a frame is already queued, rather than its handle: nothing here
  // ever cancels one. A pending frame repaints from whatever `rig` says when it
  // runs, so a state change that lands first is picked up rather than raced.
  //
  // **It stays `true` for as long as a hidden tab holds the callback, and that
  // is the parked state rather than a stall.** A hidden document gets no
  // rendering opportunities, and the callback list is only drained during one,
  // so the entry waits rather than being dropped — in Blink, WebKit and Gecko
  // alike — and runs at the first opportunity after the tab is shown again.
  // Freezing a backgrounded page pauses those tasks rather than cancelling
  // them, and discarding it tears the whole document down. So the loop cannot
  // be left wedged, and meanwhile `update` still paints directly, so nothing is
  // ever drawn stale. The one visible artefact is that the ripple resumes on a
  // new phase in a single frame, which nobody sees: they were looking elsewhere.
  let pending = false;

  // Subscribed to, not merely consulted. An earlier version read `.matches` and
  // justified that by `Layer` having no teardown — which is not a reason, since
  // the animation loop below is exactly as un-removable. The real consequence of
  // not subscribing was worse: `update` fires only on input, so a viewer who
  // turned the preference *off* while the boat sat head to wind would watch a
  // frozen sail until they touched something. `addEventListener` on a
  // `MediaQueryList` is well below the Safari 15.4 floor (§4.4).
  const stillness = matchMedia(REDUCED_MOTION_QUERY);

  function fluttering(): boolean {
    if (rig === null) return false;
    return rig.main.shape.collapsedFraction > 0 || (rig.jib?.shape.collapsedFraction ?? 0) > 0;
  }

  /**
   * Writes `d` only when it differs from what is already there.
   *
   * The loop repaints *both* cloths whenever *either* is shaking, and "jib
   * luffing, main drawing" is an ordinary state — the two trims are independent
   * — so without this the main's identical bare Bézier would be rewritten sixty
   * times a second, paying an attribute write and a path re-parse for a shape
   * that has not moved.
   *
   * **What makes skipping sound is that `d` is the whole description of the
   * drawn cloth** — nothing else about the path is written per frame — so an
   * equal string means an equal shape on screen. Not `sailPathData`'s
   * determinism, which points the other way: that guarantees equal shape ⇒
   * equal string, and its absence would only ever cost a redundant write, never
   * draw the wrong thing. Determinism would be the load-bearing fact if the
   * string were cached beside the element; read back from the element itself,
   * as here, the check cannot go stale against the DOM and does not need it.
   */
  function drawCloth(path: SVGPathElement, d: string): void {
    if (path.getAttribute("d") !== d) path.setAttribute("d", d);
  }

  /** Both cloths at one instant on the flutter's clock. Nothing else per frame. */
  function paintCloth(time: Seconds): void {
    if (rig === null) return;
    drawCloth(main.cloth, sailPathData(rig.main.shape, luffFlutter(rig.main.shape, time)));
    if (rig.jib === null) return;
    const shape = rig.jib.shape;
    drawCloth(jib.cloth, sailPathData(shape, luffFlutter(shape, time + JIB_FLUTTER_LEAD)));
  }

  /** The cloth at the phase the viewer's motion preference asks for, and the loop re-armed. */
  function repaint(): void {
    // The same clock the loop runs on, so a state change lands on the phase the
    // ripple was already at instead of restarting the wave.
    paintCloth(stillness.matches ? STILL_PHASE : performance.now() / 1000);
    schedule();
  }

  function schedule(): void {
    if (pending || !fluttering() || stillness.matches) return;
    pending = true;
    requestAnimationFrame((now) => {
      // **First statement, deliberately.** If a paint below ever threw, the loop
      // would stop — but the next `update` would re-arm it. Clear this at the
      // end instead and a single throw parks the animation for the life of the
      // page, because nothing would ever set it false again. The two lines look
      // interchangeable and are not.
      pending = false;
      // Re-checked *inside* the frame, not only before arming it: a preference
      // turned on while this frame was in flight would otherwise land the ripple
      // on that frame's own timestamp, which is the one thing {@link STILL_PHASE}
      // exists to make deterministic.
      if (stillness.matches) {
        paintCloth(STILL_PHASE);
        return;
      }
      paintCloth(now / 1000);
      schedule();
    });
  }

  stillness.addEventListener("change", repaint);

  return {
    element,
    update(state: SimState): void {
      rig = rigDrawing(state);

      boom.setAttribute("x2", formatNumber(rig.main.shape.clew.x));
      boom.setAttribute("y2", formatNumber(rig.main.shape.clew.y));
      // On the group, not the path: the property inherits down to the cloth,
      // and a later bead colouring a telltale or a clew handle inherits the
      // same value rather than deriving a second one (§4.2).
      setSailInk(main.group, rig.main.quality);

      // Struck: hidden, and no stale geometry or colour computed or written for
      // it. What is left behind on the group is stale, and harmlessly so — the
      // group is `display: none`, and the frame that unstrikes the jib rewrites
      // both before anything paints. `paintCloth` skips it on the same test.
      jib.group.classList.toggle(STRUCK_CLASS, rig.jib === null);
      if (rig.jib !== null) setSailInk(jib.group, rig.jib.quality);

      repaint();
    },
  };
}
