/**
 * The complete simulation state, and the step that advances it
 * (DESIGN.md §2, §3.5).
 *
 * The ghost boat — a second, invisible integrator running the same model at
 * optimal trim, which §4.3 colours the speed arrow against — belongs here too,
 * and arrives with pos-dmg.3. Nothing about it needs a different `step`.
 */

import {
  EFFECTIVE_MASS,
  hullResistance,
  hullResistanceSlope,
  keelInducedDrag,
} from "./hull.ts";
import type { RigTrim } from "./sail.ts";
import { depoweringFactor, easeMainAngle, rigForce } from "./sail.ts";
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
 * `hullResistance` plus `keelInducedDrag` for the two ways the water charges
 * for it. Because both drags are signed along the direction of motion, the
 * numerator is the design document's `F_drive − R(v) − D_keel(v)` unmodified —
 * no branch for going astern.
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
 * v += (F_drive − R(v) − D_keel(v)) · dt / (m_effective + R′(v) · dt)
 * ```
 *
 * **Why the denominator carries `R′(v)·dt`.** Written the obvious way —
 * `a = (F − R(v))/m`, `v += a·dt` — the step uses the resistance the boat feels
 * at the *start* of the interval, which overstates it for a decelerating boat
 * and understates it for an accelerating one. Because §3.5's curve is a fourth
 * power on top of a square, that error grows viciously with speed: trimmed for
 * the wind it was in, the boat's speed under a tenth-of-a-second step stopped
 * settling at around 80 kt and alternated between two values forever, and by
 * 120 kt it diverged to `NaN` — which never recovers, since every later step
 * adds to it. Those two figures were 55 kt and 85 kt before pos-lcz softened
 * the wall exponent from 6 to 4; a gentler curve is a gentler thing to
 * linearise.
 *
 * **Every one of those numbers is now historical, and saying so is the point of
 * re-measuring them.** §3.2's depowering caps the drive at its 13 kt value, so
 * the boat stops accelerating with the wind, and there is no wind at which the
 * naive form misbehaves any more: measured at 55, 60, 80, 100, 120, 200, 500
 * and 1000 kt, the naive step and this one converge to the same speed with the
 * tails identical to six decimals and no overshoot between them.
 *
 * Two settled speeds get quoted for this and they are different boats, so they
 * are labelled here rather than left to be conflated. **Re-trimmed for the gale
 * it is in**, the boat settles 3.2810–3.2929 m/s (6.38–6.40 kt) across 55 kt to
 * 1000, and from rest in 200 kt the first step is 0.0635 m/s. **Carrying a trim
 * found in 10 kt**, which is what `simulation.test.ts` actually builds, it
 * settles 2.2612–2.3141 m/s (4.40–4.50 kt) and the first step is 0.0223 m/s.
 * The undepowered boat took 12.03 m/s at a stride.
 *
 * **The step stays implicit, and not out of inertia.** What makes the failure
 * unreachable is no longer a property of the physics but the value of
 * `DEPOWERING.fullPowerWind`: raise it far enough, or take the cap out to try
 * something else, and the fourth power is waiting exactly where it always was.
 * The guard costs one extra term per frame and the trap is one line of
 * `tuning.ts` away, which is the wrong margin to run without one. What has
 * genuinely changed is that this is now belt-and-braces rather than the only
 * thing standing between the model and a `NaN`.
 *
 * Linearising the resistance about the current speed — which is what the slope
 * is for — makes the step self-limiting: the faster the water would answer, the
 * smaller the step it takes, so the speed no longer runs away from a curve that
 * is climbing faster than the step can see. For a frame-length `dt` the
 * correction is around a percent (`R′·dt/m` ≈ 0.012 at hull speed and 60 Hz)
 * and the trajectory is the naive one to three figures — 2.1084 against 2.1057
 * ten seconds into a beam reach. What changes is only the extremes.
 *
 * **What it does not do is forbid overshoot.** The step is a damped Newton
 * step, and because the curve is convex the tangent it follows lies under the
 * curve, so its target sits a little beyond the true balance point: settling a
 * 10 kt beam reach from rest passes the mark by half a percent on the fourth
 * iteration before coming back. That figure is unchanged by §3.2, which is
 * still 1.000 at 10 kt. What makes it harmless — and what {@link settle}
 * actually leans on — is that resistance grows faster than linearly, so a speed
 * past the balance point meets a restoring step larger than the one that took
 * it there. Overshoots decay instead of feeding themselves. No wind up to
 * 200 kt produces a lasting oscillation, which is what `simulation.test.ts`
 * pins; in a gale it now produces no overshoot at all, the boat approaching its
 * capped speed from below.
 *
 * The other property {@link settle} leans on is exact: the fixed point is
 * `F_drive = R(v) + D_keel(v)`, independent of `dt`, since the increment
 * vanishes only where the numerator does. `simulation.test.ts` asserts that
 * balance with all three terms — checking only the first two would pass on a
 * settle that had converged wrong by exactly the keel's charge, which upwind
 * is over a hundred newtons.
 *
 * **The keel's induced drag is charged in the numerator and left out of the
 * denominator**, which is not an oversight either. The denominator is a
 * stiffness, and this is the one term in the balance whose stiffness **changes
 * sign**: `keelInducedDrag` rises to a peak at the keel's stall and falls away
 * after it, so `dD/dv` is positive below that speed and negative above. Both
 * halves are ordinary sailing — close hauled in 10 kt the boat sits just under
 * the peak at +17 N/(m/s), and by a beam reach it is past it at −25.
 *
 * A negative stiffness in `m + R′·dt` works against the very thing the
 * linearisation is there to do, and a large enough one would drive the
 * denominator through zero. Since half the polar would contribute one, the term
 * stays out of the denominator entirely rather than being included with a sign
 * test. That costs only the damping a positive stiffness would have added,
 * which is small: unlike the hull-speed wall, `keelInducedDrag` is bounded and
 * gently sloped everywhere, and `|dD/dv|·dt / m` stays under a percent even at
 * the longest step {@link MAX_STEP} allows. `hull.test.ts` measures it.
 */
function advance(state: SimState, dt: Seconds): SimState {
  const apparent = apparentWind(state.wind, state.motion);
  const { driving, lateral } = rigForce(state.trim, apparent);

  // §3.2's depowering, applied here rather than inside `rigForce` so that
  // §4.2's trim-quality ratio never sees it — `depoweringFactor` has the
  // reasoning, and it is a design decision rather than a convenience. Both
  // components are scaled, which is what makes the factor a clean multiple of
  // the whole rig force: the keel is charged for the side force the boat is
  // actually holding, not for the one it would hold at full power.
  const carried = depoweringFactor(state.wind.speed);

  const net =
    driving * carried -
    hullResistance(state.motion.speed) -
    keelInducedDrag(state.motion.speed, lateral * carried);
  const change = (net * dt) / (EFFECTIVE_MASS + hullResistanceSlope(state.motion.speed) * dt);

  return {
    ...state,
    motion: { ...state.motion, speed: state.motion.speed + change },
    // **The boom swings on the same clock as the speed** (§3.4, and the sheet
    // model in `naturalMainAngle`). It is state that evolves, not an input that
    // is held: the sheet caps how far out it may go and the wind decides where
    // inside that cap it sits, so turning the boat moves the boom without
    // anybody touching it — which is what tacking and gybing *are*.
    //
    // Skipped entirely while `mainHeld`, because a hand on the boom is a
    // stronger constraint than the wind. That flag has been in `SimState` and
    // inert since it was added; this is the first thing to read it.
    //
    // Note this rides inside `advance`, so `settle` gets it for free: settle
    // steps repeatedly, so it converges the boom and the speed together —
    // which matters, since each depends on the other through the apparent wind.
    trim: state.mainHeld
      ? state.trim
      : {
          ...state.trim,
          mainAngle: easeMainAngle(state.trim.mainAngle, state.trim.mainSheet, apparent, dt),
        },
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
 * The step {@link settle} takes: a frame, the same as everything else.
 *
 * **It is worth saying why this is not larger.** A long step looks like free
 * money here — where the resistance dominates the denominator, {@link advance}
 * becomes a Newton step toward the balance point and lands on it in ten
 * iterations rather than three hundred. What that reasoning leaves out is the
 * drive, which is *not* in the linearised denominator and which can fall with
 * speed far more steeply than the resistance rises: an overeased sail with the
 * apparent wind collapsing behind it. Then a long step is no longer a step
 * toward anything, and the iteration can settle into a two-point cycle instead
 * of a speed.
 *
 * It is not a hypothetical. At a five-second step, a sloop in 10 kt at TWA 105
 * with the sails eased to 80° alternates between 1.666879 and 1.833610 m/s
 * forever, 46 N out of balance, and `settle` returned one end of that cycle as
 * if it were an answer. Cases up to 1146 N out were easy to find. Every step of
 * two seconds or less converged on every case tried — but "converged on every
 * case tried" is exactly the reasoning that produced the bug, and a calibration
 * pass or a steeper sail curve moves the threshold.
 *
 * At frame length there is an argument rather than a survey. The step is small
 * enough to track the underlying equation closely, and that equation is a
 * one-dimensional flow: speed moves toward the nearest balance point and stops
 * there, because there is nowhere else for it to go. It cannot cycle, and
 * neither can a faithful discretisation of it. The cost is iterations, which
 * are cheap, and the return is that `settle` reports what the running simulator
 * reaches *because it is the running simulator* — same step, same arithmetic,
 * no second implementation to disagree with the first.
 *
 * Which is also why {@link settle} goes through {@link step} rather than
 * {@link advance}: raising this constant cannot lengthen the settling step past
 * a frame, because the clamp that guards the frame loop guards this too.
 */
const SETTLE_STEP: Seconds = MAX_STEP;

/**
 * Below this much change in a single settle step, the speed has arrived.
 *
 * The number that matters is not this one but the distance to the balance point
 * it implies, and the two are related by how fast the boat is closing: distance
 * ≈ tolerance / (rate · step). At the slowest approach in the model — five
 * degrees off the wind, where the time constant is 68 seconds — a hundred-
 * millionth of a metre per second per frame puts the speed within 7e-6 m/s of
 * the balance point, or a hundred-thousandth of a knot. Everywhere else the
 * boat closes faster and lands closer still.
 *
 * Tightening it costs iterations logarithmically and buys accuracy the same
 * way, so there is no cliff either side; this is simply well below anything the
 * simulator can show, with pos-fo1.4's polar targets quoted to a tenth of a knot.
 */
const SETTLE_TOLERANCE: MetersPerSecond = 1e-8;

/**
 * How many frames {@link settle} will run before giving up — half an hour of
 * simulated sailing.
 *
 * Generous against what the regimes actually cost: a couple of hundred frames
 * for a beam reach or a boat gathering sternway, three hundred at TWA 105, and
 * some five thousand at five degrees off the wind, which is the slowest corner
 * that converges at all. See {@link settle} for the ones that do not.
 */
const SETTLE_LIMIT = 18_000;

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
 * It runs {@link step} itself, at frame length, so what it returns is by
 * construction the speed the running simulator converges on rather than a
 * second opinion about it. {@link SETTLE_STEP} says why nothing cleverer is
 * used.
 *
 * Two callers want this. §2.1 opens the boat at the steady speed for its
 * deliberately bad trim — starting from zero would leave the student unable to
 * tell a short speed arrow from one that has not got going yet — and the
 * calibration tests of §3.6 need a settled speed to compare against the polar.
 *
 * Returns its best effort if the speed is still moving at {@link SETTLE_LIMIT}
 * rather than throwing or looping forever: a simulator that opens on a slightly
 * wrong speed is a far better failure than one that does not open.
 *
 * **Two regimes run out the budget**, and both are the same fact about drag
 * that goes as `v²`: with no wind to balance against, a moving boat's
 * deceleration falls off as fast as its speed does, so it approaches rest like
 * `1/t` and there is no finite time at which it has arrived. A boat coasting in
 * a flat calm comes back at about 0.03 kt whatever speed it started from — that
 * figure is the budget running out, not physics — and below roughly a tenth of
 * a knot of wind the settled speed reads a few percent low for the same reason.
 * Neither is visible at the scale anything is drawn at, and §2.1's opening state
 * never asks for either, but a caller reading a speed back out of a calm should
 * know it is reading a floor rather than an answer.
 */
export function settle(state: SimState): SimState {
  let settled = state;

  for (let iteration = 0; iteration < SETTLE_LIMIT; iteration += 1) {
    const next = step(settled, SETTLE_STEP);
    const change = Math.abs(next.motion.speed - settled.motion.speed);
    settled = next;
    if (change < SETTLE_TOLERANCE) break;
  }

  return settled;
}
