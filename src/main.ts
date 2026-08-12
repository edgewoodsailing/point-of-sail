import "./shell.css";

import { SWING_LIMIT } from "./model/boat.ts";
import type { SimState } from "./model/simulation.ts";
import { degreesToRadians, knotsToMetersPerSecond, radiansToDegrees } from "./model/units.ts";
import { createSailLayer } from "./render/sail.ts";
import { createScene } from "./render/scene.ts";

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
 *   wind 155° off the starboard bow — a broad reach — where the previous
 *   `mainAngle: +25°` put the boom to *windward* at an angle of attack of 180°:
 *   flow arriving at the leech, no force, and a sail that correctly draws dead
 *   flat. A fine state, a useless first paint. Eased to port both sails sit near
 *   α = 80° and belly forward, which is what a run looks like.
 */
let state: SimState = {
  wind: { from: degreesToRadians(200), speed: knotsToMetersPerSecond(10) },
  motion: { heading: degreesToRadians(35), speed: knotsToMetersPerSecond(4) },
  trim: {
    mainAngle: degreesToRadians(-75),
    jibAngle: degreesToRadians(-70),
    jibSet: true,
  },
  mainHeld: false,
  jibHeld: false,
};

const scene = createScene(surface);
const sails = createSailLayer();
scene.layers.sails.append(sails.element);

/** Everything that reads state, in one place, so no control can forget a layer. */
function draw(next: SimState): void {
  scene.render(next);
  sails.update?.(next);
}

draw(state);

// --- Scaffolding -----------------------------------------------------------
//
// Sliders for heading and both trims, plus a jib switch, so the things this
// drawing has to get right can be swept by hand: that rotating the heading
// rotates the drawing, that each sail bulges to leeward at every trim, that the
// camber goes flat as a sail luffs, and that a struck jib is absent entirely.
//
// DELETE ALL OF THIS when pos-bwd.1 lands dragging the hull and the clews; the
// control strip belongs to the apparent-wind and jib toggles (§5).

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
    value: number,
    onInput: (degrees: number) => void,
  ): void => {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "1";
    input.value = String(Math.round(value));
    // setAttribute, not the `ariaLabel` property: ARIA reflection starts at
    // Safari 16.4, above the floor vite.config.ts pins (§4.4). Below it the
    // property is a silent expando and the control has no accessible name.
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => onInput(Number(input.value)));

    const row = scaffold(label);
    row.append(input);
    controls.append(row);
  };

  const trimLimit = Math.round(radiansToDegrees(SWING_LIMIT));

  slider("Heading", 0, 360, radiansToDegrees(state.motion.heading), (degrees) => {
    state = { ...state, motion: { ...state.motion, heading: degreesToRadians(degrees) } };
    draw(state);
  });

  slider("Main", -trimLimit, trimLimit, radiansToDegrees(state.trim.mainAngle), (degrees) => {
    state = { ...state, trim: { ...state.trim, mainAngle: degreesToRadians(degrees) } };
    draw(state);
  });

  slider("Jib", -trimLimit, trimLimit, radiansToDegrees(state.trim.jibAngle), (degrees) => {
    state = { ...state, trim: { ...state.trim, jibAngle: degreesToRadians(degrees) } };
    draw(state);
  });

  const jibSet = document.createElement("input");
  jibSet.type = "checkbox";
  jibSet.checked = state.trim.jibSet;
  jibSet.setAttribute("aria-label", "Jib set");
  jibSet.addEventListener("input", () => {
    state = { ...state, trim: { ...state.trim, jibSet: jibSet.checked } };
    draw(state);
  });

  const jibRow = scaffold("Jib set");
  jibRow.append(jibSet);
  controls.append(jibRow);
}
