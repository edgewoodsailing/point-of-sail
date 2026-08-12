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

import type { Radians, Seconds } from "./units.ts";
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
  readonly plateNormalForce: number;
} = {
  /** `Cd0` — the drag a sail carries at zero incidence, before induced drag. */
  profileDrag: 0.02,

  /**
   * `e`, the Oswald span efficiency in `Cd_induced = Cl²/(π·AR·e)`. Below 1
   * because a real sail's lift is not distributed elliptically over its span.
   */
  spanEfficiency: 0.9,

  /**
   * Where attached flow gives up. Together with the lift-curve slope it sets
   * peak lift, so the two cannot be tuned separately — move this angle and peak
   * lift moves with it.
   *
   * On the main, `Cl` reaches 1.40 here, the figure §3.2 quotes. That is not
   * the maximum: the smoothstep blend leaves this angle with zero slope, so the
   * attached limb keeps climbing well past it and the curve actually tops out
   * at ≈ 1.57 near 22.4°. Both are realistic for a soft sail, but the
   * optimal-trim search settles on the second one — at every point of sail in
   * the §3.6 table the main sits within a degree or two of 22° — so it is the
   * number to have in mind when reading the calibration table.
   */
  stallAngle: degreesToRadians(18),

  /**
   * How far past the stall the blend into the flat-plate limb takes to
   * complete. A soft sail stalls gradually rather than dropping off a cliff,
   * and the width is what expresses that.
   *
   * **pos-fo1.4 doubled this from 10°, and not for the polar.** At 10° the
   * stall was a cliff, and a cliff makes the model *bistable* on a reach: the
   * same boat at the same trim in the same wind settles at two different
   * speeds, depending on whether it started from rest or was already going.
   * Trimmed for TWA 120 from a standstill it stuck at 3.7 kt where the same
   * trim held 5.1 kt once moving, because the sail eased for the apparent wind
   * at speed is stalled at the apparent wind at rest, and the drop over the
   * cliff was steeper than the drive needed to climb out of it. A polar that
   * depends on how the boat got there is not a polar, and a student who could
   * not get going without easing first and trimming after would be learning
   * the model's arithmetic rather than sailing.
   *
   * The threshold is sharp and the margin here is deliberate: 12° is still
   * bistable by 3 kt, 14° is clean, and 20° leaves room for a later pass to
   * move the neighbouring constants without falling back over the edge. It also
   * costs something — see {@link FOIL.stallAngle} for where peak lift ends up —
   * so it is not free to widen further.
   */
  stallBlendWidth: degreesToRadians(20),

  /**
   * `k` in the stalled sail's normal force, `Cn = k·sinα`, which `foil.ts`
   * resolves into the flat-plate limb's `Cl` and `Cd`. At α = 90° — a sail
   * squared off on a dead run — it *is* the drag coefficient.
   *
   * **This is what sets the speed of a run**, and it is the only constant that
   * does: dead downwind the sail makes no lift, the keel makes no side force,
   * and the whole force balance is this number against the hull. Nothing else
   * in the model can be moved to slow a run without wrecking a reach — the
   * resistance that would do it (`A ≈ 65`) puts a beam reach at 4 kt.
   *
   * **1.1, where the design document said 2.0.** Two is the textbook figure for
   * a flat plate of *infinite* span; the same plate at the aspect ratio of a
   * sail is nearer 1.2, because the flow spills round the ends instead of
   * stagnating. That correction is most of the change and is straightforwardly
   * right. The rest is that a soft sail on a run is not a plate at all: it is
   * twisted, its head falls off to leeward, and — the part §7 declines to model
   * — the jib spends the whole run in the main's wind shadow. One number stands
   * for all of it, which is why it sits a little under the rigid-plate figure
   * rather than at it.
   */
  plateNormalForce: 1.1,
};

/**
 * Luffing (§3.3). How much incidence a sail needs before it stops shaking and
 * starts pulling.
 *
 * **Both are magnitudes of the angle of attack, not signed thresholds.** §3.3
 * originally quoted them signed — drawing above +2°, luffing below −5° — which
 * reads naturally until you notice that `foil.ts` is deliberately odd in α: a
 * well-trimmed sail sits at α ≈ +15° on starboard tack and α ≈ −15° on port,
 * because the sign says which *face* the flow strikes, not whether the trim is
 * any good. Taken signed, the whole port tack would luff, and a backed sail
 * (large negative α) would carry no force at all — which would break the
 * mooring departure §3.4 is built around. Folded about zero the rule mirrors
 * correctly across tacks and a backed sail draws fully, in reverse.
 *
 * What the fold gives up is camber asymmetry — a real cambered sail keeps
 * drawing a little past nominal zero incidence, on one side only. Representing
 * that honestly needs memory of which side the camber has popped to, which this
 * model does not carry.
 *
 * **They are measured from the nearer edge-on state, not from zero** (pos-aa2).
 * A sail lies along the flow at α = ±180° as well as at α = 0 — the wind at the
 * leech rather than the luff — and `foil.ts` already reports a sail making
 * nothing at both. So `sail.ts` folds about 90° too, and these thresholds are
 * read against `min(|α|, 180° − |α|)`. That reaches only `|α| > 173°`, and
 * backing is untouched by it: a backed sail head to wind sits at α = 90°, which
 * folds to 90° either way.
 */
export const LUFF: {
  readonly collapsedBelow: Radians;
  readonly drawingAbove: Radians;
} = {
  /**
   * At or below this far from an edge-on state the sail is wholly collapsed and
   * carries nothing.
   */
  collapsedBelow: degreesToRadians(2),

  /**
   * At or beyond this far from an edge-on state the sail is wholly full. The 5°
   * between the two is the transition width — how gradually the collapse
   * propagates across the sail — and is the knob to move if the shake looks too
   * abrupt or too mushy.
   */
  drawingAbove: degreesToRadians(7),
};

/**
 * What the water charges (§3.5): the hull's own resistance,
 *
 * ```text
 * R(v) = A·v² + B·v²·(v / v_hull)⁴
 * ```
 *
 * plus what it costs to be held on course against the rig's side force, which
 * is the last two constants. `A` and `B` are in N·s²/m², and `v_hull` is a
 * *measurement* — it lives in `boat.ts` as `HULL.hullSpeed`, ≈ 2.90 m/s — so it
 * is not a knob and is not restated here.
 */
export const RESISTANCE: {
  readonly quadratic: number;
  readonly hullSpeedWall: number;
  readonly asternFactor: number;
  readonly sideForce: number;
  readonly keelStall: number;
} = {
  /**
   * `A` — ordinary resistance, quadratic in speed, which is what the boat feels
   * everywhere below hull speed.
   *
   * It is also the one constant the acceleration lag is derived through (see
   * `hull.ts`), so it cannot be moved without moving the effective mass with
   * it. That is deliberate: the *felt* lag is what §3.5 pins, not the mass.
   *
   * pos-fo1.4 raised it from 22.5. What pinned it is the run: with the drive
   * there fixed by {@link FOIL.plateNormalForce}, this is the other side of
   * that balance, and 22.5 left the boat a knot fast dead downwind. A textbook
   * estimate for a Rhodes 19 — friction on ~9.5 m² of wetted surface plus
   * residuary resistance at `Fn` 0.38 — comes out around 310 N at 5.4 kt where
   * this curve now says 349 N, which is as close as an estimate assembled that
   * way deserves to be called.
   */
  quadratic: 28,

  /**
   * `B` — the wall. Reads as *the extra resistance at exactly hull speed*,
   * since the wall factor is 1 there whatever the exponent: at 21.9 against an
   * `A` of 28, the resistance has not quite doubled at 5.65 kt and has roughly
   * doubled again 20% past it.
   *
   * **This and the exponent divide the work, and neither is free.** This
   * coefficient sets *how hard* the wall bites at hull speed and is a knob in
   * the ordinary sense — it is what a calibration pass turns to put the 10 kt
   * beam reach where §3.6 wants it. `WALL_EXPONENT` in `hull.ts` sets how
   * abruptly the bite arrives, and pos-lcz established that it is also the only
   * thing in the model that makes the polar depend on the wind at all. That
   * makes it a design decision rather than a knob, and it is documented as one
   * there and in §3.5; do not treat the two as interchangeable just because
   * both live on the same term.
   *
   * pos-lcz moved this from 22.5 to 21.9, which is not a tuning pass in its own
   * right — it is what holds the 10 kt beam reach at 5.55 kt while the exponent
   * came down from 6 to 4.
   *
   * **The direction is the opposite of the intuition, so it is worth spelling
   * out.** Below hull speed the wall factor is a number *less than one* raised
   * to the exponent, and raising a fraction to a higher power makes it smaller.
   * So a *softer* exponent gives a *larger* factor down here: at the 5.55 kt
   * beam reach, `(5.55/5.646)⁴ = 0.934` against `⁶ = 0.902`. Dropping the
   * exponent while holding `B` therefore *adds* resistance at the beam reach and
   * pushes it below 5.55 kt, and `B` has to come down to put it back. A softer
   * wall is only softer where it was supposed to bite — past hull speed — and it
   * is slightly *firmer* everywhere below, which is the same fact `hull.test.ts`
   * records as the wall's share at half hull speed going from 1.24% to 4.66%.
   *
   * The two move together and should be re-solved together.
   *
   * What has not changed is what the term is for: the wall a displacement hull
   * hits, so that no amount of sail area gets a Rhodes 19 to 9 knots in the
   * wind it is actually sailed in. What pos-lcz gave up is that promise in a
   * gale — see §3.6 and `pos-d7u`.
   */
  hullSpeedWall: 21.9,

  /**
   * How much draggier the boat is going backwards. Multiplies the whole curve,
   * both terms.
   *
   * Transom-first with a stalled keel and rudder genuinely is much worse than
   * this figure would suggest for a fair hull, and that is the point: a student
   * backing off a mooring (§3.4) should feel that sternway is slow and hard
   * won. The wall term comes along for the ride, which costs nothing — the boat
   * cannot get near hull speed astern.
   */
  asternFactor: 2.5,

  /**
   * `k` in the keel's `D = k·F²/v²` — what it costs to be held on a heading the
   * wind is not blowing along. `hull.ts` has the derivation and the stall that
   * keeps it finite at rest; this is its scale.
   *
   * **It is what makes the no-go zone exist.** Before this term the simulator
   * had nothing to charge for sailing at a large angle to the wind: it ran 29%
   * fast close hauled and still made 3 kt at TWA 15°, and no resistance
   * coefficient could fix that, because scaling resistance slows every point of
   * sail at once and the problem was one end of the polar. Close hauled this
   * term is worth 148 N against 158 N of hull resistance — it is half of what
   * slows the boat — and it fades to 44 N on a beam reach, 1 N on a broad
   * reach, and exactly nothing on a run, where the sails make no side force at
   * all.
   *
   * **Four times the keel's own induced drag, and deliberately.** Working it
   * out honestly for a 3'3" keel — `k = 1/(½ρ·π·b²·e)` — gives about 1/1100,
   * against the 1/280 here; put the other way, the boat is charged as if its
   * keel had half the span it has. The gap is the rest of the bill for making
   * side force, all of which §7 declines to model separately and all of which
   * scales the same way: the heel it produces, which spills drive and drags the
   * topsides through the water; the leeway the hull makes, which drags a boat
   * sideways as well as forwards; and the rudder angle needed to hold the
   * course, which is drag with a keel's shape and none of its span. Charging
   * them on the same number is the fudge. Pretending the keel alone accounted
   * for the polar would be the dishonest version.
   */
  sideForce: 0.0036,

  /**
   * The largest fraction of the side force the keel can ever charge as drag —
   * a maximum drag angle, in the sense that 0.22 is a boat crabbing at 12°.
   *
   * Physically it is where the keel stalls, and it went in because `F²/v²` runs
   * away at low speed where a real keel simply gives up and lets the boat
   * slide. It turned out to be more than a guard on that corner. The whole
   * upwind quarter runs at or just under this ceiling — close hauled in 10 kt
   * the keel is loaded to within a percent of it — so this, and not
   * {@link RESISTANCE.sideForce}, is what sets where the no-go zone ends:
   * raise it and the zone widens and the best angle opens (0.30 puts it at
   * 50°), lower it and the boat points higher than any boat should (0.16 puts
   * it at 40°). At 0.22 the upwind VMG peaks at 44°, which is §3.6's "closest
   * useful angle ≈ 45°".
   *
   * The two constants therefore divide the work rather than duplicating it:
   * this one owns the upwind end of the polar, and `sideForce` owns how fast
   * the charge fades as the boat bears away.
   */
  keelStall: 0.22,
};

/**
 * How long the boat takes to get going (§3.5).
 *
 * **Expressed as a time, not as a mass.** §3.5 quotes `m_effective` ≈ 880 kg —
 * boat, two crew, and ~15% added mass — but the mass is not what anyone can
 * judge by watching the simulator. The lag is: trim in properly and the speed
 * arrow takes its time. So the knob is the observable and `hull.ts` derives the
 * mass from it, which keeps a calibration pass on {@link RESISTANCE.quadratic}
 * from moving the lag out from under us. It ties the two together rather than
 * freezing the lag outright — see `EFFECTIVE_MASS` for how far the anchor
 * holds.
 *
 * **pos-fo1.4 left it at ten seconds, which was a choice.** Raising the
 * resistance raised the derived mass with it, to ≈ 1092 kg against §3.5's
 * independently reasoned 880, and the mass could have been held there instead
 * by shortening this to 7.4 s. It was not, because that inverts the design: the
 * lag is the thing anyone can judge and the mass is the thing nobody can, and a
 * calibration pass fitting a polar has no business deciding how the boat should
 * feel. Shortening it is a decision to make against the running simulator, as
 * §3.5 says — not a side effect of getting a run down to 3.5 kt.
 */
export const ACCELERATION: {
  readonly timeToTerminal: Seconds;
} = {
  /**
   * Time from rest to ~63% (1 − 1/e) of terminal speed, under a steady drive.
   *
   * About right for a keelboat, and the lag is itself a lesson — trim changes
   * do not pay off instantly. If it reads as sluggish when comparing two trim
   * settings back to back, shorten it; this is a feel decision to be made
   * against the running thing.
   */
  timeToTerminal: 10,
};
