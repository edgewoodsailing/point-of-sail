/**
 * What the water does about it (DESIGN.md §3.5).
 *
 * `sail.ts` says how hard the rig pulls; this module says how hard the water
 * resists, and how much boat there is to accelerate. Between them
 * `simulation.ts` has everything it needs to integrate a speed.
 *
 * The water charges twice. {@link hullResistance} is the hull's own drag, a
 * function of speed alone; {@link keelInducedDrag} is what it costs to be held
 * on a heading the wind is not blowing along, and it is the term that gives the
 * simulator a no-go zone. Keeping them apart keeps §3.5's curve readable as the
 * curve the design document writes down.
 *
 * {@link EFFECTIVE_MASS} is the odd one out: it is *derived* from the
 * acceleration lag in `tuning.ts` rather than stated. See there for why the lag
 * is the knob and the mass is the consequence.
 */

import { HULL } from "./boat.ts";
import { ACCELERATION, RESISTANCE } from "./tuning.ts";
import type { Kilograms, MetersPerSecond, Newtons } from "./units.ts";

/**
 * The exponent on the hull-speed term: **how much of the model's behaviour is
 * allowed to depend on the wind speed.** Not a knob to turn against the 10 kt
 * polar — that is `RESISTANCE.hullSpeedWall`'s job — but not the untouchable
 * shape it was once labelled either. pos-lcz moved it from 6 to 4, deliberately
 * and at a stated cost; §3.5 records the decision.
 *
 * **Why this constant, alone in the model, has that power.** Every force here
 * is homogeneous of degree two in speed: sail force is dynamic pressure times
 * coefficients that depend only on angles, the keel's induced drag is `F²/v²`
 * with `F` itself going as `v²`, and its stall ratio is capacity over load,
 * which is invariant when both scale together. Scale the true wind and the boat
 * speed by the same factor and every one of them scales by that factor squared,
 * leaving the polar's *shape* untouched. This term is the exception: `v_hull` is
 * an absolute speed, so `B·v⁸/v_hull⁶` scales by the eighth power instead. Set
 * `RESISTANCE.hullSpeedWall` to zero and re-solve the quadratic to hold the
 * 10 kt beam reach, and the polar becomes exactly scale-invariant — a 45° VMG
 * peak, a run at 0.58 of a beam reach, and a beam reach of 0.555 kt per knot of
 * wind, at every wind from 4 to 30 kt. So **the wall is the sole source of
 * wind-dependence in the model**, and everything the polar does as the breeze
 * fills in is this number's doing.
 *
 * **Which is why it cannot be raised to hold the speed down.** The wall bites
 * hardest where the boat is fastest, so it clips a reach harder than it clips
 * close hauled — and clipping the fast angles is what slides the upwind VMG
 * optimum to a *smaller* angle. Raising the exponent therefore buys a slower
 * beam reach in a breeze at the price of a boat that points ever higher in it,
 * which is the opposite of what a keelboat does. Four is that trade taken the
 * other way: it costs speed at the top of the wind range and buys back the
 * pointing and the reach-to-run gap across the 6–14 kt the simulator opens in.
 */
const WALL_EXPONENT = 4;

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

  // Differentiating `A·v² + B·v^(n+2)/v_hull^n` — the wall term written with the
  // powers gathered, which is the same curve `hullResistance` computes. Written
  // in terms of `WALL_EXPONENT` rather than its value so that it cannot drift
  // away from the curve when that constant moves, as it did in pos-lcz.
  const slope =
    2 * RESISTANCE.quadratic * magnitude +
    (WALL_EXPONENT + 2) *
      RESISTANCE.hullSpeedWall *
      (magnitude ** (WALL_EXPONENT + 1) / HULL.hullSpeed ** WALL_EXPONENT);

  return slope * (speed < 0 ? RESISTANCE.asternFactor : 1);
}

/**
 * What it costs to be held on course: the drag the keel makes generating the
 * side force the rig is pulling with, **signed along the direction of motion**
 * like {@link hullResistance}.
 *
 * **Why the model needs this at all.** Without it nothing in the simulator
 * charges the boat for sailing at a large angle to the wind. Sail drag is
 * already inside `Cd`, and the lateral force the rig makes — which close hauled
 * is more than twice the drive — simply vanished, because §7 rules out leeway
 * and heel and there was nothing else to spend it on. The result was a boat
 * that ran 29% fast close hauled and still made 3 kt at TWA 15°, where the
 * §3.6 table wants nothing useful inside about 45°. Scaling
 * {@link RESISTANCE.quadratic} could not fix it: it slows every point of sail
 * together, where the whole problem is that one end of the polar is wrong.
 *
 * **The far field.** A keel is a foil, so the drag of making side force `F` at
 * speed `v` is induced drag, `F²/(½ρ·v²·π·b²·e)` — quadratic in the load and
 * inverse in the dynamic pressure. Hence the `k·F²/v²` this reduces to at
 * speed, with `k` = {@link RESISTANCE.sideForce}.
 *
 * **Why it is not just that.** `F²/v²` runs away at low speed, and the runaway
 * is not physics: a keel asked for more lift than it can carry stalls, and the
 * boat answers by sliding sideways rather than by growing an unbounded drag.
 * Worse for a model with no leeway, an unbounded drag at rest would push a boat
 * with its sails sheeted *backwards* — TWA 20° from a standstill was a clear
 * case — and, being a drag, it would reverse as soon as the boat did, leaving
 * the speed chattering about zero.
 *
 * So the keel is given a stall. Writing `x` for how much lift it can carry
 * relative to how hard it is being asked to pull — capacity over load, which
 * grows with `v²` because that is what a foil's capacity does — the drag is
 * `k·F²/v²` scaled by `x²/(1 + x²)`: the unstalled foil where there is capacity
 * to spare, and a flat plate's `v²` where there is not, which goes to zero at
 * rest as any water drag must. Gathering the algebra, with `S` the `v²` at
 * which the keel is fully loaded, so that `x = v²/S`,
 *
 * ```text
 * D = k·F²·v² / (v⁴ + S²)
 * ```
 *
 * even in `v` and smooth through zero. `S` is set from
 * {@link RESISTANCE.keelStall}, which is where the two limbs cross and so the
 * largest fraction of the side force this can ever charge as drag — a maximum
 * drag angle, in the sense that a keel making `F` while dragging `0.2·F` is
 * crabbing at about 11°.
 */
export function keelInducedDrag(speed: MetersPerSecond, sideForce: Newtons): Newtons {
  const load = Math.abs(sideForce);

  // Both zeroes taken early, and not only for the arithmetic they save. At rest
  // the ratio below is 0/0 — the numerator carries a `v²`, and the denominator
  // is `S²`, which underflows to zero once the side force is small enough
  // (1e-200 N does it). A NaN reaching the integrator would poison the speed
  // permanently, since every later step adds to it, which is the same failure
  // `clampStep` in `simulation.ts` exists to prevent. Cheaper to close here
  // than to reason about how small a side force can get.
  if (speed === 0 || load === 0) return 0;

  // Where the unstalled limb `k·F²/v²` and the stalled limb cross. The peak of
  // the blend sits there, at exactly `keelStall · F`, which is what makes that
  // constant readable as the largest drag the keel can charge.
  const saturation = (RESISTANCE.sideForce * load) / (2 * RESISTANCE.keelStall);
  const v2 = speed * speed;

  return (
    Math.sign(speed) *
    ((RESISTANCE.sideForce * load * load * v2) / (v2 * v2 + saturation * saturation))
  );
}

/**
 * The fraction of terminal speed that {@link ACCELERATION.timeToTerminal} is
 * quoted against: the standard `1 − 1/e` ≈ 63% of a first-order response.
 */
const TERMINAL_FRACTION = 1 - 1 / Math.E;

/**
 * The mass the drive force actually has to shift: boat, crew, and the water
 * dragged along with them. ≈ 1092 kg.
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
 * Worth noting where it lands, and where it used to. Before pos-fo1.4 this came
 * out at ≈ 877 kg against §3.5's independently reasoned 880 kg for boat + two
 * crew + ~15% added mass, and the agreement was quoted as a check on both.
 * Calibration raised {@link RESISTANCE.quadratic} by a quarter and carried the
 * mass to ≈ 1092 kg with it, so the two routes now differ by 24%.
 *
 * That is the anchor stretching, not breaking, and it is worth being plain
 * about which of the two numbers moved. The 880 kg is a real fact about a
 * loaded Rhodes 19; this figure is what the ten-second lag *implies* given how
 * draggy the boat turned out to be, at a reference speed the derivation admits
 * is a scale rather than a claim. Read the gap either as the boat feeling a
 * little heavier off the mark than its displacement argues for, or as the
 * resistance sitting at the top of its plausible range — the calibration
 * evidence does not distinguish them, and neither reading is worth trading the
 * felt lag for. `hull.test.ts` holds the result to a plausible range, so a
 * careless tuning pass cannot quietly produce a barge or a dinghy; there is
 * about 10% of headroom left in that range, and a pass that needs more should
 * argue about the band or shorten the lag, not widen the band in silence.
 */
export const EFFECTIVE_MASS: Kilograms =
  (ACCELERATION.timeToTerminal * RESISTANCE.quadratic * HULL.hullSpeed) /
  Math.atanh(TERMINAL_FRACTION);
