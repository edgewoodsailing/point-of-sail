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

/**
 * Where the boom goes on its own: **downwind until the sheet stops it.**
 *
 * ## The whole derivation, because it is two lines and it is the point
 *
 * With no hand on it, a boom is a weathervane pivoting on the mast. It comes to
 * rest where the sail has stopped pushing it round, which is where the cloth
 * lies along the flow — {@link angleOfAttack} zero. From the definition above,
 * α = 0 needs `sailChordBearing(a) = oppositeAngle(awa)`, and since
 * `sailChordBearing(a) = π − a` that is `π − a = awa + π`, so:
 *
 * ```text
 *   weathervane angle = −awa
 * ```
 *
 * The sheet then does the only thing a rope can: it stops the boom going
 * further out than `sheet`, on whichever side the wind has taken it. So
 *
 * ```text
 *   natural angle = clamp(−awa, −sheet, +sheet)
 * ```
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
 * - **Tacking and gybing, for free.** Turn the boat and `awa` changes sign; the
 *   clamp changes side with it and the boom crosses on its own. A gybe is the
 *   dramatic one — bear away through dead downwind and `−awa` swings from just
 *   inside `+π` to just inside `−π`, so the boom goes from one stop to the
 *   other with nothing in between.
 * - **Backing, and pos-bql.2's swing-back, derived rather than animated.** Push
 *   the boom to windward and let go: `sheet` is whatever you held it at, the
 *   wind is on the other side, so the natural angle is `−sheet` — the *mirror*
 *   of where you had it. That is pos-bql.2's specified behaviour, "same trim,
 *   other side", arrived at without a swing-back animation existing.
 *
 * ## The feedback loop this creates, which is real and worth having
 *
 * Ease too far, the sail flogs, the boat slows — and as it slows the apparent
 * wind swings *aft*, so `|awa|` grows, the clamp starts binding again and the
 * sail refills. It is a stable loop with a genuine lesson in it, and it is not
 * something anyone wrote: it is `apparentWind` and this clamp interacting.
 */
export function naturalMainAngle(sheet: Radians, apparent: ApparentWind): Radians {
  const weathervane = normalizeSigned(-apparent.angle);
  return Math.min(Math.max(weathervane, -sheet), sheet);
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
 *   natural jib angle = clamp(−awa, a₀ − h, a₀ + h)
 *       a₀ = the angle whose clew lies nearest the car (12.6° to the car's side)
 *       h  = acos(C), how far the sheet lets it swing either way from there
 * ```
 *
 * That is {@link naturalMainAngle} with the interval shifted off centre. The
 * main is the special case where the car is on the centreline, so `a₀ = 0` and
 * the interval is symmetric — which is exactly why a boom tacks itself.
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
  sheet: Meters,
  side: number,
  apparent: ApparentWind,
): Radians {
  const car = { x: side * JIB_CAR.x, y: JIB_CAR.y };
  const w = subtract(car, STATIONS.jibTack);
  const d = magnitude(w);
  const foot = JIB.foot;

  // The clew nearest the car: chord bearing straight at it, so a₀ = π − β.
  const centre = sailChordBearing(angleOfVector(w));
  const weathervane = normalizeSigned(-apparent.angle);

  const cosine = (foot * foot + d * d - sheet * sheet) / (2 * foot * d);
  // Sheet hauled shorter than the geometry allows — |foot − d| — so both
  // constraints cannot hold at once. The cloth wins: the clew goes to the point
  // on the foot circle nearest the car and the sheet is simply bar taut.
  if (cosine >= 1) return centre;
  // Longer than `foot + d`: no reach of the sheet can stop the clew anywhere, so
  // it flies free and weathervanes.
  if (cosine <= -1) return weathervane;

  const half = acos(cosine);
  const gap = normalizeSigned(weathervane - centre);
  return normalizeSigned(centre + Math.min(Math.max(gap, -half), half));
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
export function jibSheetFor(clewAngle: Radians, side: number): Meters {
  const car = { x: side * JIB_CAR.x, y: JIB_CAR.y };
  return magnitude(subtract(jibClewPosition(clewAngle), car));
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
