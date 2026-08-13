/**
 * The wind speed control: §5's one slider, and the range it runs over.
 *
 * ## Why a slider and not a drag
 *
 * Every other input in the simulator is a direct manipulation of the drawing,
 * and wind speed deliberately is not. The obvious gesture — drag the wind
 * arrow's length — puts a one-dimensional target inside a two-dimensional one:
 * the same finger on the same ring would have to mean *bearing* when it moves
 * around and *speed* when it moves in and out, and on a phone, where §5's whole
 * argument is that targets must be large and will overlap, that is the one
 * pairing guaranteed to make both gestures worse. So the ring keeps the bearing,
 * which is the gesture worth having, and the speed goes to a control that cannot
 * be missed.
 *
 * It is also the honest reading of what the two quantities are. Wind direction
 * is a thing you point at; wind speed is a dial on the world. §5 put it in the
 * control strip beside the switches for that reason, and this module is only the
 * arithmetic — `main.ts` owns the element, as it owns the rest of the shell.
 *
 * ## Where the range stops
 *
 * **0 to 20 knots.** §5 asked for a slider without saying where it ended, and
 * for several beads the answer was whatever the scaffolding happened to offer;
 * comments across the model still appeal to "today's scaffolding offers 0–30 kt"
 * as though that were a decision (pos-g7p). This is where it becomes one.
 *
 * Both ends are chosen rather than inherited:
 *
 * - **0** has to be reachable. A boat that will not stop is a boat whose speed
 *   looks like a property of the boat rather than of the wind, and the drift to
 *   a halt is the cheapest demonstration in the simulator that it is not.
 * - **20** is roughly where the school stays ashore. Above it, with new sailors,
 *   the experience turns bad and equipment starts to break — so this is the top
 *   of the range a student is being taught to sail in, which is the only range
 *   the simulator is for. §3.2's depowering begins at exactly 13 kt, so the top
 *   third of this range is inside the regime where the rig is shedding force: a
 *   student who runs the slider up watches the boat *stop* gaining speed, which
 *   is the lesson that end of the range exists to teach.
 *
 * **It is a teaching limit, not a model limit and not a UI convenience**, and
 * that is worth stating because the number invites raising. The physics is sound
 * well past 20 kt — §3.6 owns how far — and nothing here is a claim that it is
 * not. What is claimed is that a wind the school would not go out in is not a
 * wind worth putting under a student's thumb.
 */

import type { Knots, MetersPerSecond } from "../model/units.ts";
import { knotsToMetersPerSecond, metersPerSecondToKnots } from "../model/units.ts";

/**
 * The slider's domain, in knots, and the granularity it moves in.
 *
 * A whole knot per step. Finer would be false precision — nobody reads the wind
 * to a tenth on the water, and §2.1 opens the simulator in a 6–14 kt band, so a
 * step is a real fraction of the interesting range rather than a nudge.
 */
export const WIND_SPEED_KT = {
  min: 0 as Knots,
  max: 20 as Knots,
  step: 1 as Knots,
} as const;

/**
 * The wind speed a slider reading asks for, in the model's own units.
 *
 * Clamped rather than trusted. The element enforces its own `min`/`max`, so in
 * the browser this never binds — the clamp is here so that the range is a
 * property of this module rather than of two attributes on an element in
 * `main.ts`, which is what lets it be asserted in a test at all.
 *
 * It bounds the *control*, not the model. A `?wind=` URL (§6.3) describes a
 * state directly and is not this function's caller; §3.6 is where the question
 * of what the physics is still honest at belongs.
 */
export function windSpeedFromKnots(knots: Knots): MetersPerSecond {
  const bounded = Math.min(WIND_SPEED_KT.max, Math.max(WIND_SPEED_KT.min, knots));
  return knotsToMetersPerSecond(bounded);
}

/**
 * The slider reading that shows a wind speed — the inverse, rounded to a step.
 *
 * Needed because the state can move without the slider: the console handle in
 * `main.ts` can set any wind it likes, and pos-740's randomised opening state
 * (§2.1) will. A control left showing a stale number is worse than no control,
 * because the next touch of it jumps the wind from wherever the thumb happens to
 * be sitting.
 *
 * Rounds to the nearest step and then clamps. The order does not matter and it
 * is worth saying so rather than leaving a reader to wonder: both ends of
 * {@link WIND_SPEED_KT} sit on the step lattice, so clamping lands on a value
 * rounding would not move, and the two operations commute. If the range ever
 * grows a fractional end they stop commuting, and this is the line to revisit.
 *
 * Out-of-range speeds are reported at the end they exceed, which is the honest
 * answer for a control that cannot express them — and better than the
 * alternative of leaving the thumb where it was, which is the stale reading this
 * function exists to prevent.
 */
export function knotsFromWindSpeed(speed: MetersPerSecond): Knots {
  const knots = metersPerSecondToKnots(speed);
  const stepped = Math.round(knots / WIND_SPEED_KT.step) * WIND_SPEED_KT.step;
  return Math.min(WIND_SPEED_KT.max, Math.max(WIND_SPEED_KT.min, stepped));
}
