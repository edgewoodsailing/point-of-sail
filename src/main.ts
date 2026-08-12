import "./shell.css";

import { SWING_LIMIT, clampTrim } from "./model/boat.ts";
import { rigForce } from "./model/sail.ts";
import type { SimState } from "./model/simulation.ts";
import { settle } from "./model/simulation.ts";
import type { Degrees, Meters, Newtons, Radians, Vec2 } from "./model/units.ts";
import {
  add,
  degreesToRadians,
  knotsToMetersPerSecond,
  metersPerSecondToKnots,
  normalizeUnsigned,
  radiansToDegrees,
  vectorFromAngle,
} from "./model/units.ts";
import { apparentWind, trueWindAngle } from "./model/wind.ts";
import { createSailLayer, rigShapes } from "./render/sail.ts";
import { SCENE, createScene } from "./render/scene.ts";
import { formatNumber, svgElement } from "./render/svg.ts";

// Shell bootstrap. Later beads mount the remaining layers through the scene:
//   render/wind.ts onto scene.layers.wind, render/speed.ts onto
//   scene.layers.speed, input/pointer.ts onto `surface`, and the settings
//   controls onto .controls. (DESIGN.md §6)
const surface = document.querySelector<HTMLElement>(".pos-sim .surface");
if (surface === null) {
  throw new Error("Page shell is missing the drawing surface (.pos-sim .surface)");
}

/**
 * A plausible situation to draw, standing in until the bounded randomiser of
 * §2.1 lands.
 *
 * The heading is deliberately not zero, so the very first paint proves the
 * rotation is applied rather than passing by accident on an identity transform.
 *
 * Two departures from the earlier version of this state, both so the first paint
 * proves something:
 *
 * - **The jib is set**, against §3.7's main-alone default, so both sails are
 *   visible without touching a control.
 * - **The trim is on the leeward side.** This wind and heading give an apparent
 *   wind 156° off the starboard bow — a broad reach — where the previous
 *   `mainAngle: +25°` put the boom to *windward* at an angle of attack of 180°:
 *   flow arriving at the leech, no force, and a sail that correctly draws dead
 *   flat. A fine state, a useless first paint. Eased to port both sails sit near
 *   α = 80° and belly forward, which is what a run looks like.
 *
 * The speed is not written down, because it is not an input: {@link settle}
 * supplies it. On this heading at this trim the boat comes out at 3.79 kt.
 */
let state: SimState = settle({
  wind: { from: degreesToRadians(200), speed: knotsToMetersPerSecond(10) },
  motion: { heading: degreesToRadians(35), speed: 0 },
  trim: {
    mainAngle: degreesToRadians(-75),
    jibAngle: degreesToRadians(-70),
    jibSet: true,
  },
  mainHeld: false,
  jibHeld: false,
});

const scene = createScene(surface);
const sails = createSailLayer();
scene.layers.sails.append(sails.element);

// --- Scaffolding: the wind arrow -------------------------------------------
//
// A bare arrow at the perimeter, flying with the true wind, so the drawing can
// be read against a known wind instead of an inferred one. DELETE THIS when
// pos-qmk.3 lands the real wind ring (§4.1), which owns both this space and the
// gesture that will set the wind.
//
// It lives in the **world** frame — `scene.layers.wind`, which carries no
// transform — because a wind bearing is absolute. That is the whole point of
// having it here: swinging the heading moves the boat under a wind that stays
// put, which is the relationship the sails are supposed to be answering.
//
// The head is drawn as path geometry in metres rather than as a `marker`.
// Markers are sized in stroke widths by default, and these strokes are
// `non-scaling-stroke` (§4.5), so a marker would size itself off a length that
// has been taken out of user space — which draws an arrowhead the size of the
// boat.

/** Where the tail sits: on the wind ring's centreline, so the arrow points in. */
const ARROW_TAIL: Meters = SCENE.windRingRadius;
const ARROW_LENGTH: Meters = 1.4;
const ARROW_BARB: Meters = 0.4;
const ARROW_SPREAD: Radians = degreesToRadians(28);

const windArrow = svgElement("path", {
  class: "wind-scaffold",
  "vector-effect": "non-scaling-stroke",
});
scene.layers.wind.append(windArrow);

function windArrowPath(from: Radians): string {
  const point = (v: Vec2): string => `${formatNumber(v.x)} ${formatNumber(v.y)}`;
  // `wind.from` is the direction it blows *from*, so the tail goes there and the
  // arrow flies inward along `from + 180°` — the way the wind is actually going.
  const tail = vectorFromAngle(from, ARROW_TAIL);
  const tip = vectorFromAngle(from, ARROW_TAIL - ARROW_LENGTH);
  // Barbs splay back upwind from the tip, which is bearing `from` again.
  const barb = (sign: number): Vec2 =>
    add(tip, vectorFromAngle(from + sign * ARROW_SPREAD, ARROW_BARB));

  return [
    `M ${point(tail)} L ${point(tip)}`,
    `M ${point(barb(-1))} L ${point(tip)} L ${point(barb(1))}`,
  ].join(" ");
}

/** Everything that reads state, in one place, so no control can forget a layer. */
function draw(next: SimState): void {
  scene.render(next);
  sails.update?.(next);
  windArrow.setAttribute("d", windArrowPath(next.wind.from));
}

draw(state);

// --- Scaffolding -----------------------------------------------------------
//
// Sliders for the wind, the boat's motion and both trims, plus a jib switch, so
// the things this drawing has to get right can be swept by hand: that rotating
// the heading rotates the drawing, that each sail bulges to leeward at every
// trim, that the camber goes flat as a sail luffs, and that a struck jib is
// absent entirely.
//
// DELETE ALL OF THIS when pos-bwd.1 lands dragging the hull and the clews; the
// control strip belongs to the apparent-wind and jib toggles (§5).

/** Controls that re-read the state, so a change from anywhere reaches them all. */
const followers: (() => void)[] = [];

/** Patch, redraw, resync the strip. The speed is taken as given. */
function commit(next: SimState): SimState {
  state = next;
  draw(state);
  for (const follow of followers) follow();
  return state;
}

/**
 * The one way the scaffolding changes state: patch it, then **settle the speed**
 * before drawing anything.
 *
 * Speed is an output, not an input, and letting it be typed in was actively
 * misleading. Nothing stops you setting 4 kt in a flat calm, and the drawing
 * then honestly reports the 4 kt of apparent wind the boat is making for itself
 * — sails cambered, drive negative, all correct, and all describing a boat that
 * cannot exist. Ruining an intuition is a high price for a slider.
 *
 * {@link settle} is the right tool rather than a running integrator: it is the
 * *same* `step` the simulator uses, iterated to the balance point, so what the
 * page shows is by construction a speed the boat really reaches — and it needs
 * no animation loop, which this bead is explicitly not about.
 */
function apply(patch: Partial<SimState>): SimState {
  const next = { ...state, ...patch };
  // §5: *every* site that sets a sail angle routes through the clamp. The
  // console is such a site — `pos.trim({ mainAngle: pos.deg(150) })` would
  // otherwise draw a boom through the shrouds and hand `settle` a rig the boat
  // cannot hold. `pos.force` stays the way past this, which is its whole job.
  return commit(
    settle({
      ...next,
      trim: {
        ...next.trim,
        mainAngle: clampTrim(next.trim.mainAngle),
        jibAngle: clampTrim(next.trim.jibAngle),
      },
    }),
  );
}

/**
 * At most one settle per frame.
 *
 * A slider fires `input` far faster than anything can paint, and settling is
 * cheap only where the boat is actually sailing: 0.3 ms on a reach, but ~17 ms
 * in a flat calm or five degrees off the wind, where §3.5's `1/t` approach
 * spends the whole 18,000-step budget. Those are exactly the places a heading
 * drag passes through, so one settle per frame is what keeps a drag from
 * stuttering in the no-go zone.
 *
 * The thunk reads the control's value when it *fires*, never when it was
 * queued, so a coalesced drag lands on where the finger actually is.
 */
function perFrame(run: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      run();
    });
  };
}

const controls = document.querySelector<HTMLElement>(".pos-sim .controls");
if (controls !== null) {
  const scaffold = (label: string): HTMLElement => {
    const row = document.createElement("label");
    row.className = "scaffold-row";
    const caption = document.createElement("span");
    caption.textContent = label;
    row.append(caption);
    return row;
  };

  const slider = (
    label: string,
    min: number,
    max: number,
    read: (of: SimState) => number,
    onInput: (degrees: number) => void,
  ): void => {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.value = String(Math.round(read(state)));
    // setAttribute, not the `ariaLabel` property: ARIA reflection starts at
    // Safari 16.4, above the floor vite.config.ts pins (§4.4). Below it the
    // property is a silent expando and the control has no accessible name.
    input.setAttribute("aria-label", label);
    input.addEventListener(
      "input",
      perFrame(() => onInput(Number(input.value))),
    );
    // So a state set from the console does not leave the strip lying, and the
    // next drag therefore jump.
    followers.push(() => {
      input.value = String(Math.round(read(state)));
    });

    const row = scaffold(label);
    row.append(input);
    controls.append(row);
  };

  /**
   * A slider that can only be read. Speed is a *consequence* of the wind, the
   * heading and the trim, so it is shown the way the boat reports it rather
   * than offered as something to set — see {@link apply}. The bar is here
   * because a number alone makes it hard to see the boat gathering way as you
   * ease a sail in.
   */
  const readout = (label: string, min: number, max: number, read: () => number): void => {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "any";
    input.disabled = true;
    input.setAttribute("aria-label", label);

    const value = document.createElement("output");
    value.className = "scaffold-value";

    followers.push(() => {
      const knots = read();
      input.value = String(knots);
      value.textContent = `${knots.toFixed(2)} kt`;
    });

    const row = scaffold(label);
    row.append(input, value);
    controls.append(row);
  };

  const trimLimit = Math.round(radiansToDegrees(SWING_LIMIT));

  // Bearings are read back through `normalizeUnsigned` so they land inside the
  // slider's own 0–360 domain. Without it a bearing of −45° (which the state is
  // perfectly happy to hold, and `pos.set` will hand it) clamps to 0 in the
  // input while the state says 315°, and the next drag jumps — the exact thing
  // the follower above exists to prevent.
  slider(
    "Wind from",
    0,
    360,
    (of) => radiansToDegrees(normalizeUnsigned(of.wind.from)),
    (degrees) => apply({ wind: { ...state.wind, from: degreesToRadians(degrees) } }),
  );

  slider(
    "Wind kt",
    0,
    30,
    (of) => metersPerSecondToKnots(of.wind.speed),
    (knots) => apply({ wind: { ...state.wind, speed: knotsToMetersPerSecond(knots) } }),
  );

  slider(
    "Heading",
    0,
    360,
    (of) => radiansToDegrees(normalizeUnsigned(of.motion.heading)),
    (degrees) => apply({ motion: { ...state.motion, heading: degreesToRadians(degrees) } }),
  );

  // Wide enough for what the strip can actually reach: swept over the sliders'
  // own domains, `settle` returns up to ~8 kt in 30 kt of wind and down to
  // ~−7 kt running astern. A narrower bar pegs and silently stops tracking,
  // which is worse than no bar.
  readout("Boat kt", -8, 9, () => metersPerSecondToKnots(state.motion.speed));

  slider(
    "Main",
    -trimLimit,
    trimLimit,
    (of) => radiansToDegrees(of.trim.mainAngle),
    (degrees) => apply({ trim: { ...state.trim, mainAngle: degreesToRadians(degrees) } }),
  );

  slider(
    "Jib",
    -trimLimit,
    trimLimit,
    (of) => radiansToDegrees(of.trim.jibAngle),
    (degrees) => apply({ trim: { ...state.trim, jibAngle: degreesToRadians(degrees) } }),
  );

  const jibSet = document.createElement("input");
  jibSet.type = "checkbox";
  jibSet.checked = state.trim.jibSet;
  jibSet.setAttribute("aria-label", "Jib set");
  jibSet.addEventListener("input", () => {
    apply({ trim: { ...state.trim, jibSet: jibSet.checked } });
  });
  followers.push(() => {
    jibSet.checked = state.trim.jibSet;
  });

  const jibRow = scaffold("Jib set");
  jibRow.append(jibSet);
  controls.append(jibRow);

  // Once through, so the readouts show the opening state rather than nothing
  // until the first thing is touched.
  for (const follow of followers) follow();
}

// --- Scaffolding: a diagnostic handle ---------------------------------------
//
// `window.pos` — the state, the controls, and the derived numbers the drawing is
// made of, reachable from a console. DELETE with the rest of the scaffolding.
//
// This exists because "the sail looks wrong here" is a claim about *numbers* —
// which apparent wind, which angle of attack, which luff fraction — and reading
// them off a picture is guesswork. `report()` prints all of them at once, in the
// degrees a sailor would quote, so a suspect situation can be described exactly
// rather than approximately.

interface SailReport {
  trim: Degrees;
  angleOfAttack: Degrees;
  luffFraction: number;
  camber: Meters;
  driving: Newtons;
}

const pos = {
  /** The live state. */
  get state(): SimState {
    return state;
  },

  /**
   * Patch the state, settle the speed, redraw. Angles are radians, like the
   * model — use `pos.deg(45)` if you are typing degrees.
   */
  set: (patch: Partial<SimState>): SimState => apply(patch),

  /** Patch just the trim, which is the field most worth poking at. */
  trim: (patch: Partial<SimState["trim"]>): SimState =>
    apply({ trim: { ...state.trim, ...patch } }),

  /**
   * Patch **without** settling — the escape hatch the strip deliberately no
   * longer offers.
   *
   * The controls settle because a speed you typed in is usually a speed the
   * boat cannot hold, and reasoning from one wrecks your intuition. That is a
   * good default and a bad law: reproducing a transient, or checking what the
   * drawing does at a speed the boat is only passing through, needs exactly the
   * unsettled state. Named `force` so it is never reached for by accident.
   */
  force: (patch: Partial<SimState>): SimState => commit({ ...state, ...patch }),

  /** Settle the speed where it stands, e.g. after a `force`. */
  settle: (): SimState => commit(settle(state)),

  deg: degreesToRadians,
  kt: knotsToMetersPerSecond,

  /** What the sails actually feel — not the true wind the arrow shows. */
  apparent: () => {
    const wind = apparentWind(state.wind, state.motion);
    return { speed: metersPerSecondToKnots(wind.speed), angle: radiansToDegrees(wind.angle) };
  },

  /** The drawn geometry: chord endpoints and signed camber, in boat-frame metres. */
  shapes: () => rigShapes(state),

  /** Everything at once, in the units a sailor would quote. */
  report: (): Record<string, unknown> => {
    const wind = apparentWind(state.wind, state.motion);
    const shapes = rigShapes(state);
    const forces = rigForce(state.trim, wind);

    const sail = (
      angle: Radians,
      shape: { depth: Meters } | null,
      force: { angleOfAttack: Radians; luffFraction: number; driving: Newtons } | null,
    ): SailReport | null =>
      shape === null || force === null
        ? null
        : {
            trim: Number(radiansToDegrees(angle).toFixed(1)),
            angleOfAttack: Number(radiansToDegrees(force.angleOfAttack).toFixed(1)),
            luffFraction: Number(force.luffFraction.toFixed(3)),
            camber: Number(shape.depth.toFixed(3)),
            driving: Number(force.driving.toFixed(1)),
          };

    return {
      trueWindFrom: Number(radiansToDegrees(state.wind.from).toFixed(1)),
      trueWindKt: Number(metersPerSecondToKnots(state.wind.speed).toFixed(2)),
      heading: Number(radiansToDegrees(state.motion.heading).toFixed(1)),
      boatKt: Number(metersPerSecondToKnots(state.motion.speed).toFixed(2)),
      trueWindAngle: Number(radiansToDegrees(trueWindAngle(state.wind, state.motion)).toFixed(1)),
      apparentWindAngle: Number(radiansToDegrees(wind.angle).toFixed(1)),
      apparentKt: Number(metersPerSecondToKnots(wind.speed).toFixed(2)),
      main: sail(state.trim.mainAngle, shapes.main, forces.main),
      jib: sail(state.trim.jibAngle, shapes.jib, forces.jib),
    };
  },
};

(globalThis as unknown as { pos: typeof pos }).pos = pos;
