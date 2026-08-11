/**
 * True wind → apparent wind (DESIGN.md §3.1).
 *
 * ```text
 * V_apparent = V_trueWind − V_boat
 * ```
 *
 * with `V_boat` along the heading, since the model has no leeway (§7). Every
 * sail force in the simulator is computed from the result and never from the
 * true wind. That is not a refinement — it is the thing the simulator exists to
 * teach. It is why close-hauled trim is tighter than a student expects, and why
 * the wind draws forward as the boat accelerates.
 *
 * Both angles here are stored the way sailors say them: the direction the wind
 * blows **from**.
 */

import type { MetersPerSecond, Radians } from "./units.ts";
import {
  angleOfVector,
  magnitude,
  oppositeAngle,
  subtract,
  toBoatFrame,
  vectorFromAngle,
} from "./units.ts";

/** The wind over the water, in the world frame. */
export interface TrueWind {
  /** The direction it blows from, as a world bearing. */
  readonly from: Radians;
  readonly speed: MetersPerSecond;
}

/** How the boat is moving. Speed is signed; negative is sternway (§3.4). */
export interface BoatMotion {
  readonly heading: Radians;
  readonly speed: MetersPerSecond;
}

/** The wind the sails actually feel. */
export interface ApparentWind {
  readonly speed: MetersPerSecond;
  /**
   * The apparent wind angle, off the bow, in (−π, π]: zero is head to wind,
   * ±π is dead downwind, and the sign gives the tack — positive means the wind
   * is on the starboard bow.
   */
  readonly angle: Radians;
}

/**
 * How slow the apparent wind has to be before its direction is meaningless.
 * A zero vector has no bearing, and near-zero has an ill-conditioned one.
 */
const CALM: MetersPerSecond = 1e-9;

/**
 * The apparent wind, from the true wind and the boat's motion.
 *
 * Grouped arguments rather than four positional ones on purpose: `from` and
 * `heading` are both bearings, and both speeds are `MetersPerSecond`, so a
 * transposed pair would type-check in silence and produce a plausible, wrong
 * boat. Same reasoning that keeps raw trigonometry in `units.ts`.
 */
export function apparentWind(wind: TrueWind, boat: BoatMotion): ApparentWind {
  const trueWindVelocity = vectorFromAngle(oppositeAngle(wind.from), wind.speed);
  const boatVelocity = vectorFromAngle(boat.heading, boat.speed);
  const apparent = subtract(trueWindVelocity, boatVelocity);
  const speed = magnitude(apparent);

  // Running dead downwind at exactly true wind speed cancels the vectors
  // outright. Report the true wind's angle off the bow, which is the direction
  // the apparent wind returns from: resistance always decelerates, so the boat
  // can only leave that knife-edge by slowing, and the apparent wind fills in
  // from astern. Falling through to zero instead would read as head to wind and
  // flick every sail to luffing for a frame.
  if (speed < CALM) {
    return { speed: 0, angle: trueWindAngle(wind, boat) };
  }

  return {
    speed,
    angle: toBoatFrame(oppositeAngle(angleOfVector(apparent)), boat.heading),
  };
}

/**
 * The true wind angle off the bow — the axis the calibration table in §3.6 is
 * quoted against, and what a student would call their point of sail.
 */
export function trueWindAngle(wind: TrueWind, boat: BoatMotion): Radians {
  return toBoatFrame(wind.from, boat.heading);
}
