/**
 * The complete simulation state, and the step that advances it
 * (DESIGN.md §2, §3.5).
 *
 * The ghost boat — a second, invisible integrator running the same model at
 * optimal trim, which §4.3 colours the speed arrow against — belongs here too,
 * and arrives with pos-dmg.3. Nothing about it needs a different `step`.
 */

import { EFFECTIVE_MASS, hullResistance, hullResistanceSlope } from "./hull.ts";
import type { RigTrim } from "./sail.ts";
import { rigForce } from "./sail.ts";
import type { MetersPerSecond, Seconds } from "./units.ts";
import type { BoatMotion, TrueWind } from "./wind.ts";
import { apparentWind } from "./wind.ts";

/**
 * Everything the simulator knows, which is not much — no history, no session,
 * no stored client state.
 *
 * Grouped rather than flat. §2 lists the same nine fields side by side, but the
 * model had already factored three of those groups into `TrueWind`,
 * `BoatMotion` and `RigTrim`, and they are exactly the argument types
 * `apparentWind()` and `rigForce()` take. Composing from them means the state
 * can be handed to the physics unrepacked, and there is one definition of "the
 * wind" rather than two that could drift.
 */
export interface SimState {
  /** Direction the wind blows *from*, and its speed, in the world frame. */
  readonly wind: TrueWind;
  /** Where the bow points, and the signed speed — negative is sternway. */
  readonly motion: BoatMotion;
  /** Both sail angles, and whether the jib is set at all (§3.7). */
  readonly trim: RigTrim;
  /** Is the user physically forcing the main against the wind right now? (§3.4) */
  readonly mainHeld: boolean;
  /** Likewise for the jib. */
  readonly jibHeld: boolean;
}

// --- Integration (§3.5) ----------------------------------------------------
//
// Speed is integrated, not solved for. Three reasons, all load-bearing:
// apparent wind depends on speed and speed depends on apparent wind, and
// integration resolves that loop for free where a fixed-point solve would have
// to iterate; negative speeds fall out naturally, which the backing mechanic of
// §3.4 needs; and snapping to a new speed looks wrong, when a keelboat takes
// ten seconds to get going and that lag is itself a lesson.
//
// The boat still does not translate. Only the speed number evolves — heading is
// the input layer's to move, and the world is drawn around a boat that stays
// put (§4.1).

/**
 * The longest slice of time one step will advance, in seconds.
 *
 * Not a stability bound — {@link advance} is stable at any step length — but a
 * statement about what a frame is allowed to mean. A tab restored after ten
 * minutes delivers a `dt` of six hundred seconds, and fast-forwarding ten
 * minutes of sailing on the frame after the student looks back at the screen is
 * not something anyone asked for. The boat advances a tenth of a second and
 * carries on from where it was, which costs nothing: the wind and the trim did
 * not change while they were away.
 *
 * A tenth of a second is also comfortably longer than any frame a browser
 * delivers while it is actually drawing, so in normal running the clamp never
 * binds and the simulation keeps real time.
 */
const MAX_STEP: Seconds = 0.1;

/**
 * Advances the boat by `dt` seconds, returning a new state.
 *
 * §3.5's force balance, composed from pieces that already exist: `apparentWind`
 * for what the sails feel, `rigForce` for what they do about it, and
 * `hullResistance` for what the water does about that. Because resistance is
 * signed along the direction of motion, the numerator is the design document's
 * `F_drive − R(v)` unmodified — no branch for going astern.
 *
 * Frames longer than {@link MAX_STEP} are taken as {@link MAX_STEP}; anything
 * that is not a length of time at all advances nothing.
 */
export function step(state: SimState, dt: Seconds): SimState {
  return advance(state, clampStep(dt));
}

/**
 * One integration step of `dt` seconds, with no clamp on `dt`.
 *
 * ```text
 * v += (F_drive − R(v)) · dt / (m_effective + R′(v) · dt)
 * ```
 *
 * **Why the denominator carries `R′(v)·dt`.** Written the obvious way —
 * `a = (F − R(v))/m`, `v += a·dt` — the step uses the resistance the boat feels
 * at the *start* of the interval, which overstates it for a decelerating boat
 * and understates it for an accelerating one. Because §3.5's curve is a sixth
 * power on top of a square, that error grows viciously with speed: past about
 * 40 kt of wind a tenth-of-a-second step rings between two speeds forever, and
 * past 80 kt it diverges to `NaN` — and a `NaN` speed never recovers, since
 * every later step adds to it. Sailing in 80 kt of wind is nobody's lesson, but
 * §5's wind slider has no stated ceiling, and a model that quietly dies past one
 * is a trap for whoever sets that ceiling.
 *
 * Taking the resistance implicitly instead — linearised about the current
 * speed, which is what the slope is for — removes the failure rather than
 * bounding it. The step can never carry the boat past the speed where the
 * forces balance, at any `dt`, in any wind, so there is nothing to ring about.
 * For a frame-length `dt` the correction is around a percent (`R′·dt/m` ≈ 0.012
 * at hull speed and 60 Hz) and the trajectory is the same one to four figures;
 * what changes is only what happens at the extremes.
 *
 * Two properties worth stating plainly, because {@link settle} leans on both:
 * the update moves the speed toward the balance point and never past it, and
 * its fixed point is exactly `F_drive = R(v)` — independent of `dt`, since the
 * increment vanishes only where the numerator does.
 */
function advance(state: SimState, dt: Seconds): SimState {
  const apparent = apparentWind(state.wind, state.motion);
  const { driving } = rigForce(state.trim, apparent);

  const net = driving - hullResistance(state.motion.speed);
  const change = (net * dt) / (EFFECTIVE_MASS + hullResistanceSlope(state.motion.speed) * dt);

  return {
    ...state,
    motion: { ...state.motion, speed: state.motion.speed + change },
  };
}

/**
 * The slice of `dt` this step will take: at most {@link MAX_STEP}, never
 * negative, and zero for anything that is not a number at all.
 *
 * Written as nested comparisons rather than `Math.min`/`Math.max` because NaN
 * has to fall through to zero. A single NaN reaching the integrator would poison
 * the speed permanently — every later step adds to it — and a frame timer that
 * hands back a NaN delta is not a hypothetical on the web.
 */
function clampStep(dt: Seconds): Seconds {
  if (dt > MAX_STEP) return MAX_STEP;
  return dt > 0 ? dt : 0;
}

/**
 * The step {@link settle} takes — fifty times the longest a frame may be, and
 * deliberately so.
 *
 * A long step is exactly what {@link advance} is good at: it cannot overshoot
 * the balance point, and where the resistance dominates the step becomes a
 * Newton step toward it, so the speed converges in tens of iterations instead
 * of thousands. What a long step gives up is the *trajectory* — nothing between
 * the endpoints means anything — and settling has no use for the trajectory.
 *
 * Stepping at frame length instead would be slower and, worse, wrong: the
 * approach is asymptotic, so a per-step change small enough to look settled can
 * still be a long way from the balance point. At five degrees off the wind the
 * boat closes on its speed at 0.023 per second, and a tenth-second step is
 * under a millionth of a metre per second while the speed is still 2% short.
 */
const SETTLE_STEP: Seconds = 5;

/**
 * Below this much change in a single settle step, the speed has arrived. Tight
 * enough to be machine precision in practice, which a {@link SETTLE_STEP}-sized
 * step reaches because it is not fighting the asymptote.
 */
const SETTLE_TOLERANCE: MetersPerSecond = 1e-9;

/**
 * How many steps {@link settle} will take before giving up. Generous: the slow
 * corners — barely out of the no-go zone, or creeping astern under a backed
 * sail — take a couple of hundred, and everything a student will actually look
 * at takes fewer than fifty.
 */
const SETTLE_LIMIT = 500;

/**
 * The same state, with the boat at the speed it would eventually reach on this
 * heading, in this wind, at this trim.
 *
 * Iterating the same integrator rather than solving for the balance point, for
 * the reason §3.5 gives: the speed and the apparent wind determine each other.
 * Stepping the real model is both simpler than a fixed-point solve and
 * guaranteed to agree with what the running simulator converges on, since it is
 * the same arithmetic.
 *
 * It runs at {@link SETTLE_STEP} rather than at frame length, which is not a
 * shortcut but the point: the update's fixed point does not depend on the step,
 * so a long step reaches the same speed sooner. Only the endpoint is meaningful
 * — the states in between are iterates, not a trajectory a boat sails through.
 *
 * Two callers want this. §2.1 opens the boat at the steady speed for its
 * deliberately bad trim — starting from zero would leave the student unable to
 * tell a short speed arrow from one that has not got going yet — and the
 * calibration tests of §3.6 need a settled speed to compare against the polar.
 *
 * Returns its best effort if the speed is still moving at {@link SETTLE_LIMIT}
 * rather than throwing or looping forever: a simulator that opens on a slightly
 * wrong speed is a far better failure than one that does not open.
 */
export function settle(state: SimState): SimState {
  let settled = state;

  for (let iteration = 0; iteration < SETTLE_LIMIT; iteration += 1) {
    const next = advance(settled, SETTLE_STEP);
    const change = Math.abs(next.motion.speed - settled.motion.speed);
    settled = next;
    if (change < SETTLE_TOLERANCE) break;
  }

  return settled;
}
