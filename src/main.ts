import "./shell.css";

import type { SimState } from "./model/simulation.ts";
import { degreesToRadians, knotsToMetersPerSecond, radiansToDegrees } from "./model/units.ts";
import { createScene } from "./render/scene.ts";

// Shell bootstrap. Later beads mount the remaining layers through the scene:
//   render/sail.ts and render/wind.ts onto scene.boat and scene.world,
//   input/pointer.ts onto `surface`, and the settings controls onto .controls.
//   (DESIGN.md §6)
const surface = document.querySelector<HTMLElement>(".pos-sim .surface");
if (surface === null) {
  throw new Error("Page shell is missing the drawing surface (.pos-sim .surface)");
}

/**
 * A plausible situation to draw, standing in until the bounded randomiser of
 * §2.1 lands. Main-only, because that is the default rig (§3.7) — which makes
 * this the case the forestay requirement is about: no jib, and the boat must
 * still read as a sloop.
 *
 * The heading is deliberately not zero, so the very first paint proves the
 * rotation is applied rather than passing by accident on an identity transform.
 */
const state: SimState = {
  wind: { from: degreesToRadians(200), speed: knotsToMetersPerSecond(10) },
  motion: { heading: degreesToRadians(35), speed: knotsToMetersPerSecond(4) },
  trim: { mainAngle: degreesToRadians(25), jibAngle: 0, jibSet: false },
  mainHeld: false,
  jibHeld: false,
};

const scene = createScene(surface);
scene.render(state);

// --- Scaffolding -----------------------------------------------------------
//
// A heading slider, so "rotating the heading rotates the drawing" can be
// checked by hand. DELETE THIS when pos-bwd.1 lands dragging the hull; the
// control strip belongs to the apparent-wind and jib toggles (§5).

const controls = document.querySelector<HTMLElement>(".pos-sim .controls");
if (controls !== null) {
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "360";
  slider.step = "1";
  slider.value = String(Math.round(radiansToDegrees(state.motion.heading)));
  slider.className = "heading-scaffold";
  slider.ariaLabel = "Heading";

  slider.addEventListener("input", () => {
    scene.render({
      ...state,
      motion: { ...state.motion, heading: degreesToRadians(Number(slider.value)) },
    });
  });

  controls.append(slider);
}
