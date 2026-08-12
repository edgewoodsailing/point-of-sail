/**
 * Lift and drag coefficients for a sail treated as a thin cambered foil of
 * finite span (DESIGN.md §3.2).
 *
 * Two limbs joined by a blend:
 *
 * - **Attached flow**, near zero incidence, where the sail behaves like a wing:
 *   lift rises linearly with angle of attack and turns over at a maximum of its
 *   own, {@link FOIL.maxLift}; drag is profile drag plus the induced drag the
 *   incidence costs.
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
 * **Why the attached limb has a maximum, and why that is not a detail**
 * (pos-i4o). It used to be `Cl = a·α` with nothing bounding it, so the curve's
 * peak was wherever the crossfade happened to catch the ramp on its way past —
 * a number the model produced rather than a number the model held. Two things
 * followed. The peak could not be tuned without moving the falloff and vice
 * versa, because they were the same knob. And the descent from that accidental
 * peak was *steeper than the attached limb's own rise* — 0.102/deg down against
 * 0.078/deg up — which is what made the boat bistable: slowing swings the
 * apparent wind aft, which raises α, which past the peak cuts lift, which slows
 * the boat. Give the limb its own maximum and the peak becomes a stated
 * quantity, the falloff is the blend's business alone, and the loop no longer
 * closes. `calibration.test.ts` holds the boat to one settled speed per trim.
 *
 * The stall is still the crossfade's doing, and the blend is not redundant:
 * with the maximum in place but the blend left at its old 20°, the fold comes
 * straight back — 2.40 kt at 6 kt of wind. Both halves are load-bearing.
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

  // What thin-aerofoil theory asks for, before the sail's own maximum is
  // applied. This is *not* a lift the sail ever makes at large incidence — it
  // reaches 4.66 at 60° — but it is still the right measure of how hard the
  // sail is being asked to work, which is why the drag below is charged
  // against it.
  const demandedLift = liftCurveSlope(aspectRatio) * alpha;

  // The attached limb turns over at a maximum of its own (pos-i4o), rather than
  // climbing linearly until the blend happens to pull it down. Same
  // rounded-corner `min` as DEPOWERING's `k(W)`: exact for small incidence,
  // asymptotic to `maxLift`, and C¹ everywhere in between.
  const attachedLift =
    demandedLift /
    Math.pow(
      1 + Math.pow(Math.abs(demandedLift / FOIL.maxLift), FOIL.saturationSharpness),
      1 / FOIL.saturationSharpness,
    );

  // **Drag is charged against the lift demanded, not the lift delivered**, and
  // that is the load-bearing half of this pair. Below the maximum the two are
  // the same number and this is ordinary induced drag. Past it, the incidence
  // the sail cannot turn into lift goes into separating flow instead, which
  // costs drag and pays nothing — so the sail goes on being charged for being
  // over-sheeted while its lift has stopped answering. That is what a stall
  // *is*, and charging the delivered lift here instead brings back the fold
  // this whole shape exists to remove (measured: 0.70 kt at 3 kt of wind,
  // 1.00 at 6). It is also unchanged from before the cap existed, when this
  // term was charged against the same linear expression.
  const attachedDrag =
    FOIL.profileDrag + (demandedLift * demandedLift) / (Math.PI * aspectRatio * FOIL.spanEfficiency);

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
