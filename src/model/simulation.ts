/**
 * The complete simulation state, and the step that advances it
 * (DESIGN.md §2, §3.5).
 *
 * The ghost boat — a second, invisible integrator running the same model at
 * optimal trim, which §4.3 colours the speed arrow against — belongs here too,
 * and arrives with pos-dmg.3. Nothing about it needs a different `step`.
 */

import { EFFECTIVE_MASS, hullResistance } from "./hull.ts";
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
 * A numerical bound rather than a feel decision, which is why it is here and not
 * in `tuning.ts`. Explicit Euler on this resistance curve is stable while
 * `dt < 2m/R′(v)`: about 2.7 s at hull speed, and still 0.34 s at 4 m/s, a speed
 * no amount of sail area can reach. A tenth of a second keeps a factor of three
 * in hand everywhere the boat can actually get to, and is well under a frame
 * even on a slow tablet.
 *
 * It is also what makes the backgrounded-tab case safe by construction. A tab
 * restored after ten minutes delivers a `dt` of six hundred seconds; the boat
 * advances a tenth of a second and carries on from where it was. Nothing is
 * lost by that — the wind and the trim did not change while the student was
 * away, so the state they left is the state they return to.
 */
const MAX_STEP: Seconds = 0.1;

/**
 * Advances the boat by `dt` seconds, returning a new state.
 *
 * ```text
 * a = (F_drive − R(v)) / m_effective
 * v += a · dt
 * ```
 *
 * The whole of §3.5, composed from pieces that already exist: `apparentWind`
 * for what the sails feel, `rigForce` for what they do about it, and
 * `hullResistance` for what the water does about that. Because resistance is
 * signed along the direction of motion, the subtraction here is the design
 * document's formula unmodified — no branch for going astern.
 */
export function step(state: SimState, dt: Seconds): SimState {
  const apparent = apparentWind(state.wind, state.motion);
  const { driving } = rigForce(state.trim, apparent);
  const acceleration = (driving - hullResistance(state.motion.speed)) / EFFECTIVE_MASS;

  return {
    ...state,
    motion: { ...state.motion, speed: state.motion.speed + acceleration * clampStep(dt) },
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
 * A step small enough that {@link settle} converges on the same speed the
 * running simulator would, rather than on the integrator's own artefacts.
 */
const SETTLE_STEP: Seconds = MAX_STEP;

/** Below this much change in a single settle step, the speed has stopped moving. */
const SETTLE_TOLERANCE: MetersPerSecond = 1e-6;

/**
 * How much simulated time {@link settle} will spend before giving up. Ample: a
 * boat under way converges inside twenty seconds, and even the slow corner —
 * in irons, creeping astern under a couple of newtons of sail drag — is settled
 * well inside this.
 */
const SETTLE_LIMIT: Seconds = 300;

/**
 * The same state, with the boat at the speed it would eventually reach on this
 * heading, in this wind, at this trim.
 *
 * Integrating to equilibrium rather than solving for it, for the reason §3.5
 * gives: the speed and the apparent wind determine each other, and stepping the
 * real model is both simpler and guaranteed to agree with what the running
 * simulator does.
 *
 * Two callers want this. §2.1 opens the boat at the steady speed for its
 * deliberately bad trim — starting from zero would leave the student unable to
 * tell a short speed arrow from one that has not got going yet — and the
 * calibration tests of §3.6 need a settled speed to compare against the polar.
 *
 * Returns its best effort if the speed is still drifting at {@link SETTLE_LIMIT}
 * rather than throwing or looping forever: a simulator that opens on a slightly
 * wrong speed is a far better failure than one that does not open.
 */
export function settle(state: SimState): SimState {
  let settled = state;

  for (let elapsed = 0; elapsed < SETTLE_LIMIT; elapsed += SETTLE_STEP) {
    const next = step(settled, SETTLE_STEP);
    const change = Math.abs(next.motion.speed - settled.motion.speed);
    settled = next;
    if (change < SETTLE_TOLERANCE) break;
  }

  return settled;
}
