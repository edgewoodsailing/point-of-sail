/**
 * A telltale in the rigging: yarn streaming with the **apparent** wind
 * (DESIGN.md §4.1, pos-32n).
 *
 * Boat-frame metres, mounted inside the boat group, so it turns with the boat
 * the way a piece of yarn tied to a shroud does. `ApparentWind.angle` is already
 * a boat-frame bearing off the bow, so it drops in with no conversion — which is
 * the whole reason this is cheap.
 *
 * ## Why it earns its place
 *
 * Apparent wind is what the simulator exists to teach (§3.1) and nothing on the
 * drawing showed it: the ring is the **true** wind, and a student watching only
 * that will misread every sail on the boat. This closes the gap through the same
 * channel the real boat uses — a piece of yarn — so what is learned here
 * transfers without translation. It costs no label, no toggle and no chrome: it
 * is a physical object on the boat that happens to be an instrument, which fits
 * §7's no-scaffolding position better than any overlay could.
 *
 * ## One telltale, not three
 *
 * On the water there are three — port upper, starboard upper, backstay — and the
 * instruction is to read *whichever is furthest upwind*, because it has the
 * cleanest air, undisturbed by the sails and the hull. Drawing only that one
 * teaches the rule by demonstration instead of stating it, and keeps three
 * yarns' worth of clutter off an already abstract drawing.
 *
 * The selection has no special cases. In the boat frame, how far into the wind
 * an anchor lies is `dot(anchor, unitVector(apparent.angle))` — `angle` is the
 * direction the wind blows *from*, so that is literally its upwindness. Take the
 * maximum of the three. That one expression gives the starboard upper on
 * starboard tack, the port upper on port tack, and the backstay off the wind,
 * without a branch. With the measured chainplates it hands over to the backstay
 * at an apparent wind angle of about **103°** — just abaft the beam, which is
 * where a sailor would switch on the water.
 *
 * ## What it must not look like
 *
 * A vector. No arrowhead, a short length, and a ripple along it, because the one
 * thing this must never be mistaken for is the apparent-wind *overlay* it is
 * deliberately not (pos-740.3 draws that, as a triangle, off by default).
 */

import { degreesToRadians, smoothstep, TAU } from "../model/units.ts";
import type { Meters, MetersPerSecond, Radians, Seconds, Vec2 } from "../model/units.ts";
import {
  add,
  dot,
  knotsToMetersPerSecond,
  oppositeAngle,
  perpendicular,
  scale,
  sin,
  unitVector,
  vectorFromAngle,
} from "../model/units.ts";
import type { SimState } from "../model/simulation.ts";
import { apparentWind } from "../model/wind.ts";
import { stayStations, type StayStation } from "./hull.ts";
import type { Layer } from "./scene.ts";
import { formatNumber, svgElement } from "./svg.ts";

// --- Taste ------------------------------------------------------------------

/**
 * How long the yarn is when it is streaming, in metres.
 *
 * Not the length of real telltale yarn, which is about ten inches and would draw
 * a 4 px stub. This is a drawing of a boat rather than a scale plan, and the
 * mark has to be readable across a table (§4.2's premise) — so it is sized to be
 * legible and kept well under the boom's length so it can never read as a spar.
 */
const YARN_LENGTH: Meters = 0.62;

/**
 * What fraction of its length the yarn shows when there is no wind to stream in.
 *
 * A becalmed telltale hangs straight down, and this drawing is from above — so
 * the honest picture is not a shorter piece of yarn but the *same* piece of yarn
 * foreshortened almost to nothing. Modelling it as a length that collapses is
 * what makes a calm read as limp rather than as a missing mark.
 */
const LIMP_FRACTION = 0.3;

/**
 * The apparent wind at which the yarn stands out fully, ~2.5 kt.
 *
 * Below this it droops, which is the drawing telling the truth about a boat that
 * is barely moving in barely any air. Above it, length stops carrying
 * information — a telltale is a direction instrument, not a speed one, and the
 * arrows already own speed.
 */
const STREAMING_AT: MetersPerSecond = knotsToMetersPerSecond(2.5);

/**
 * How much more upwind a rival anchor must be before the selection changes, in
 * metres of upwindness.
 *
 * Hysteresis, not smoothing. Near the switchover the two candidates are within a
 * hair of each other and the apparent wind wanders as the boat accelerates, so a
 * bare comparison re-evaluated every frame would flick the yarn between the
 * shroud and the backstay several times a second. A band is the cheapest fix
 * that cannot oscillate, and it costs one number of state.
 *
 * It also settles the head-to-wind tie, where the two uppers are exactly equal:
 * whichever is already chosen keeps it, and on the first frame the loop's order
 * decides. Deterministic either way, which a bare `>` on two equal floats is
 * not.
 */
const SWITCH_MARGIN: Meters = 0.22;

/** Points along the yarn. Few — it is a short mark, and the ripple is one wave. */
const YARN_SAMPLES = 14;

/**
 * Ripple amplitude, as a fraction of the drawn length.
 *
 * Much larger than the sail's 4% (`render/sail.ts`), and deliberately: a
 * fluttering sail is reporting a *fault* and must stay legible as a sail, while
 * a telltale flicking about is what a healthy one does. This is the mark meant
 * to catch the eye across a table, so it moves like yarn rather than shivering
 * like cloth.
 */
const YARN_AMPLITUDE_FRACTION = 0.11;

/**
 * **Less than one wave along the yarn**, which is the difference between yarn
 * and a spring.
 *
 * The first attempt used 1.15 and it read as a curl: the tip had been carried
 * through a whole cycle, so the mark had two bends in it at all times and looked
 * like a drawn squiggle rather than something being blown. Under one wave the
 * yarn has a single travelling bend — which is what a piece of yarn in a real
 * breeze does, because it is nearly straight and the flow only has one length of
 * it to work on.
 */
const YARN_WAVES = 0.7;

/** Flicks per second. Faster than the sail's 3 Hz — a light yarn has less inertia. */
const YARN_HZ = 4.5;

/**
 * The angle the yarn's free end wanders off the wind, at full ripple.
 *
 * Applied in proportion to how far along the yarn a point is, so the knot stays
 * put and the free end travels furthest — a yarn pivoting on its tie.
 *
 * **Most of the motion lives here rather than in the transverse ripple**, and
 * that is the correction that made this read as yarn. A ripple alone wobbles a
 * line that stays pointing the same way, which looks like a drawn effect; a
 * sweep swings the whole free end about the tie, which is what the eye reads as
 * *blowing*. The ripple is then a small thing riding on top of it, not the
 * subject.
 */
const YARN_SWEEP: Radians = degreesToRadians(16);

/**
 * The phase a frozen telltale is drawn at, under `prefers-reduced-motion`.
 *
 * Not zero, which would draw it dead straight and identical to a mark with no
 * animation at all. A quarter wave leaves a visible kink, so a viewer who has
 * asked for stillness still sees a piece of *yarn* rather than a needle — the
 * same argument `render/sail.ts` makes for its still crinkle.
 */
const STILL_PHASE = 0.25;

/** Named so the one place that consults the viewer's preference is greppable. */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// --- Geometry ---------------------------------------------------------------

/** The three anchors the school ties yarn to, in the order ties break. */
const ANCHORS: readonly StayStation[] = stayStations().filter((stay) => stay.carriesTelltale);

/**
 * How far into the apparent wind an anchor lies.
 *
 * `unitVector(apparent.angle)` points the way the wind comes *from*, in the boat
 * frame, so this is the anchor's position projected onto "upwind" and nothing
 * more. The whole selection rule is one dot product.
 */
export function upwindness(anchor: Vec2, apparentAngle: Radians): number {
  return dot(anchor, unitVector(apparentAngle));
}

/**
 * Which anchor to draw, given which one is already drawn.
 *
 * `current` is `-1` before anything has been chosen. The incumbent has to be
 * beaten by {@link SWITCH_MARGIN}, which is what stops the flicker at the
 * switchover; with no incumbent the plain maximum wins.
 */
export function selectAnchor(apparentAngle: Radians, current: number): number {
  let best = current;
  let bestScore =
    current >= 0 ? upwindness(ANCHORS[current].at, apparentAngle) + SWITCH_MARGIN : -Infinity;
  for (let i = 0; i < ANCHORS.length; i += 1) {
    if (i === current) continue;
    const score = upwindness(ANCHORS[i].at, apparentAngle);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

/** How much of its length the yarn shows, from limp to fully streaming. */
export function streamingFraction(apparentSpeed: MetersPerSecond): number {
  const t = smoothstep(Math.min(apparentSpeed / STREAMING_AT, 1));
  return LIMP_FRACTION + (1 - LIMP_FRACTION) * t;
}

/**
 * The yarn as SVG path data: a polyline from the anchor, downwind, rippling.
 *
 * A polyline rather than a curve because the ripple is sampled anyway, and
 * because a piece of yarn has kinks — a perfectly faired spline would read as a
 * drawn curve, which is the thing this must not look like.
 *
 * The amplitude envelope is `smoothstep(s)`: zero where it is tied and full at
 * the free end. That is the opposite of `render/sail.ts`'s envelope, which
 * tapers to nothing at *both* ends because both ends of a sail are attachments —
 * which is exactly why the sail's flutter did not generalise to this and this is
 * its own small function rather than a fourth argument to that one.
 */
export function telltalePathData(
  anchor: Vec2,
  apparentAngle: Radians,
  apparentSpeed: MetersPerSecond,
  time: Seconds,
): string {
  const streaming = streamingFraction(apparentSpeed);
  const length = YARN_LENGTH * streaming;

  // Downwind: the way the wind is *going*, which is where yarn points.
  const downwind = oppositeAngle(apparentAngle);
  const amplitude = length * YARN_AMPLITUDE_FRACTION * streaming;
  const phase = YARN_HZ * time;
  const sweep = YARN_SWEEP * streaming * sin(TAU * phase);

  // Unit, because `perpendicular` of a unit vector is one — so the amplitude
  // below is a length in metres and never picks up a factor of the yarn.
  const acrossUnit = perpendicular(unitVector(downwind));

  const points: string[] = [];
  for (let i = 0; i <= YARN_SAMPLES; i += 1) {
    const s = i / YARN_SAMPLES;
    // The sweep is applied in proportion to s, so the tie stays put and the
    // free end travels furthest — a yarn pivoting on its knot.
    const along = vectorFromAngle(downwind + sweep * s, length * s);
    const across = scale(
      acrossUnit,
      amplitude * smoothstep(s) * sin(TAU * (YARN_WAVES * s - phase)),
    );
    const at = add(anchor, add(along, across));
    points.push(`${formatNumber(at.x)} ${formatNumber(at.y)}`);
  }
  return `M ${points.join(" L ")}`;
}

// --- The drawn layer --------------------------------------------------------

/**
 * The telltale, as a layer for `main.ts` to mount **above the sails**, so an
 * eased sail cannot bury the one mark on the boat that reports the wind it is
 * answering.
 *
 * It animates off the frame loop's clock rather than one of its own: `main.ts`
 * already calls `update` every frame, so a second `requestAnimationFrame` here
 * would be the redundancy pos-stw filed against `render/sail.ts`, added
 * knowingly.
 */
export function createTelltaleLayer(): Layer {
  const element = svgElement("g", { class: "pos-telltales" });
  const yarn = svgElement("path", {
    class: "pos-telltale",
    "vector-effect": "non-scaling-stroke",
  });
  element.append(yarn);

  let selected = -1;
  let drawn = "";

  // Subscribed rather than merely read, for `render/sail.ts`'s reason: a viewer
  // who turns the preference off mid-session should not have to touch something
  // before the yarn starts moving again.
  const stillness = matchMedia(REDUCED_MOTION_QUERY);

  const started = performance.now();

  return {
    element,
    update(state: SimState): void {
      const apparent = apparentWind(state.wind, state.motion);
      selected = selectAnchor(apparent.angle, selected);

      const time = stillness.matches ? STILL_PHASE / YARN_HZ : (performance.now() - started) / 1000;
      const next = telltalePathData(ANCHORS[selected].at, apparent.angle, apparent.speed, time);

      // Guarded, like every other per-frame attribute write in `render/`: a
      // frozen telltale would otherwise re-parse the same path sixty times a
      // second for the whole session.
      if (next !== drawn) {
        yarn.setAttribute("d", next);
        drawn = next;
      }
    },
  };
}

/** Exported for tests and the console: which anchor is currently chosen. */
export function telltaleAnchors(): readonly StayStation[] {
  return ANCHORS;
}

/** The drawn length at a given apparent wind — for tests that measure the mark. */
export function telltaleLength(apparentSpeed: MetersPerSecond): Meters {
  return YARN_LENGTH * streamingFraction(apparentSpeed);
}

/** Guards against an anchor list that silently lost a member. */
export function telltaleAnchorCount(): number {
  return ANCHORS.length;
}
