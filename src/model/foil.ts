/**
 * Lift and drag coefficients for a sail treated as a thin cambered foil of
 * finite span (DESIGN.md §3.2).
 *
 * Two limbs joined by a blend:
 *
 * - **Attached flow**, near zero incidence, where the sail behaves like a wing:
 *   lift rises linearly with angle of attack and drag is profile drag plus the
 *   induced drag that lift costs.
 * - **The flat plate**, past the stall, where the sail is simply an obstruction:
 *   a normal force `Cn = k·sinα` resolved into `Cl = k sinα cosα`,
 *   `Cd = Cd0 + k sin²α`. The coefficient `k` is
 *   {@link FOIL.plateNormalForce} — a tuning knob, because how much force a
 *   soft sail makes when it has stopped being a foil is exactly the sort of
 *   thing the calibration pass has to settle.
 *
 * The flat-plate limb is not a detail — it is what makes downwind sailing work
 * at all. On a dead run the sail sits square to the apparent wind at α = 90°,
 * where lift is zero and drag is the whole story: the boat is being pushed,
 * not lifted, and the model has to say so.
 *
 * This module knows nothing about the Rhodes 19. Aspect ratio is a parameter,
 * so the curves can be exercised at any span and `sail.ts` supplies
 * `MAIN.aspectRatio` or `JIB.aspectRatio` from `boat.ts` at the call site.
 */

import type { Radians } from "./units.ts";
import { cos, normalizeSigned, sin, smoothstep, TAU } from "./units.ts";
import { FOIL } from "./tuning.ts";

export interface FoilCoefficients {
  /** `Cl`. Odd in the angle of attack: flow on the other face reverses it. */
  readonly lift: number;
  /** `Cd`. Even in the angle of attack — drag does not care which face. */
  readonly drag: number;
}

/**
 * The lift-curve slope `a = 2π·AR / (AR + 2)`, in per-radian.
 *
 * Thin-aerofoil theory gives 2π for a wing of infinite span; the correction
 * accounts for the tip losses of a real one. A Rhodes 19 main (AR ≈ 4.86)
 * comes out at ≈ 4.45 /rad, about 0.078 /deg.
 */
export function liftCurveSlope(aspectRatio: number): number {
  return (TAU * aspectRatio) / (aspectRatio + 2);
}

/**
 * `Cl` and `Cd` for an angle of attack and an aspect ratio.
 *
 * The angle of attack is the signed angle from the apparent wind to the sail's
 * chord: positive and negative describe flow on opposite faces, and the
 * coefficients carry that through — lift reverses sign, drag does not.
 *
 * **Past 90° is flat plate all the way to 180°.** The blend depends only on
 * `|α|`, so everything beyond the stall plus the blend width sits on the plate
 * limb, and the plate formulae are already antisymmetric about 90° in lift and
 * symmetric in drag. That covers the case where the flow arrives at the leech —
 * a boom eased to starboard with the wind on the starboard beam, say — without
 * any special handling. We deliberately do *not* blend back into a reversed
 * attached limb near 180°: a soft sail cannot hold a foil shape backwards, so
 * modelling one would invent lift the boat does not have.
 */
export function foilCoefficients(angleOfAttack: Radians, aspectRatio: number): FoilCoefficients {
  const alpha = normalizeSigned(angleOfAttack);

  const attachedLift = liftCurveSlope(aspectRatio) * alpha;
  const attachedDrag =
    FOIL.profileDrag + (attachedLift * attachedLift) / (Math.PI * aspectRatio * FOIL.spanEfficiency);

  const sinAlpha = sin(alpha);
  const plateLift = FOIL.plateNormalForce * sinAlpha * cos(alpha);
  const plateDrag = FOIL.profileDrag + FOIL.plateNormalForce * sinAlpha * sinAlpha;

  // Smoothstep rather than a linear ramp so the blended curve leaves the
  // attached limb at the stall with the attached limb's slope and joins the
  // plate at the far end with the plate's: C¹ at both junctions, not merely
  // continuous. A kink at 18° would show up in the §4.2 colour ramp.
  const stalled = smoothstep((Math.abs(alpha) - FOIL.stallAngle) / FOIL.stallBlendWidth);

  return {
    lift: attachedLift + stalled * (plateLift - attachedLift),
    drag: attachedDrag + stalled * (plateDrag - attachedDrag),
  };
}
