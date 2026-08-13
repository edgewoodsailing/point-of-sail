/**
 * Trim angles → driving force (DESIGN.md §3.2–§3.3).
 *
 * `wind.ts` says what the sails feel and `foil.ts` says what a foil does with
 * an angle of attack; this module is the piece between them. It turns each
 * sail's trim into an angle of attack, assembles lift and drag into a force,
 * takes the along-heading component as drive, and finds the trim that maximises
 * it. It also says how much of that rig the crew are still carrying once it
 * breezes up — {@link depoweringFactor}, the one thing in this file that reads
 * the true wind rather than the apparent, and the one thing `simulation.ts`
 * rather than this module applies.
 *
 * **Everything here stays in the boat frame.** §3.2 says to "rotate into the
 * boat frame", but `apparent.angle` already arrives as an angle off the bow, so
 * the rotation happened in `wind.ts` and there is nothing left to rotate: the
 * heading is simply bearing zero throughout this file.
 *
 * **The lateral component is reported alongside the drive**, and one thing
 * downstream spends it: the keel has to hold the boat on its heading against
 * it, and §3.5 charges for that. There is still no leeway and no heel (§7) —
 * the side force moves nothing sideways and lays nothing over — so `lateral` is
 * a cost, not a motion, and `hull.ts` is the only module that reads it.
 *
 * The angle of attack works out to a strikingly simple identity,
 *
 * ```text
 * α = normalizeSigned(apparentWindAngle + sailAngle)
 * ```
 *
 * but it is written out through the named geometry helpers below, so the
 * derivation is legible where it is used rather than asserted in a comment.
 * `sail.test.ts` pins the identity.
 */

import type { Sail } from "./boat.ts";
import {
  clampTrim,
  JIB,
  JIB_CAR,
  jibClewPosition,
  MAIN,
  sailChordBearing,
  STATIONS,
  SWING_LIMIT,
} from "./boat.ts";
import { foilCoefficients, liftCurveSlope } from "./foil.ts";
import { DEPOWERING, FOIL, LUFF } from "./tuning.ts";
import type { ApparentWind } from "./wind.ts";
import type { Meters, MetersPerSecond, Newtons, Radians, Seconds } from "./units.ts";
import {
  acos,
  add,
  asin,
  feetToMeters,
  knotsToMetersPerSecond,
  sin,
  angleBetween,
  angleOfVector,
  magnitude,
  subtract,
  componentAcross,
  componentAlong,
  cos,
  normalizeSigned,
  oppositeAngle,
  perpendicular,
  scale,
  smoothstep,
  tan,
  unitVector,
} from "./units.ts";

/**
 * Air density at sea level, kg/m³.
 *
 * It lives here rather than in `tuning.ts` because it is physics and nobody
 * will ever adjust it until the boat feels right, and rather than in `boat.ts`
 * because it is not a measurement of the boat. The file rule is load-bearing on
 * both counts.
 */
const AIR_DENSITY = 1.225;

/** Dead ahead in the boat frame: the bearing driving force is measured along. */
const AHEAD: Radians = 0;

/**
 * The edge a collapse propagates from: the one the flow arrives at.
 *
 * A sail lies along the flow twice, and the two states are not mirror images of
 * each other. At α ≈ 0 the wind arrives at the luff and the cloth breaks there,
 * the collapse running *aft*; at α ≈ ±180° it arrives at the leech instead and
 * the collapse runs *forward*. Same fraction, opposite end.
 */
export type CollapseEdge = "luff" | "leech";

export interface SailForce {
  /**
   * The signed angle from the sail's chord to the apparent wind. Its sign says
   * which face the flow strikes — a well-trimmed sail runs positive on
   * starboard tack and negative on port — not whether the trim is good.
   */
  readonly angleOfAttack: Radians;
  /**
   * How much of the sail has collapsed, measured from {@link collapseFrom}'s
   * edge: 0..1. See {@link collapsedFraction} and §3.3.
   */
  readonly collapsedFraction: number;
  /**
   * Which end the collapse ran in from, so a renderer shakes the end that is
   * actually letting go. See {@link CollapseEdge}.
   */
  readonly collapseFrom: CollapseEdge;
  /** The component along the heading. Negative when the sail is backed. */
  readonly driving: Newtons;
  /**
   * The component across the heading, positive to starboard: what the keel has
   * to hold, and what §3.5's induced drag is charged on.
   */
  readonly lateral: Newtons;
}

/** What the two sails are doing, as the simulation holds it. */
export interface RigTrim {
  /**
   * Where the boom **is**, which is no longer the same thing as where it was
   * put. See {@link naturalMainAngle}: the sheet sets a limit and the wind
   * decides the angle inside it, so this is a state that evolves rather than an
   * input that is held.
   */
  readonly mainAngle: Radians;
  /**
   * How far off the centreline the mainsheet will *let* the boom go, ≥ 0.
   *
   * **This is what a sheet actually controls.** A mainsheet is a length of rope,
   * and a length of rope cannot tell the boom which side to be on or push it
   * anywhere — it can only stop it going further out. Which side and how far in
   * is the wind's business. Modelling the sheet as an absolute angle, which is
   * what this did before, quietly asserts the opposite: that the boom holds
   * whatever bearing it was left at however the boat turns under it, which is
   * the one thing a real boom conspicuously does not do.
   */
  readonly mainSheet: Radians;
  /** Where the jib's clew **is**, as a bearing from its tack. Evolves, like the boom. */
  readonly jibAngle: Radians;
  /**
   * How much jib sheet is out: the distance from the working car to the clew, in
   * metres.
   *
   * A length rather than an angle, because that is what the student holds. See
   * {@link naturalJibAngle} for how it becomes an angle — the map is the two-
   * circle geometry, and it is not linear.
   */
  readonly jibSheet: Meters;
  /**
   * Which car the working sheet leads to: `+1` starboard, `−1` port.
   *
   * **State, and set only by a hand letting go.** Deriving it from where the
   * clew happens to be oscillates: past about 0.52 m of sheet the clew can cross
   * the centreline, which is an ordinary trim, and then "whichever car the clew
   * is nearest" flips every frame. On the water the crew choose a sheet and it
   * stays chosen until they choose again, and so does this.
   */
  readonly jibSheetSide: number;
  /** False when the jib is struck — §3.7's sailing under main alone. */
  readonly jibSet: boolean;
}

export interface RigForce {
  readonly main: SailForce;
  /** Null when the jib is struck, so a caller cannot read a force that isn't there. */
  readonly jib: SailForce | null;
  /** The sum. */
  readonly driving: Newtons;
  /**
   * The sum of the side forces, which is what the keel meets. Summed signed, so
   * two sails pulling opposite ways — wing and wing on a run — cancel, which is
   * exactly what the keel feels.
   */
  readonly lateral: Newtons;
}

/**
 * `q = ½ρV²`, the pressure the moving air can convert. Exported because the
 * tests hand-compute forces from it.
 */
export function dynamicPressure(speed: MetersPerSecond): number {
  return 0.5 * AIR_DENSITY * speed * speed;
}

/**
 * The angle of attack for a trim: the signed angle from the sail's chord to the
 * direction the wind is blowing *toward*.
 */
export function angleOfAttack(sailAngle: Radians, apparent: ApparentWind): Radians {
  const flow = oppositeAngle(apparent.angle);
  return angleBetween(sailChordBearing(sailAngle), flow);
}

// --- How full the cloth blows (§4.1) ----------------------------------------
//
// Moved here from `render/sail.ts`, and the move is the point rather than
// tidiness. While a sail's depth was only ever *drawn*, it could live in the
// renderer. Now that the jib's foot conserves its arc length, the depth sets
// the CHORD — see {@link chordForArc} — and the chord sets where the clew is,
// which sets the angle of attack and therefore the force. It is physics now.

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

/**
 * How hard the wind is pressing the cloth into shape, 0..1.
 *
 * `q / (q + q_half)` — monotone, smooth, saturating, and needing no clamp. Since
 * `q ∝ V²` this is `V²/(V² + V_half²)`, but writing it in pressure reads truer
 * to §4.1 and costs nothing.
 */
export function pressureFactor(q: number): number {
  // A saturating curve saturates. `q/(q+half)` is `Inf/Inf` at an infinite
  // pressure, which is NaN, and NaN is the one value that poisons everything
  // downstream — it reached `acos` through the jib's chord and took a whole
  // sweep with it. Harmless while this only tinted a drawing; load-bearing now
  // that the depth sets the chord.
  if (!Number.isFinite(q)) return q > 0 ? 1 : 0;
  const half = dynamicPressure(CAMBER_HALF_PRESSURE_SPEED);
  return q / (q + half);
}

/**
 * Signed peak camber for a trim.
 *
 * ```text
 * depth = foot · MAX_DRAFT_FRACTION · (1 − collapsedFraction) · pressureFactor(q) · sin α
 * ```
 *
 * `(1 − collapsedFraction)` is what ties the drawing to the model: §3.3 asks
 * that one number drive both the flutter and the force reduction, and this makes
 * it drive the depth too, so what the student sees and what the boat does cannot
 * disagree. It is a scalar on the peak, so **which edge the collapse came from
 * does not enter here** — a sail with a third of its cloth shaking is a third
 * flatter whichever third it is. The edge is spent on the flutter's position
 * ({@link collapseAt}), not on the depth. `sin α` supplies the side and the
 * incidence; see the module docblock for what it is and is not still buying.
 */
export function camberDepth(sail: Sail, sailAngle: Radians, apparent: ApparentWind): Meters {
  const alpha = angleOfAttack(sailAngle, apparent);
  return (
    sail.foot *
    MAX_DRAFT_FRACTION *
    (1 - collapsedFraction(alpha)) *
    pressureFactor(dynamicPressure(apparent.speed)) *
    sin(alpha)
  );
}

// --- The jib's foot as cloth, not as a spar ---------------------------------

/**
 * How far the clew lies from the tack when the foot has bellied out — the
 * **chord of a circular arc** of fixed cloth length and given depth.
 *
 * ## Why an arc, and why exactly a circular one
 *
 * A sail has no bending stiffness, so it carries no load along itself and its
 * tension is constant from tack to clew. Balancing that tension against the
 * pressure across the cloth gives `T / R = Δp`, and with `T` constant and `Δp`
 * uniform, `R` is constant too. A curve of constant radius is a circular arc.
 * That is not a modelling convenience — it is the shape, and it is the same
 * result every circular-arc sail theory starts from.
 *
 * ## The relation, and why it needs no solver at runtime
 *
 * For a half-angle `θ`, an arc of length `L` has
 *
 * ```text
 *   chord c = L · sin θ / θ        depth f = L · (1 − cos θ) / (2θ)
 * ```
 *
 * Both are monotone in `θ`, so `f/L` fixes `θ` and `θ` fixes `c/L`. The whole
 * relation is one dimensionless curve — no boat dimensions in it — so it is
 * inverted by a fixed bisection on `θ` and nothing about the answer depends on
 * the frame it was asked in. **There is no equilibrium to iterate toward here:**
 * the depth arrives from the pressure model above, and the geometry does the
 * rest.
 *
 * ## What it changes
 *
 * The foot stops being a rigid bar. A full jib's chord is materially shorter
 * than its cloth — 2.6% at a camber ratio of 0.10, 16% at 0.27 — which pulls the
 * clew *forward*, toward the mast, exactly as it does on the water. Before this,
 * depth and chord were two independent numbers and `camberDepth` could report a
 * belly no 7'6" of cloth could make at that chord.
 *
 * A depth beyond `L/π` describes a curve that has closed past a half circle and
 * has no chord; it is clamped, and the clamp is unreachable in practice —
 * `MAX_DRAFT_FRACTION` is 0.16 of the foot against a limit of 0.318.
 */
export function chordForArc(cloth: Meters, depth: Meters): Meters {
  const belly = Math.abs(depth);
  if (!(belly > 0) || !(cloth > 0)) return cloth;
  const ratio = Math.min(belly / cloth, DEPTH_RATIO_MAX);
  return cloth * chordRatioFor(ratio);
}

/** `f/L` at a half circle, `1/π` — the deepest arc that still has a chord. */
const DEPTH_RATIO_MAX = 1 / Math.PI;

/** Samples across `f/L`. At 512 the interpolation error is under a micron. */
const ARC_SAMPLES = 512;

/**
 * `f/L → c/L`, tabulated once at module load.
 *
 * A table rather than a solve per call, and the reason is measured rather than
 * assumed: this runs twice a frame in the app, where a bisection would never be
 * noticed — and millions of times in `fold.test.ts`, which sweeps settled speeds
 * over a grid. The bisection took that sweep past a sixty-second timeout. The
 * relation has no boat dimensions in it, so one table serves every sail forever.
 */
const CHORD_RATIO: readonly number[] = (() => {
  const table: number[] = [];
  for (let i = 0; i <= ARC_SAMPLES; i += 1) {
    const target = (DEPTH_RATIO_MAX * i) / ARC_SAMPLES;
    let low = 0;
    let high = Math.PI;
    for (let step = 0; step < 60; step += 1) {
      const mid = (low + high) / 2;
      if ((1 - cos(mid)) / (2 * mid) < target) low = mid;
      else high = mid;
    }
    const theta = (low + high) / 2;
    table.push(theta > 0 ? sin(theta) / theta : 1);
  }
  return table;
})();

/** The table, read with linear interpolation. */
function chordRatioFor(depthRatio: number): number {
  const position = (depthRatio / DEPTH_RATIO_MAX) * ARC_SAMPLES;
  const index = Math.min(Math.floor(position), ARC_SAMPLES - 1);
  const fraction = position - index;
  return CHORD_RATIO[index] * (1 - fraction) + CHORD_RATIO[index + 1] * fraction;
}

/**
 * The mast's half-thickness, as the jib's foot meets it.
 *
 * `RB 13.01` caps the mast partner at 4 inches fore and aft, so the spar is
 * about a 4-inch section and this is half of it. Drawn larger than that
 * (`render/hull.ts` uses 0.11 m, about 2.2× life size) because a dot has to be
 * seen; what the cloth fouls is the real spar, so the real figure is used here.
 */
const MAST_HALF_THICKNESS: Meters = feetToMeters(2 / 12);

/**
 * The half-angle of the mast's shadow, seen from the jib's tack: **1.47°**.
 *
 * The run from tack to clew passes `J · sin(a)` from the mast's centre, so
 * inside this angle it would be running through the spar.
 */

/**
 * The clew's bearing, kept out of the mast.
 *
 * The foot cannot pass through the spar. Where the straight run from tack to
 * clew would, the cloth fetches up on the mast and goes round it — so the run
 * is tangent to the spar rather than through it, and the clew's bearing is
 * pushed to the edge of the shadow on whichever side it was already passing.
 *
 * **The band this bites in is narrow, and saying so is honest rather than
 * discouraging.** The run passes `J · sin(a)` from the mast centre, so with a
 * 2-inch spar it fouls only inside {@link MAST_SHADOW} — about **1.5°** — of
 * dead astern of the tack. At any ordinary sheeting angle nothing here engages,
 * and the *geometric* correction where it does is a fraction of an inch. What it
 * buys is topological, not metric: the cloth goes round the spar instead of
 * through it.
 *
 * It earns its place in the band it does bite: dead astern of the tack is
 * exactly where the clew passes when the jib **backs or is tacked**, and that is
 * the one manoeuvre where the old model swept the whole foot straight through
 * the spar. A cambered foot bulges to leeward and clears the mast on its own
 * when the sail is *drawing*; it is the backed sail, bellying the other way,
 * that needs this.
 */
export const MAST_SHADOW: Radians = (() => {
  const toMast = magnitude(subtract(STATIONS.mast, STATIONS.jibTack));
  return asin(Math.min(MAST_HALF_THICKNESS / toMast, 1));
})();

export function clearMast(jibAngle: Radians, incumbent: number): Radians {
  if (Math.abs(jibAngle) >= MAST_SHADOW) return jibAngle;
  // Inside the shadow the cloth would be running through the spar. Put it back
  // on the tangent — the side it was already going round, so a clew crossing
  // does not double back on itself.
  const side = jibAngle === 0 ? Math.sign(incumbent) || 1 : Math.sign(jibAngle);
  return side * MAST_SHADOW;
}

/**
 * Where the boom goes on its own: **downwind until the sheet stops it.**
 *
 * ## The whole derivation, because it is two lines and it is the point
 *
 * With no hand on it, a boom is a weathervane pivoting on the mast. It comes to
 * rest where the sail has stopped pushing it round, which is where the cloth
 * lies along the flow — {@link angleOfAttack} zero. Turning the boom by δ moves
 * α by δ, so the turn it wants is exactly `−α` and it ends up at
 *
 * ```text
 *   weathervane angle = current − α
 * ```
 *
 * The sheet then does the only thing a rope can: it stops the boom going
 * further out than `sheet`, on whichever side the wind has taken it. So
 *
 * ```text
 *   natural angle = clamp(current − α, −sheet, +sheet)
 * ```
 *
 * ## Why that is not `clamp(−awa, …)`, which is what it was
 *
 * `current − α` **is** `−awa` — the identity `α = normalizeSigned(awa + a)` says
 * so — but only *modulo a full turn*, and which of those representatives you
 * take is the entire behaviour of a gybe.
 *
 * `normalizeSigned(−awa)` takes the one nearest the centreline, and that one
 * jumps from just inside `+π` to just inside `−π` the instant the apparent wind
 * crosses dead astern. The clamp changes side with it, so the boom gybed at
 * exactly AWA 180° however far out it was sheeted. Nothing about the sail said
 * to: **α is perfectly continuous through a dead run** — running with the wind
 * on the starboard quarter and the boom out to port at 80°, α passes +99° →
 * +100° → +101° as AWA goes +179° → 180° → −179° — and it was only the branch
 * that jumped.
 *
 * `current − α` takes the representative the boom can actually *reach*, and
 * that is the physical one. The moment the cloth makes about the mast is odd in
 * α and vanishes at **both** edge-on states — at α = 0, where the wind meets the
 * luff, and at α = ±180°, where it meets the leech — so the boom is driven
 * toward zero *along the α axis* and cannot wrap through the leech-first state
 * on the way. While the wind is still on the after face of the sail it is
 * pressing the boom *outward*, into its stop, and a rope cannot pull it back.
 *
 * The two expressions agree everywhere `|current − α| < 180°` — equivalently
 * `|α| < 90°`, since `|current| ≤ SWING_LIMIT` — which is every trim from close
 * hauled round to a broad reach. A tack is unaffected: near the bow `|α|` is
 * small and there is nothing to wrap.
 *
 * The bound is strict, and the boundary is the bug rather than a fussy epsilon.
 * At `current − α = −180°` exactly, `normalizeSigned` folds −π onto **+π**, so
 * the two branches are a full turn apart and the old one puts the boom on the
 * far shroud. That is a boom on the shrouds at a dead run: the case this
 * function exists to get right.
 *
 * ## What falls out of it, none of which is special-cased
 *
 * - **Sailing.** Close hauled, `|awa|` is small and the sheet is in tight, but
 *   `|−awa|` still exceeds it — so the boom sits *on the sheet limit* and the
 *   sail draws at α = `|awa| − sheet`. That is true at every point of sail a
 *   student uses: the boom is on its stop and the sheet is what sets the angle
 *   of attack. The old absolute-angle model got the same answer here, which is
 *   why it survived this long.
 * - **Easing too far.** Ease past `|awa|` and the clamp stops binding: the boom
 *   reaches the weathervane angle, α goes to zero and the sail flogs. Which is
 *   what over-easing does, and what the old model could not show at all.
 * - **Tacking, for free.** Turn the boat up through the wind and α changes sign
 *   with `awa`; the clamp changes side with it and the boom crosses on its own,
 *   from one stop to the mirror of it with nothing in between.
 * - **Gybing, when the wind gets round the leech — and not before.** Bear away
 *   through dead downwind and nothing happens: α is still on the after face of
 *   the sail, still pressing the boom out against its stop, and the boat sails
 *   by the lee with the boom where it was. The boom crosses when α reaches
 *   ±180°, which with the boom on its stop is
 *
 *   ```text
 *     |awa| = 180° − sheet
 *   ```
 *
 *   — **the boat has to be by the lee by as much as the boom is eased.**
 *   Sheeted flat at 10° it gybes 10° past dead downwind, which is the twitchy
 *   boat a student recognises; eased to 80° it holds until the apparent wind is
 *   10° from the beam. That bound is `SWING_LIMIT`, so it is also a guarantee:
 *   a free boom never holds to windward with the apparent wind forward of the
 *   beam.
 * - **Backing, and pos-bql.2's swing-back, derived rather than animated.** Push
 *   the boom to windward and let go **with the wind forward of the leech**:
 *   `sheet` is whatever you held it at, the wind is on the other side, so the
 *   natural angle is `−sheet` — the *mirror* of where you had it. That is
 *   pos-bql.2's specified behaviour, "same trim, other side", arrived at
 *   without a swing-back animation existing. It is the mooring departure's
 *   mechanism, and that happens head to wind, where nothing here is in doubt.
 * - **Wing and wing, past the same threshold.** The proviso above is not a
 *   hedge — it is the gybe rule again, from the other end. Push the boom to
 *   windward while the boat is *by the lee of it*, `|awa| > 180° − sheet`, and
 *   there is no back-pressure to swing it: the wind is on the after face of the
 *   cloth and holds it exactly where you put it. So at a dead run the boom is
 *   stable on **either** side, which is what wing and wing is, and which the
 *   near-branch model could not represent — it flopped the boom back to leeward
 *   however the sails were set. One boundary, `α = ±180°`, decides both: past
 *   it a boom crosses, short of it a boom pushed across comes back.
 *
 * ## The feedback loop this creates, which is real and worth having
 *
 * Ease too far, the sail flogs, the boat slows — and as it slows the apparent
 * wind swings *aft*, so `|awa|` grows, the clamp starts binding again and the
 * sail refills. It is a stable loop with a genuine lesson in it, and it is not
 * something anyone wrote: it is `apparentWind` and this clamp interacting.
 */
export function naturalMainAngle(
  current: Radians,
  sheet: Radians,
  apparent: ApparentWind,
): Radians {
  return heldBetween(weathervaneAngle(current, apparent), -sheet, sheet);
}

/**
 * The angle this sail is turning toward: `current − α`, **left unwrapped**.
 *
 * The one line both sails share, and the one place the branch is chosen. See
 * {@link naturalMainAngle} for why the branch is the whole of it.
 */
function weathervaneAngle(current: Radians, apparent: ApparentWind): Radians {
  return current - angleOfAttack(current, apparent);
}

/**
 * Held between two bounds **without normalising first**, which is why this is
 * here and {@link clampTrim} is not.
 *
 * `clampTrim` normalises into (−π, π] before clamping, and the whole content of
 * a weathervane target is which turn of the circle it sits on: normalise a boom
 * straining out to port at −190° and it becomes +170°, which clamps to the
 * *starboard* stop — the gybe this function exists to stop happening. Every
 * result still leaves through `clampTrim`; it is just handed a legal angle by
 * the time it gets there.
 */
function heldBetween(angle: Radians, low: Radians, high: Radians): Radians {
  return Math.min(Math.max(angle, low), high);
}

/**
 * How fast the boom answers a change, as a first-order time constant.
 *
 * A boom is not massless and a sheet is not a rail, so it takes a moment. At
 * 0.13 s it covers 95% of a swing in about 0.4 s, which is pos-bql.2's figure
 * for the swing-back and reads as a boom rather than a jump cut.
 *
 * **One constant for every swing, which is a simplification with a visible
 * cost**: a boom slamming across in a gybe is driven by a great deal more force
 * than one drifting out in light air, and here they take the same time. The
 * honest version would drive the swing from the aerodynamic moment, which is a
 * second integrator and its own bead. Until then this errs toward the gentle
 * end, because a too-fast gybe reads as a glitch while a too-slow one only
 * reads as a heavy boom.
 */
export const BOOM_RESPONSE: Seconds = 0.13;

/**
 * A sail's angle after `dt`, easing toward wherever the wind and its sheet put
 * it.
 *
 * Exponential rather than a constant rate, so it cannot overshoot at any step
 * length — `step` clamps `dt` to a tenth of a second but `settle` is free to
 * take longer strides, and a rate-limited swing would ring at those.
 */
export function easeSailAngle(current: Radians, target: Radians, dt: Seconds): Radians {
  if (!(dt > 0)) return current;
  // Shortest way round, so a gybe crosses through the centreline rather than
  // unwinding the long way through head to wind.
  const gap = normalizeSigned(target - current);
  return normalizeSigned(current + gap * (1 - Math.exp(-dt / BOOM_RESPONSE)));
}

/**
 * Where the jib's clew goes on its own — **the same sentence as the main, with a
 * differently shaped stop.**
 *
 * ## Why it is not simply the main again
 *
 * A boom pivots on the mast, so its sheet limits an *angle*. A jib's clew is a
 * corner of cloth on the end of a rope: it can be anywhere the foot allows —
 * a circle of radius `JIB.foot` about the tack — and anywhere the sheet allows,
 * a circle of radius `sheet` about the car. It sits where those two circles
 * cross, and the wind picks which crossing.
 *
 * ## And why it collapses back into the main anyway
 *
 * Write the sheet constraint out and it turns into an interval on the same
 * angle the model already uses. With `w = car − tack`, `d = |w|`, and the clew
 * at chord bearing `b`:
 *
 * ```text
 *   |clew − car|² = foot² + d² − 2·foot·d·cos(b − β)   where β = bearing of w
 *   sheet² = that   ⟹   cos(b − β) = (foot² + d² − sheet²) / (2·foot·d)
 * ```
 *
 * So the two crossings are `β ± acos(C)`, and in sail-angle terms they are
 * **symmetric about the bearing to the car**:
 *
 * ```text
 *   natural jib angle = clamp(current − α, a₀ − h, a₀ + h)
 *       a₀ = the angle whose clew lies nearest the car (12.6° to the car's side)
 *       h  = acos(C), how far the sheet lets it swing either way from there
 * ```
 *
 * That is {@link naturalMainAngle} with the interval shifted off centre —
 * including the unwrapped target, and for the same reason. A jib has a leech
 * too, and the clew is held out on the sheet by the wind on the after face of
 * the cloth just as the boom is; it crosses when the wind gets round that leech
 * and backs the sail, not when the wind crosses the transom. The main is the
 * special case where the car is on the centreline, so `a₀ = 0` and the interval
 * is symmetric — which is exactly why a boom tacks itself.
 *
 * ## The asymmetry that falls out, and it is the real one
 *
 * Because the jib's interval is **not** centred on zero, tacking the boat does
 * not tack the jib. Sheeted to starboard at 1.0 m the clew may lie anywhere in
 * −12.2°…+37.4°; put the wind on the starboard bow and the weathervane wants
 * the far side, so it clamps at −12.2° and stops there — to windward, aback.
 * The main meanwhile has crossed on its own. **The main tacks itself and the jib
 * has to be tacked**, which is the fact of the boat, arrived at from geometry
 * rather than asserted.
 *
 * It also hands pos-bql.1 the backed jib with no mechanism of its own, the way
 * the sheet model handed pos-bql.2 the swing-back.
 *
 * ## Which side the sheet is on is *state*, not a derivation
 *
 * Deriving it from where the clew currently is oscillates, and not in a corner:
 * past about 0.52 m of sheet the clew can cross the centreline, which is an
 * ordinary trim, and then "the working sheet is the one the clew is nearest"
 * flips every frame. So the side is set once, by which side of the boat the
 * hand let go on, and holds until a hand changes it — which is also what
 * happens on the water, where the crew choose a sheet and it stays chosen.
 */
export function naturalJibAngle(
  current: Radians,
  sheet: Meters,
  side: number,
  apparent: ApparentWind,
  chord: Meters = JIB.foot,
): Radians {
  const car = { x: side * JIB_CAR.x, y: JIB_CAR.y };
  const w = subtract(car, STATIONS.jibTack);
  const d = magnitude(w);
  // **The chord, not the cloth.** A bellied foot spans less than its own length
  // ({@link chordForArc}), so the circle the clew rides shrinks as the sail
  // fills — which is what pulls the clew forward, toward the mast, instead of
  // leaving it swinging on a rigid 7'6" bar.
  const foot = chord;

  // The clew nearest the car: chord bearing straight at it, so a₀ = π − β.
  const centre = sailChordBearing(angleOfVector(w));
  const weathervane = weathervaneAngle(current, apparent);

  const cosine = (foot * foot + d * d - sheet * sheet) / (2 * foot * d);
  // Three degenerate sheets, written as the ends of the same interval rather
  // than as three early returns, so the clamping and the shroud limit below are
  // reached by every path:
  //
  // - **Not a number at all.** A sheet or a chord that is not a number has no
  //   geometry, and `acos` says so loudly rather than returning NaN. A zero
  //   interval holds the clew at `centre` — the same answer "there is no usable
  //   bearing right now" gets everywhere else.
  // - **Hauled shorter than the geometry allows**, `|foot − d|`, so both
  //   constraints cannot hold at once. The cloth wins: the clew goes to the
  //   point on the foot circle nearest the car and the sheet is simply bar taut.
  //   Also a zero interval.
  // - **Longer than `foot + d`**: no reach of the sheet can stop the clew
  //   anywhere, so it flies free and weathervanes. A full interval, `h = π`,
  //   which is inert rather than merely wide: `|centre|` is 12.6°, so
  //   `[centre − π, centre + π]` contains ±SWING_LIMIT whole, and the shroud
  //   clamp below is what actually bounds the swing. Measured unreachable from
  //   any cleatable clew — `jibSheetFor` is bounded by `chord + d`, and even at
  //   full camber the longest sheet it writes falls 0.66 m short of this — so
  //   it is a guard against a hand-built state rather than a live path.
  const half = !Number.isFinite(cosine) || cosine >= 1 ? 0 : cosine <= -1 ? Math.PI : acos(cosine);

  const settled = heldBetween(weathervane, centre - half, centre + half);
  // **Clamped to the shrouds like every other trim**, and held there *before*
  // `clampTrim` normalises. The interval is centred on `a₀` rather than on zero,
  // so `centre + half` can reach past ±SWING_LIMIT — measured at 92.01°, from a
  // jib cleated at the drag clamp and then borne away to a run. That is outside
  // the range `render/scene.ts` sweeps when it sizes the boat's swept disc, so
  // the clew would leave the disc the scene reserves for it. §5's rule is that
  // *every* site setting a sail angle routes through the clamp; the integrator
  // is a site. Why the order matters is {@link heldBetween}: a target deep by
  // the lee is deliberately unwrapped, and normalising it first would fold a
  // clew straining to port round onto the starboard shroud.
  return clampTrim(clearMast(heldBetween(settled, -SWING_LIMIT, SWING_LIMIT), side));
}

/**
 * The sheet length a clew position implies — the inverse of the above, and what
 * a release writes.
 *
 * Taken from the *car on the side the hand let go on*, which is the whole of how
 * a sheet gets chosen: dragging the clew across and releasing on the new side is
 * one gesture that both changes sheets and sets the new one's length, which is
 * "cast off one and haul the other" with no second control.
 */
export function jibSheetFor(clewAngle: Radians, side: number, chord: Meters = JIB.foot): Meters {
  const car = { x: side * JIB_CAR.x, y: JIB_CAR.y };
  return magnitude(subtract(jibClewPosition(clewAngle, chord), car));
}

/**
 * The trim whose **sheets hold the sails at the angles asked for** — trim to
 * here, then cleat it.
 *
 * The one honest way to say "put the sails there" now that a sheet is a limit
 * rather than a position. Setting `mainAngle` alone no longer does it: the next
 * step eases the boom back to wherever the wind and the sheet agree, so an angle
 * without a sheet to hold it is a wish rather than a trim.
 *
 * **The sign is the wind's, not the caller's**, and that goes for the jib too.
 * A sheet has no side: the magnitude of each angle becomes the limit and the
 * wind decides which side it is reached on. Ask for a windward angle and you get
 * its mirror, which is exactly what letting go of a backed sail does.
 *
 * The jib's *car* follows the same rule, and getting that wrong is worth
 * recording because it looked right: taking the side from `sign(jibAngle)`
 * cleats to whichever car the caller happened to name, which is the **windward**
 * one half the time. A jib sheeted to windward is a backed jib, so asking for
 * −35° in a wind on the port bow returned +9.8° — the far root of the sheet's
 * own circle, correctly computed and not at all what was asked. Every polar
 * sweep that named a leeward-signed angle was measuring a backed jib on one
 * tack.
 *
 * Used by the opening state, by the console, and by every test that means "the
 * boat is sailing at this trim" — which is most of them, and which is why this
 * lives in the model rather than in a test helper.
 */
export function cleatedAt(
  mainAngle: Radians,
  jibAngle: Radians,
  jibSet: boolean,
  apparent: ApparentWind,
): RigTrim {
  // Leeward, from the wind, and taken **through the same normalisation
  // `naturalMainAngle` uses** rather than from the raw angle. At exactly dead
  // downwind `apparent.angle` is +π — `angleOfVector` folds −π onto +π — so
  // `Math.sign(-angle)` gives −1 while `normalizeSigned(-π)` gives +π, and the
  // two functions put the boom on opposite sides. The symptom was a run built by
  // `cleatedAt` gybing itself within half a second of the first step, which is
  // every dead-run state in the polar sweep.
  const lee = Math.sign(normalizeSigned(-apparent.angle)) || 1;
  const main = lee * Math.abs(mainAngle);
  const jib = lee * Math.abs(jibAngle);
  return {
    mainAngle: main,
    mainSheet: Math.abs(mainAngle),
    jibAngle: jib,
    jibSheetSide: lee,
    jibSheet: jibSheetFor(jib, lee, jibChord(jib, apparent)),
    jibSet,
  };
}

/**
 * The jib's chord right now: how far its clew stands from its tack, once the
 * cloth has bellied.
 *
 * The one place the two halves meet — {@link camberDepth} says how full the sail
 * is, {@link chordForArc} says what that costs in span. Everything else takes
 * the answer as a number.
 */
export function jibChord(jibAngle: Radians, apparent: ApparentWind): Meters {
  return chordForArc(JIB.foot, camberDepth(JIB, jibAngle, apparent));
}

/**
 * How much of the sail has collapsed, measured from whichever edge the flow
 * arrives at (§3.3). {@link collapseFrom} says which edge that is.
 *
 * **Even about both edge-on states, not just about zero.** A sail lies along
 * the flow twice: at α = 0, where the wind arrives at the luff, and at
 * α = ±180°, where it arrives at the leech instead. Neither one is drawing —
 * `foil.ts` says so at both, reporting `Cl = 0` and `Cd = Cd0` at 180° as
 * surely as at 0° — so the measure is distance from *whichever is nearer*
 * rather than distance from zero. Folding about zero alone left this function
 * calling a sail flogging edge-on at its leech "fully drawing", which is a lie
 * the drawing then had to work around (pos-aa2).
 *
 * {@link LUFF}'s thresholds are magnitudes, which is what makes the fold about
 * zero correct across tacks; see the reasoning there. The band this second fold
 * adds is `|α| > 173°` and nothing else, so the rest of the polar is untouched
 * by construction.
 *
 * **The fraction alone does not say where the collapse is**, and it never did —
 * a bare number cannot, once it covers two states that break at opposite ends.
 * That is why it is reported beside {@link collapseFrom} rather than as a
 * fraction from the luff aft, which is what pos-aa2 left behind and pos-83f
 * fixed. The distinction is not a sliver: the fraction is 0.35 at α = 175° and
 * only reaches 1 at 178°, so through the first half of the leech-first band a
 * renderer working off the luff would shake the forward third of a sail whose
 * *after* end is the one letting go.
 *
 * Continuous, and `smoothstep` clamps, so no limb needs a branch.
 */
export function collapsedFraction(alpha: Radians): number {
  // Normalised first, or `π − |α|` goes negative for an angle that arrives
  // unwrapped and the clamp turns that into a confident "fully collapsed" —
  // α = 350°, which is really −10° and drawing, is the case that bites.
  const magnitude = Math.abs(normalizeSigned(alpha));

  // `min` has a corner at α = 90°, which ought to alarm anyone who has read
  // `smoothstep`'s docblock: §4.2's colour ramp reads driving-force gradients,
  // so a crease anywhere upstream shows. It is not one. 90° is more than ten
  // times {@link LUFF.drawingAbove}, so `smoothstep` is saturated at 1 with
  // zero slope on *both* sides of the corner and this comes out flat 0 through
  // it — the crease is there in the argument and absent from the result.
  const fromEdgeOn = Math.min(magnitude, Math.PI - magnitude);

  const span = LUFF.drawingAbove - LUFF.collapsedBelow;
  return 1 - smoothstep((fromEdgeOn - LUFF.collapsedBelow) / span);
}

/**
 * Which edge {@link collapsedFraction} is measured from: the edge the flow
 * arrives at.
 *
 * It falls straight out of the fold above. `min(|α|, 180° − |α|)` takes the
 * first term on one limb and the second on the other, and the limb *is* the
 * answer: below 90° the nearer edge-on state is α = 0, where the wind meets the
 * luff; above it the nearer one is ±180°, where the wind meets the leech.
 *
 * **The value is defined everywhere, and only meaningful where it is used.**
 * Between the two bands — every trim a student sails — the fraction is 0 and
 * nothing is collapsing, so this reports the edge a collapse *would* arrive at
 * rather than a fact about the cloth. The tie at exactly |α| = 90°, where both
 * edges are 90° away, is broken toward the luff and is unobservable for the
 * same reason: the fraction there is 0, and 90° is more than ten times
 * {@link LUFF.drawingAbove}, so nothing reads this without also reading a
 * fraction of zero.
 *
 * Sign-free, like the fraction: which *face* the flow strikes says nothing
 * about which *end* it arrives at, so both tacks answer alike.
 */
export function collapseFrom(alpha: Radians): CollapseEdge {
  return Math.abs(normalizeSigned(alpha)) > Math.PI / 2 ? "leech" : "luff";
}

/**
 * One sail's contribution to driving force.
 *
 * Lift acts across the apparent wind and drag along it. `perpendicular` turns
 * 90° clockwise, which is the correct side given that `Cl` is odd in α: on
 * starboard tack close hauled — AWA +30°, main eased 15° to port, α = +15° —
 * lift comes out bearing 300°, forward and to port, and drag bearing 210°,
 * netting ≈ +0.48·qA of drive.
 *
 * The collapsed fraction scales the *whole* force rather than lift alone. That
 * is the "effective area" reading of §3.3: the collapsed portion carries no
 * load of either kind. Which end that portion is at does not enter here — a
 * third of the sail carries a third of the load whichever third it is — so
 * {@link collapseFrom} is reported for the drawing's sake and spent by nothing
 * in this file. What the reduction drops is the flogging drag a real luffing
 * sail has, but at either edge-on state that drag is only `Cd0` ≈ 0.02, so the
 * simplification is invisible against a drawing sail's hundreds of newtons.
 */
export function sailForce(sail: Sail, sailAngle: Radians, apparent: ApparentWind): SailForce {
  const alpha = angleOfAttack(sailAngle, apparent);
  const collapsed = collapsedFraction(alpha);

  const { lift: cl, drag: cd } = foilCoefficients(alpha, sail.aspectRatio);
  const scaling = dynamicPressure(apparent.speed) * sail.area * (1 - collapsed);

  const flow = unitVector(oppositeAngle(apparent.angle));
  const force = add(scale(perpendicular(flow), cl * scaling), scale(flow, cd * scaling));

  return {
    angleOfAttack: alpha,
    collapsedFraction: collapsed,
    collapseFrom: collapseFrom(alpha),
    driving: componentAlong(force, AHEAD),
    lateral: componentAcross(force, AHEAD),
  };
}

/** Both sails, summed. */
export function rigForce(trim: RigTrim, apparent: ApparentWind): RigForce {
  const main = sailForce(MAIN, trim.mainAngle, apparent);
  const jib = trim.jibSet ? sailForce(JIB, trim.jibAngle, apparent) : null;

  return {
    main,
    jib,
    driving: main.driving + (jib?.driving ?? 0),
    lateral: main.lateral + (jib?.lateral ?? 0),
  };
}

// --- Depowering (§3.2) -----------------------------------------------------

/**
 * How much of the rig the crew are carrying, 0..1, from the true wind speed.
 *
 * Multiplies both the drive and the side force — {@link DEPOWERING} has the
 * shape, the constants, and the measurements behind them. In one line: full
 * sail up to `fullPowerWind`, and above it the rig makes the force it made
 * there and no more, because that is where the crew run out of righting moment
 * and start easing, feathering and spilling.
 *
 * **The one function in this file that reads the true wind**, which is worth
 * flagging in a module whose whole point is that sail forces come from the
 * apparent wind (§3.1). It does not break that rule: this is not an
 * aerodynamic coefficient, it is how much sail is being carried, and the crew
 * choose that for the wind of the day rather than for the flow over the cloth
 * at this instant. {@link DEPOWERING} records what keying it to the apparent
 * wind measured instead, which is a worse boat.
 *
 * **`simulation.ts` applies it, and this file deliberately does not.** Nothing
 * in {@link sailForce} or {@link optimalTrim} is scaled by it, so what they
 * report is the rig at full power. The reason is §4.2: the trim-quality colour
 * divides this trim's drive by the best trim's drive, and a factor common to
 * both cancels — except against the *floored* denominator
 * `max(best, 0.05·q·A)`, which carries no such factor. Scaling the forces here
 * would leave that floor binding further and further out as the breeze filled
 * in: measured, the apparent wind angle below which it binds would run from
 * 8.2° at 10 kt to 11.5° at 20, 17.3° at 30 and 30.3° at 45, creeping the
 * near-no-go fade across a third of the upwind quarter in a gale. Applying the
 * factor at the seam where the true wind meets the rig leaves §4.2 exactly as
 * pos-dmg.1 designed it, at every wind.
 *
 * The price of that seam is that {@link rigForce} reports a force which is not
 * the force accelerating the boat, and the names here carry the whole warning.
 * `main.ts`'s debug `report()` reads `rigForce` directly and so prints the
 * undepowered figure; pos-jhl covers giving it the carried one.
 *
 * Saturates rather than breaking at absurd winds: an infinite wind gives
 * exactly 0, not `NaN`.
 */
export function depoweringFactor(trueWindSpeed: MetersPerSecond): number {
  // `r` is the dynamic-pressure ratio, so that the factor below is the wind's
  // own square — the same square the sail force is built on, which is what
  // makes `k·q` flat above the knee instead of merely flatter.
  const pressureRatio = (trueWindSpeed / DEPOWERING.fullPowerWind) ** 2;

  return (1 + pressureRatio ** DEPOWERING.knee) ** (-1 / DEPOWERING.knee);
}

// --- Optimal trim ----------------------------------------------------------
//
// The angle that would extract the most drive from the wind as it stands. The
// trim-quality colour ramp (§4.2) divides by it, so it is recomputed every
// frame — affordable because a sail force is a handful of transcendentals and
// this takes well under a hundred of them per sail.
//
// The search evaluates the same `sailForce` used everywhere else, so the
// collapse reduction is inside it rather than beside it: §3.3's one number, one
// source of truth.

/** Spacing of the sweep across the legal range: 37 samples over ±90°. */
const COARSE_STEP: Radians = SWING_LIMIT / 18;
/** Each pass subdivides the bracket around a candidate into this many intervals. */
const REFINE_DIVISIONS = 8;
/** Two passes take 5° → 1.25° → 0.3125°, comfortably inside "within a degree". */
const REFINE_PASSES = 2;

/**
 * The trim angle that maximises driving force, and the force there.
 *
 * A coarse sweep of the legal range, then a local refinement around **every**
 * peak the sweep found, not just the tallest sample. The extra peaks matter in
 * one place: from a broad reach round to dead downwind the force curve grows a
 * second hump as the mirrored trim comes into play, and near AWA ≈ 180° the two
 * are within a fraction of a percent of each other at the coarse samples while
 * their true summits are not. Keeping only the best sample would let a rounding
 * difference decide which side of the boat the answer came from. The peaks are
 * few — `Cl` and `Cd` each turn over just once across the range, and each of
 * the two luff notches, at α = 0 and at α = ±180°, can split one — so at 37
 * coarse samples, 18 per peak and 19 for the seed below, this runs to some 60
 * to 150 evaluations, around 30 µs. Nothing beside a frame of rendering.
 *
 * The notch at ±180° only comes within reach on a deep angle, where a trim near
 * the centreline puts the flow on the leech, and it costs a refinement rather
 * than an answer: `refine` keeps whichever candidate stands highest, and the
 * force in that notch was `Cd0·q·A` before §3.3 zeroed it.
 *
 * The sweep is joined by one analytic candidate, {@link attachedTrimSeed},
 * which covers the one place a grid of any spacing is unsafe. See there.
 *
 * Two cases are reported honestly rather than special-cased:
 *
 * - **In irons.** Inside the no-go zone every trim gives `driving ≤ 0` — the
 *   sail cannot make enough forward lift to cover its own drag — and this
 *   returns the least-bad angle and a non-positive force. What the colour ramp
 *   does with a non-positive denominator is §4.2's problem (pos-dmg.1), not
 *   this module's. With zero apparent wind every trim ties at zero force and
 *   the search keeps the first angle it saw.
 * - **A dead run.** At AWA exactly 180° the two mirrored trims are a true tie
 *   and one is picked deterministically. Harmless: the quality ratio is 1.0
 *   either way, and a degree either side of dead downwind the tie breaks on its
 *   own — the search then follows it, which is the point of refining both.
 */
export function optimalTrim(
  sail: Sail,
  apparent: ApparentWind,
): { angle: Radians; driving: Newtons } {
  const angles: Radians[] = [];
  const forces: Newtons[] = [];
  const last = Math.round((2 * SWING_LIMIT) / COARSE_STEP);
  for (let i = 0; i <= last; i += 1) {
    // Measured from the limit each time rather than accumulated, so rounding
    // cannot drift the final sample off the swing limit.
    const angle = i === last ? SWING_LIMIT : -SWING_LIMIT + i * COARSE_STEP;
    angles.push(angle);
    forces.push(sailForce(sail, angle, apparent).driving);
  }

  let best = { angle: angles[0], driving: -Infinity };
  for (let i = 0; i <= last; i += 1) {
    // Strictly up into the sample and merely not-down out of it, so a plateau
    // of equal samples — a flat calm, where every trim gives zero — is taken
    // once, at its leading edge, rather than refined thirty-seven times.
    const rose = i === 0 || forces[i] > forces[i - 1];
    const falls = i === last || forces[i] >= forces[i + 1];
    if (!rose || !falls) continue;

    const refined = refine(sail, apparent, angles[i], forces[i]);
    if (refined.driving > best.driving) best = refined;
  }

  const seed = attachedTrimSeed(sail, apparent);
  if (seed !== null) {
    const refined = refine(sail, apparent, seed, sailForce(sail, seed, apparent).driving);
    if (refined.driving > best.driving) best = refined;
  }

  return best;
}

/**
 * The attached limb's optimum trim, worked out in closed form — or null where
 * that formula has nothing to say.
 *
 * **Why the sweep needs help here.** Coming out of the no-go zone the drive at
 * the best possible trim passes through zero, so the *window* of trims that
 * drive forward at all opens from nothing: for the main it is about 1.7° wide
 * at AWA 4.4° and does not reach 5° until AWA 4.7°. A 5° sweep can step over a
 * window that narrow and report a luffing trim on the wrong side of the boat
 * with `driving` of exactly zero — which is not the honest in-irons answer, and
 * which hands §4.2 a zero denominator when a real trim was available. Halving
 * the step would not fix it, only move the band: the window passes through
 * every width on its way open, including whatever the step happens to be.
 *
 * **The closed form.** On the attached limb `Cl = a·α` and
 * `Cd = Cd0 + a²α²/(π·AR·e)`, so §3.2's drive is a downward parabola in α:
 *
 * ```text
 * Cl·sin(AWA) − Cd·cos(AWA) = a·sin(AWA)·α − cos(AWA)·(Cd0 + a²α²/(π·AR·e))
 * ```
 *
 * whose peak sits at
 *
 * ```text
 * α* = π·AR·e·tan(AWA) / (2a)
 * ```
 *
 * — the exact answer for a limb of *linear* lift, `Cl = a·α`, which is what
 * the attached limb was when this seed was derived. Since pos-i4o it is not:
 * {@link FOIL.maxLift} bends the top over, so the expression above is an
 * approximation that improves the closer α* sits to zero. That costs nothing
 * here, for the reason the last paragraph gives — it is a candidate rather than
 * an answer — and the second condition below keeps it where the two agree
 * best: at the stall angle the saturation has moved the lift by 0.27%, and
 * below 11.5° of apparent wind, where this seed is the one that matters, by
 * far less.
 *
 * Two conditions bound it, and outside them the sweep is already comfortable:
 *
 * - `cos(AWA) > 0`. With the wind abaft the beam drag *helps*, the parabola
 *   opens upward, and `α*` is its minimum rather than its maximum.
 * - `|α*|` below the stall. Past it the true optimum is on the blend or the
 *   plate, whose features are tens of degrees wide — nothing a 5° sweep can
 *   step over. For the main this holds out to AWA ≈ 11.5°.
 *
 * It is only ever an extra candidate: `optimalTrim` keeps whichever of the
 * sweep's peaks and this one refines highest, so a seed that misjudges — it
 * ignores the collapse reduction, which still bites a little below α = 7° —
 * costs accuracy nowhere and 19 evaluations near the bow.
 */
function attachedTrimSeed(sail: Sail, apparent: ApparentWind): Radians | null {
  if (!(cos(apparent.angle) > 0)) return null;

  const alpha =
    (Math.PI * sail.aspectRatio * FOIL.spanEfficiency * tan(apparent.angle)) /
    (2 * liftCurveSlope(sail.aspectRatio));
  if (Math.abs(alpha) > FOIL.stallAngle) return null;

  // Inverting α = normalizeSigned(AWA + sailAngle), then held to a legal trim.
  return clampTrim(alpha - apparent.angle);
}

/**
 * Sharpens one coarse peak. Each pass brackets the best angle so far, divides
 * that bracket into eight, and keeps the winner — so the resolution improves
 * fourfold a pass, 5° → 1.25° → 0.3125°.
 */
function refine(
  sail: Sail,
  apparent: ApparentWind,
  around: Radians,
  driving: Newtons,
): { angle: Radians; driving: Newtons } {
  let best = { angle: around, driving };

  let step = COARSE_STEP;
  for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
    // Held inside the legal range, so a peak pinned to the swing limit — a
    // dead run, where the drive is pure drag — refines against the limit
    // instead of wandering past it.
    const low = Math.max(-SWING_LIMIT, best.angle - step);
    const high = Math.min(SWING_LIMIT, best.angle + step);
    step = (high - low) / REFINE_DIVISIONS;
    best = sweep(sail, apparent, low, high, step);
  }

  return best;
}

/**
 * The best of a set of evenly spaced trims, endpoints included. Ties keep the
 * earlier angle, which is what makes the search deterministic on a run.
 */
function sweep(
  sail: Sail,
  apparent: ApparentWind,
  low: Radians,
  high: Radians,
  step: Radians,
): { angle: Radians; driving: Newtons } {
  let bestAngle = low;
  let bestDriving = -Infinity;

  const samples = Math.round((high - low) / step);
  for (let i = 0; i <= samples; i += 1) {
    const angle = i === samples ? high : low + i * step;
    const { driving } = sailForce(sail, angle, apparent);
    if (driving > bestDriving) {
      bestAngle = angle;
      bestDriving = driving;
    }
  }

  return { angle: bestAngle, driving: bestDriving };
}
