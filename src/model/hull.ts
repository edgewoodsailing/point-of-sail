/**
 * What the water does about it (DESIGN.md §3.5).
 *
 * `sail.ts` says how hard the rig pulls; this module says how hard the hull
 * resists, and how much boat there is to accelerate. Between them
 * `simulation.ts` has everything it needs to integrate a speed.
 *
 * Two exports, and the second is the interesting one: {@link EFFECTIVE_MASS} is
 * *derived* from the acceleration lag in `tuning.ts` rather than stated. See
 * there for why the lag is the knob and the mass is the consequence.
 */

import { HULL } from "./boat.ts";
import { ACCELERATION, RESISTANCE } from "./tuning.ts";
import type { Kilograms, MetersPerSecond, Newtons } from "./units.ts";

/**
 * The exponent on the hull-speed term. **Not a tuning knob** — it is the shape
 * itself. Six is steep enough that the wall reads as a wall rather than as a
 * gentle discouragement, and moving it would change what the curve *means*,
 * where `RESISTANCE.hullSpeedWall` only changes how hard it bites.
 */
const WALL_EXPONENT = 6;

/**
 * The water's resistance at a given speed, **signed along the direction of
 * motion**: positive going forward, negative going astern.
 *
 * Signed this way so that §3.5's `F_drive − R(v)` can be written literally, with
 * no branch at the call site: resistance always opposes, and subtracting a
 * quantity that carries the sign of the velocity is what expresses that.
 *
 * Both terms are even in `v`, so the magnitude comes off `|v|` and the sign goes
 * on once at the end. Going astern the whole curve is multiplied by
 * `RESISTANCE.asternFactor` — the wall term included, which costs nothing since
 * the boat cannot get near hull speed backwards.
 */
export function hullResistance(speed: MetersPerSecond): Newtons {
  const magnitude = Math.abs(speed);
  const wallFactor = (magnitude / HULL.hullSpeed) ** WALL_EXPONENT;

  const resistance =
    magnitude *
    magnitude *
    (RESISTANCE.quadratic + RESISTANCE.hullSpeedWall * wallFactor) *
    (speed < 0 ? RESISTANCE.asternFactor : 1);

  return Math.sign(speed) * resistance;
}

/**
 * How fast the resistance grows with speed, `dR/dv`, in newtons per m/s.
 *
 * Never negative: the curve is even in `v` and signed to oppose the motion, so
 * both limbs slope the same way and a boat that speeds up always meets more
 * water, whichever way it is going.
 *
 * This exists for the integrator. Knowing the slope is what lets `simulation.ts`
 * take the resistance implicitly — solving for the force at the *end* of the
 * step rather than the start — which is what keeps a long frame or a wild wind
 * from ringing or blowing up. The arithmetic is in `advance` there.
 */
export function hullResistanceSlope(speed: MetersPerSecond): number {
  const magnitude = Math.abs(speed);

  // Differentiating `A·v² + B·v⁸/v_hull⁶` — the wall term written with the
  // powers gathered, which is the same curve `hullResistance` computes.
  const slope =
    2 * RESISTANCE.quadratic * magnitude +
    (WALL_EXPONENT + 2) *
      RESISTANCE.hullSpeedWall *
      (magnitude ** (WALL_EXPONENT + 1) / HULL.hullSpeed ** WALL_EXPONENT);

  return slope * (speed < 0 ? RESISTANCE.asternFactor : 1);
}

/**
 * The fraction of terminal speed that {@link ACCELERATION.timeToTerminal} is
 * quoted against: the standard `1 − 1/e` ≈ 63% of a first-order response.
 */
const TERMINAL_FRACTION = 1 - 1 / Math.E;

/**
 * The mass the drive force actually has to shift: boat, crew, and the water
 * dragged along with them. ≈ 877 kg.
 *
 * **Derived from the lag, not stated.** Under a steady drive against pure
 * quadratic drag,
 *
 * ```text
 * m·dv/dt = F − A·v²   ⟹   v(t) = v_terminal · tanh(t · A · v_terminal / m)
 * ```
 *
 * so the time to reach a given fraction of terminal speed is
 * `m · atanh(fraction) / (A · v_terminal)`, and inverting it for the mass gives
 * the line below. The payoff is that the felt lag is anchored to a number
 * someone can judge by watching, instead of drifting wherever a calibration
 * pass (pos-fo1.4) happens to leave it.
 *
 * **Anchored, not invariant.** Substituting the derived mass back in, the lag
 * comes out as `timeToTerminal · v_ref / v_terminal`: exactly the quoted ten
 * seconds for a boat that settles at the reference speed, and scaled by how far
 * from it the boat actually settles. Halve `A` and, at a given drive, the boat
 * settles faster and gets there in 6.9 s; double it and it takes 13.8 s. That
 * is the right direction — a boat that ends up quicker should feel quicker off
 * the mark — and it is a far tighter leash than leaving the mass alone would
 * be, but the ten seconds is a calibration anchor rather than a promise.
 *
 * **The wall term is deliberately left out of the mapping.** Right at hull speed
 * the curve is an order of magnitude stiffer, and inverting *that* slope would
 * derive a six-tonne boat: the lag we care about is the ordinary one, gathering
 * way on a reach, not the last tenth of a knot against the wall.
 *
 * `HULL.hullSpeed` stands in for `v_terminal` as a *scale* — a typical speed for
 * this boat under sail — and not as a claim about where it settles, which
 * depends on the trim and the wind. The result is only as sharp as that choice,
 * which is to say within a few percent, and the lag is a feel knob anyway.
 *
 * Worth noting where it lands: ≈ 877 kg, against §3.5's independently reasoned
 * 880 kg for boat + two crew + ~15% added mass. Two different routes to the same
 * number is a good sign the resistance coefficient is in the right decade.
 * `hull.test.ts` holds it to a plausible range, so a careless tuning pass cannot
 * quietly produce a barge or a dinghy.
 */
export const EFFECTIVE_MASS: Kilograms =
  (ACCELERATION.timeToTerminal * RESISTANCE.quadratic * HULL.hullSpeed) /
  Math.atanh(TERMINAL_FRACTION);
