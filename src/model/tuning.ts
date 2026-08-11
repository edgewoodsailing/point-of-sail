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

import type { Radians } from "./units.ts";
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
