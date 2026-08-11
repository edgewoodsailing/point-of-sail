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
   * Where attached flow gives up. Together with the lift-curve slope this sets
   * `Cl_max` ≈ 1.4 on the main, a realistic figure for a soft sail — so moving
   * this angle moves peak lift with it, and the two cannot be tuned separately.
   */
  stallAngle: degreesToRadians(18),

  /**
   * How far past the stall the blend into the flat-plate limb takes to
   * complete. A soft sail stalls gradually rather than dropping off a cliff,
   * and the width is what expresses that.
   */
  stallBlendWidth: degreesToRadians(10),
};
