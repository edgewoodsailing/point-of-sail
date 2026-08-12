/**
 * Every fudge factor, in one file (DESIGN.md §6).
 *
 * The rule that gives this module its point: **a number's file says whether it
 * is physics or taste.** Measurements of the boat live in `boat.ts`; anything
 * that will be adjusted against the running simulator until it *feels* right
 * lives here. Collecting them makes the calibration phase (§3.6) a matter of
 * turning knobs rather than hunting constants, and — since a fudge factor in a
 * file named `tuning.ts` is visibly a fudge factor — keeps us honest about
 * which is which.
 *
 * The file grows a section at a time, added by whichever bead first needs the
 * knob: foil coefficients here, then luff thresholds, hull resistance and the
 * acceleration lag, the upwind jib bonus (§3.7), and the colour ramp anchors
 * (§4.4). Nothing in here is imported by `boat.ts` — the dependency runs one
 * way, so that a tuning pass can never quietly restate a measurement.
 */

import type { Radians, Seconds } from "./units.ts";
import { degreesToRadians } from "./units.ts";

/**
 * Foil coefficients (§3.2). All four are shared by both sails: the main and the
 * jib differ in area and aspect ratio, which are measurements and live in
 * `boat.ts`, but nothing we know about a Rhodes 19's sailcloth argues for
 * giving them different profile drag or a different stall angle.
 */
export const FOIL: {
  readonly profileDrag: number;
  readonly spanEfficiency: number;
  readonly stallAngle: Radians;
  readonly stallBlendWidth: Radians;
} = {
  /** `Cd0` — the drag a sail carries at zero incidence, before induced drag. */
  profileDrag: 0.02,

  /**
   * `e`, the Oswald span efficiency in `Cd_induced = Cl²/(π·AR·e)`. Below 1
   * because a real sail's lift is not distributed elliptically over its span.
   */
  spanEfficiency: 0.9,

  /**
   * Where attached flow gives up. Together with the lift-curve slope it sets
   * peak lift, so the two cannot be tuned separately — move this angle and peak
   * lift moves with it.
   *
   * On the main, `Cl` reaches 1.40 here, the figure §3.2 quotes. That is not
   * quite the maximum: the smoothstep blend leaves this angle with zero slope,
   * so the attached limb keeps climbing for another degree or so and the curve
   * actually tops out at ≈ 1.46 near 19.7°. Both are realistic for a soft sail,
   * but the optimal-trim search will settle on the second one, so it is the
   * number to have in mind when reading the calibration table.
   */
  stallAngle: degreesToRadians(18),

  /**
   * How far past the stall the blend into the flat-plate limb takes to
   * complete. A soft sail stalls gradually rather than dropping off a cliff,
   * and the width is what expresses that.
   */
  stallBlendWidth: degreesToRadians(10),
};

/**
 * Luffing (§3.3). How much incidence a sail needs before it stops shaking and
 * starts pulling.
 *
 * **Both are magnitudes of the angle of attack, not signed thresholds.** §3.3
 * originally quoted them signed — drawing above +2°, luffing below −5° — which
 * reads naturally until you notice that `foil.ts` is deliberately odd in α: a
 * well-trimmed sail sits at α ≈ +15° on starboard tack and α ≈ −15° on port,
 * because the sign says which *face* the flow strikes, not whether the trim is
 * any good. Taken signed, the whole port tack would luff, and a backed sail
 * (large negative α) would carry no force at all — which would break the
 * mooring departure §3.4 is built around. Folded about zero the rule mirrors
 * correctly across tacks and a backed sail draws fully, in reverse.
 *
 * What the fold gives up is camber asymmetry — a real cambered sail keeps
 * drawing a little past nominal zero incidence, on one side only. Representing
 * that honestly needs memory of which side the camber has popped to, which this
 * model does not carry.
 */
export const LUFF: {
  readonly collapsedBelow: Radians;
  readonly drawingAbove: Radians;
} = {
  /** At or below this `|α|` the sail is wholly collapsed and carries nothing. */
  collapsedBelow: degreesToRadians(2),

  /**
   * At or above this `|α|` the sail is wholly full. The 5° between the two is
   * the transition width — how gradually the collapse propagates aft — and is
   * the knob to move if the shake looks too abrupt or too mushy.
   */
  drawingAbove: degreesToRadians(7),
};

/**
 * Hull resistance (§3.5), in
 *
 * ```text
 * R(v) = A·v² + B·v²·(v / v_hull)⁶
 * ```
 *
 * Both coefficients are in N·s²/m², and `v_hull` is a *measurement* — it lives
 * in `boat.ts` as `HULL.hullSpeed`, ≈ 2.90 m/s — so it is not a knob and is not
 * restated here.
 *
 * **These are starting values, not calibrated ones.** pos-fo1.4 tunes them until
 * the polar hits §3.6; what this file fixes now is the shape and the units, so
 * that the tuning pass has knobs to turn rather than constants to hunt.
 */
export const RESISTANCE: {
  readonly quadratic: number;
  readonly hullSpeedWall: number;
  readonly asternFactor: number;
} = {
  /**
   * `A` — ordinary resistance, quadratic in speed, which is what the boat feels
   * everywhere below hull speed.
   *
   * It is also the one constant the acceleration lag is derived through (see
   * `hull.ts`), so it cannot be moved without moving the effective mass with
   * it. That is deliberate: the *felt* lag is what §3.5 pins, not the mass.
   */
  quadratic: 22.5,

  /**
   * `B` — the wall. Reads as *the extra resistance at exactly hull speed*,
   * since the sixth-power factor is 1 there: starting equal to `A`, so
   * resistance doubles at 5.65 kt and has nearly tripled 20% past it.
   *
   * The sixth power is a shape, not a theory. What it has to produce is the
   * wall a displacement hull hits — no amount of sail area gets a Rhodes 19 to
   * 9 knots — and it is the exponent, not this coefficient, that makes the
   * curve turn up hard. Move this to set *where* the wall bites; the exponent
   * in `hull.ts` is not a knob.
   */
  hullSpeedWall: 22.5,

  /**
   * How much draggier the boat is going backwards. Multiplies the whole curve,
   * both terms.
   *
   * Transom-first with a stalled keel and rudder genuinely is much worse than
   * this figure would suggest for a fair hull, and that is the point: a student
   * backing off a mooring (§3.4) should feel that sternway is slow and hard
   * won. The wall term comes along for the ride, which costs nothing — the boat
   * cannot get near hull speed astern.
   */
  asternFactor: 2.5,
};

/**
 * How long the boat takes to get going (§3.5).
 *
 * **Expressed as a time, not as a mass.** §3.5 quotes `m_effective` ≈ 880 kg —
 * boat, two crew, and ~15% added mass — but the mass is not what anyone can
 * judge by watching the simulator. The lag is: trim in properly and the speed
 * arrow takes its time. So the knob is the observable and `hull.ts` derives the
 * mass from it, which keeps a calibration pass on {@link RESISTANCE.quadratic}
 * from moving the lag out from under us. It ties the two together rather than
 * freezing the lag outright — see `EFFECTIVE_MASS` for how far the anchor
 * holds.
 */
export const ACCELERATION: {
  readonly timeToTerminal: Seconds;
} = {
  /**
   * Time from rest to ~63% (1 − 1/e) of terminal speed, under a steady drive.
   *
   * About right for a keelboat, and the lag is itself a lesson — trim changes
   * do not pay off instantly. If it reads as sluggish when comparing two trim
   * settings back to back, shorten it; this is a feel decision to be made
   * against the running thing.
   */
  timeToTerminal: 10,
};
