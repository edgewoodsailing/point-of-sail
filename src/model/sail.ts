/**
 * Trim angles → driving force (DESIGN.md §3.2–§3.3).
 *
 * `wind.ts` says what the sails feel and `foil.ts` says what a foil does with
 * an angle of attack; this module is the piece between them. It turns each
 * sail's trim into an angle of attack, assembles lift and drag into a force,
 * takes the along-heading component as drive, and finds the trim that maximises
 * it.
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
import { clampTrim, JIB, MAIN, sailChordBearing, SWING_LIMIT } from "./boat.ts";
import { foilCoefficients, liftCurveSlope } from "./foil.ts";
import { FOIL, LUFF } from "./tuning.ts";
import type { ApparentWind } from "./wind.ts";
import type { MetersPerSecond, Newtons, Radians } from "./units.ts";
import {
  add,
  angleBetween,
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

export interface SailForce {
  /**
   * The signed angle from the sail's chord to the apparent wind. Its sign says
   * which face the flow strikes — a well-trimmed sail runs positive on
   * starboard tack and negative on port — not whether the trim is good.
   */
  readonly angleOfAttack: Radians;
  /** How much of the sail, measured from the luff aft, has collapsed: 0..1. */
  readonly luffFraction: number;
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
  readonly mainAngle: Radians;
  readonly jibAngle: Radians;
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
 * How much of the sail has collapsed, from the luff aft (§3.3).
 *
 * **Even about both edge-on states, not just about zero.** A sail lies along
 * the flow twice: at α = 0, where the wind arrives at the luff, and at
 * α = ±180°, where it arrives at the leech instead. Neither one is drawing —
 * `foil.ts` says so at both, reporting `Cl = 0` and `Cd = Cd0` at 180° as
 * surely as at 0° — so the measure is distance from *whichever is nearer*
 * rather than distance from zero. Folding about zero alone left this function
 * calling a sail flogging edge-on at its leech "fully drawing", which is a lie
 * the drawing then has to work around (pos-aa2).
 *
 * {@link LUFF}'s thresholds are magnitudes, which is what makes the fold about
 * zero correct across tacks; see the reasoning there. The band this second fold
 * adds is `|α| > 173°` and nothing else, so the rest of the polar is untouched
 * by construction.
 *
 * Continuous, and `smoothstep` clamps, so no limb needs a branch.
 */
export function luffFraction(alpha: Radians): number {
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
 * One sail's contribution to driving force.
 *
 * Lift acts across the apparent wind and drag along it. `perpendicular` turns
 * 90° clockwise, which is the correct side given that `Cl` is odd in α: on
 * starboard tack close hauled — AWA +30°, main eased 15° to port, α = +15° —
 * lift comes out bearing 300°, forward and to port, and drag bearing 210°,
 * netting ≈ +0.48·qA of drive.
 *
 * The luff fraction scales the *whole* force rather than lift alone. That is
 * the "effective area" reading of §3.3: the collapsed portion, measured from
 * the luff aft, carries no load of either kind. What it drops is the flogging
 * drag a real luffing sail has — but at either edge-on state that drag is only
 * `Cd0` ≈ 0.02, so the simplification is invisible against a drawing sail's
 * hundreds of newtons.
 */
export function sailForce(sail: Sail, sailAngle: Radians, apparent: ApparentWind): SailForce {
  const alpha = angleOfAttack(sailAngle, apparent);
  const luffing = luffFraction(alpha);

  const { lift: cl, drag: cd } = foilCoefficients(alpha, sail.aspectRatio);
  const scaling = dynamicPressure(apparent.speed) * sail.area * (1 - luffing);

  const flow = unitVector(oppositeAngle(apparent.angle));
  const force = add(scale(perpendicular(flow), cl * scaling), scale(flow, cd * scaling));

  return {
    angleOfAttack: alpha,
    luffFraction: luffing,
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

// --- Optimal trim ----------------------------------------------------------
//
// The angle that would extract the most drive from the wind as it stands. The
// trim-quality colour ramp (§4.2) divides by it, so it is recomputed every
// frame — affordable because a sail force is a handful of transcendentals and
// this takes well under a hundred of them per sail.
//
// The search evaluates the same `sailForce` used everywhere else, so the luff
// reduction is inside it rather than beside it: §3.3's one number, one source
// of truth.

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
 * — the exact answer wherever the flow is attached and the luff is drawing,
 * which is precisely the regime the sweep struggles with. Two conditions bound
 * it, and outside them the sweep is already comfortable:
 *
 * - `cos(AWA) > 0`. With the wind abaft the beam drag *helps*, the parabola
 *   opens upward, and `α*` is its minimum rather than its maximum.
 * - `|α*|` below the stall. Past it the true optimum is on the blend or the
 *   plate, whose features are tens of degrees wide — nothing a 5° sweep can
 *   step over. For the main this holds out to AWA ≈ 11.5°.
 *
 * It is only ever an extra candidate: `optimalTrim` keeps whichever of the
 * sweep's peaks and this one refines highest, so a seed that misjudges — it
 * ignores the luff reduction, which still bites a little below α = 7° — costs
 * accuracy nowhere and 19 evaluations near the bow.
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
