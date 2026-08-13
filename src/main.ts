import "./shell.css";

import { bindPointers } from "./input/pointer.ts";
import { knotsFromWindSpeed, WIND_SPEED_KT, windSpeedFromKnots } from "./input/windSpeed.ts";
import { clampTrim } from "./model/boat.ts";
import type { CollapseEdge } from "./model/sail.ts";
import { rigForce } from "./model/sail.ts";
import type { SimState } from "./model/simulation.ts";
import { settle, step } from "./model/simulation.ts";
import type { Degrees, Meters, Newtons, Radians, Seconds } from "./model/units.ts";
import {
  degreesToRadians,
  knotsToMetersPerSecond,
  metersPerSecondToKnots,
  radiansToDegrees,
} from "./model/units.ts";
import { apparentWind, trueWindAngle } from "./model/wind.ts";
import { createClewLayer } from "./render/clew.ts";
import { createDevicePicker, createGeometryOverlay, createWindKnobs } from "./render/geometry.ts";
import { createSailLayer, rigDrawing } from "./render/sail.ts";
import { createScene } from "./render/scene.ts";
import { createSpeedLayer } from "./render/speed.ts";
import { createTelltaleLayer } from "./render/telltale.ts";
import { createWindLayer } from "./render/wind.ts";

// Shell bootstrap. Every drawn layer mounts through the scene, onto the named
// group it belongs to; the pointer layer binds to `surface` rather than to the
// SVG, for the reason `input/pointer.ts` gives. The control strip carries §5's
// wind speed slider, and pos-740.3's two switches are what is still to come
// beside it. (DESIGN.md §6)
const surface = document.querySelector<HTMLElement>(".pos-sim .surface");
if (surface === null) {
  throw new Error("Page shell is missing the drawing surface (.pos-sim .surface)");
}

const controls = document.querySelector<HTMLElement>(".pos-sim .controls");
if (controls === null) {
  throw new Error("Page shell is missing the control strip (.pos-sim .controls)");
}

/**
 * A plausible situation to open on, standing in until the bounded randomiser of
 * §2.1 lands.
 *
 * The heading is deliberately not zero, so the very first paint proves the
 * rotation is applied rather than passing by accident on an identity transform.
 *
 * Two departures from §-default state, both so the first paint proves something:
 *
 * - **The jib is set**, against §3.7's main-alone default, so both sails and
 *   both grab points are there without touching a control — which matters more
 *   now than it did, since the jib switch went with the scaffolding and
 *   pos-740.3 owns the one that replaces it.
 * - **The trim is on the leeward side.** This wind and heading give an apparent
 *   wind 156.5° off the starboard bow — a broad reach — where a `mainAngle: +25°`
 *   would put the boom to *windward* at an angle of attack of 180°: flow
 *   arriving at the leech, no force, and a sail that correctly draws dead flat.
 *   A fine state, a useless first paint. Eased to port both sails sit near
 *   α = 80° and belly forward, which is what a run looks like.
 *
 * The speed is not written down, because it is not an input. {@link settle}
 * supplies it, so the boat opens at the speed this trim really reaches rather
 * than from rest — a student cannot tell a short speed arrow from one that has
 * not got going yet. On this heading at this trim that is **3.709 kt** — a
 * figure this docblock carried as 3.79 for several beads, so it is worth saying
 * that it is measured against the current calibration rather than remembered.
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

const wind = createWindLayer();
scene.layers.wind.append(wind.element);

const speed = createSpeedLayer();
scene.layers.speed.append(speed.element);

const sails = createSailLayer();
scene.layers.sails.append(sails.element);

const clews = createClewLayer();
scene.layers.handles.append(clews.element);

// The telltale goes on `handles` rather than `sails` so an eased sail cannot
// bury the one mark on the boat that reports the wind the sails are answering.
// It is not hardware, which is what that layer nominally holds — pos-793 owns
// the question of what the layer list should really be.
const telltale = createTelltaleLayer();
scene.layers.handles.append(telltale.element);

// --- The geometry overlay (prototyping only) --------------------------------
//
// Appended to the SVG root rather than to a named layer, so it paints above
// everything and `render/scene.ts`'s layer contract is untouched. The root and
// the world group share a transform — the world→user map is the identity — so
// world-frame metres drop straight in.
//
// On by default on this branch, because looking at it is the point. `?geometry=0`
// turns it off, and `g` toggles it.

const geometry = createGeometryOverlay(scene.pixelsToMeters, () => ({
  width: surface.clientWidth,
  height: surface.clientHeight,
}));
scene.element.append(geometry.element);
surface.append(geometry.legend);

const simRoot = document.querySelector<HTMLElement>(".pos-sim");
if (simRoot === null) throw new Error("Page shell is missing its root (.pos-sim)");
controls.append(createDevicePicker(simRoot), createWindKnobs(simRoot));

let showGeometry = new URLSearchParams(location.search).get("geometry") !== "0";
geometry.setVisible(showGeometry);

window.addEventListener("keydown", (event) => {
  if (event.key !== "g" || event.metaKey || event.ctrlKey || event.altKey) return;
  showGeometry = !showGeometry;
  geometry.setVisible(showGeometry);
});

// --- The control strip ------------------------------------------------------

/**
 * §5's wind speed slider, and the readout beside it.
 *
 * The one quantity a student sets that is *not* a direct manipulation of the
 * drawing, for the reason `input/windSpeed.ts` gives: the alternative is
 * dragging the arrow's length, which would make the same finger on the same ring
 * mean two different things. The range and both conversions live in that module
 * so they can be tested; what is here is the element.
 *
 * Built rather than written into `index.html` because the readout has to be kept
 * in step with the state, so the element and the code that feeds it belong
 * together. The strip itself is markup, and stays there.
 *
 * The value is shown. That is not the scaffolding §7 rules out — §7 is about not
 * handing the student the *answer*, and the wind is the question. A student poses
 * a situation and needs to know which one they posed; what stays unlabelled is
 * everything downstream, the boat speed and the trim quality, which are what
 * they are meant to work out from the drawing.
 */
function createWindSpeedControl(host: HTMLElement, of: SimState): (next: SimState) => void {
  const row = document.createElement("label");
  row.className = "wind-speed";

  const caption = document.createElement("span");
  caption.className = "wind-speed-caption";
  caption.textContent = "Wind";

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(WIND_SPEED_KT.min);
  input.max = String(WIND_SPEED_KT.max);
  input.step = String(WIND_SPEED_KT.step);
  input.value = String(knotsFromWindSpeed(of.wind.speed));
  // setAttribute, not the `ariaLabel` property: ARIA reflection starts at Safari
  // 16.4, above the floor `vite.config.ts` pins (§4.4). Below it the property is
  // a silent expando and the control has no accessible name at all — and the
  // wrapping label cannot supply one either, since its text is "Wind", which is
  // the direction as much as the speed.
  input.setAttribute("aria-label", "Wind speed in knots");

  const value = document.createElement("output");
  value.className = "wind-speed-value";
  // Hidden from assistive technology, not from the eye. `<output>` maps to
  // `role="status"`, which is a polite live region — so dragging the thumb from
  // 0 to 20 would announce the wind twenty times *on top of* the range
  // input announcing exactly the same number as its own value. The readout is a
  // visual duplicate of the slider's value, and the slider already says it.
  value.setAttribute("aria-hidden", "true");

  input.addEventListener("input", () => {
    commit({ ...state, wind: { ...state.wind, speed: windSpeedFromKnots(Number(input.value)) } });
  });

  row.append(caption, input, value);
  host.append(row);

  /**
   * Follows the state, so the console handle below — and pos-740's randomised
   * opening state (§2.1) — cannot leave the control lying about the wind it is
   * showing. A stale thumb is worse than no control, because the next touch of
   * it jumps the wind to wherever the thumb was sitting.
   *
   * Guarded on the string rather than assigned every frame. Writing the same
   * value back to a `range` while a thumb is being dragged is not reliably a
   * no-op across browsers, and this runs sixty times a second.
   */
  return (next: SimState): void => {
    const knots = knotsFromWindSpeed(next.wind.speed);
    const shown = String(knots);
    if (input.value !== shown) input.value = shown;
    const text = `${knots} kt`;
    if (value.textContent !== text) value.textContent = text;
  };
}

const windSpeed = createWindSpeedControl(controls, state);

/**
 * Everything that reads state, in one place, so nothing can forget a layer.
 *
 * Wired by hand, deliberately: pos-793 holds the question of whether the scene
 * should walk a registered layer list and hand each one a derived bundle
 * computed once, and asks that it not be answered speculatively. Four layers is
 * the point at which that becomes worth weighing, which is pos-793's to weigh.
 *
 * The wind speed control is on the list and is not a layer: it is HTML, it lives
 * outside the scene, and it reads one number. Worth noting for pos-793, because
 * a registry of things that take a `SimState` is a slightly different shape from
 * a registry of drawn layers, and this is the first member of the difference.
 */
function draw(next: SimState): void {
  scene.render(next);
  wind.update?.(next);
  speed.update?.(next);
  sails.update?.(next);
  clews.update?.(next);
  telltale.update?.(next);
  geometry.update(next);
  windSpeed(next);
}

// --- The frame loop ---------------------------------------------------------

/**
 * One frame's worth of simulation.
 *
 * Split out from {@link frame} on purpose. **This is where pos-dmg.3's ghost
 * boat steps** — a second, invisible integrator at optimal trim, which §4.3
 * colours the speed arrow against. It belongs beside the real boat and on the
 * same `dt`, so the two can never drift onto different clocks, and it must not
 * be reachable from the input layer: a ghost is derived from the state, never
 * patched alongside it. {@link commit} is the other half of that seam — a wind
 * or heading change invalidates the ghost, and that is the one place either can
 * happen.
 *
 * Nothing about it needs a different `step`; `model/simulation.ts` says so at
 * the top of the file.
 */
function advance(dt: Seconds): void {
  state = step(state, dt);
}

/**
 * The whole animation: advance, draw, repeat, for the life of the page.
 *
 * A **running integrator**, not a settle per change, and the difference is the
 * lesson. §3.5 integrates speed rather than solving for it precisely because a
 * keelboat takes ten seconds to get going and that lag is itself worth showing:
 * trim in properly and watch the boat gather way. The scaffolding this replaced
 * settled the speed on every slider input, which snapped instantly to the
 * answer — fine for sweeping a drawing by hand, and exactly wrong as the thing
 * a student watches. §4.3's speed-arrow colour depends on the lag being real.
 *
 * `step` clamps the slice it takes, so a tab restored after ten minutes advances
 * a tenth of a second rather than fast-forwarding ten minutes of sailing, and a
 * frame timer that hands back a `NaN` delta advances nothing at all.
 *
 * The loop runs unconditionally rather than only while something is moving. It
 * costs a `step` and a `draw` a frame — tens of microseconds of arithmetic —
 * and the alternative is a threshold below which the boat is declared to have
 * stopped, which is a number nobody can justify and a stall nobody can see the
 * cause of.
 *
 * One consequence worth recording rather than leaving to be discovered:
 * `render/sail.ts` keeps a `requestAnimationFrame` loop of its own for the luff
 * flutter, because it was written against a caller that only redrew on state
 * changes. Under a per-frame `update` that loop is redundant — it repaints the
 * cloth a second time on the frames a sail is shaking. Harmless (a duplicate
 * path write, measured there at 27 µs for both cloths) and not this bead's file
 * to change; filed as pos-stw.
 */
let lastFrame = performance.now();

function frame(now: DOMHighResTimeStamp): void {
  advance((now - lastFrame) / 1000);
  lastFrame = now;
  draw(state);
  requestAnimationFrame(frame);
}

// Painted once before the first frame is asked for, so the page never shows an
// empty surface while it waits for one.
draw(state);
requestAnimationFrame(frame);

// --- Input ------------------------------------------------------------------

/**
 * The one way anything outside the loop changes the state (§6: `input/` writes
 * state, `render/` reads it).
 *
 * It does not draw. The loop above is already drawing every frame, so a gesture
 * that painted would only be painting the same frame twice. And it is the seam
 * pos-dmg.3 needs on the other side: a heading or wind change makes the ghost
 * boat's reference stale, and this is the one place either changes.
 */
function commit(next: SimState): void {
  state = next;
}

bindPointers(surface, scene, { read: () => state, write: commit });

// --- A diagnostic handle ----------------------------------------------------
//
// `window.pos` — the state, and the derived numbers the drawing is made of,
// reachable from a console.
//
// This survived the scaffolding that pos-bwd.1 deleted, and deliberately.
// "The sail looks wrong here" is a claim about *numbers* — which apparent wind,
// which angle of attack, how much of the sail has collapsed — and reading them
// off a picture is guesswork. `report()` prints all of them at once, in the
// degrees a sailor would quote.
//
// **The argument that kept it has now been spent, and it is still here.** Until
// this bead, the console was the only way to set the wind at all; the ring and
// the slider above have taken that job, so `pos.set` is no longer load-bearing.
// What remains is the half that was always the better reason: every quantity
// below is derived, none of it is drawn, and no gesture will ever expose it. A
// diagnostic that prints what the picture cannot say is worth its weight
// independently of whether anything else can reach the state, so it stays —
// stated here so the next reader does not have to re-derive it from a comment
// that has stopped being true.
//
// Note that `report()` overstates the rig force above 13 kt of true wind, since
// it calls `rigForce` directly and §3.2's depowering is applied in
// `simulation.ts` rather than inside it. That is pos-jhl, which this bead
// leaves open rather than fixing out of scope.

interface SailReport {
  trim: Degrees;
  angleOfAttack: Degrees;
  collapsedFraction: number;
  /**
   * Which end that collapse ran in from (§3.3). Printed beside the fraction
   * rather than folded into it, because the fraction alone reads the same at
   * α = 3° and α = 177° while the cloth is letting go at opposite ends.
   */
  collapseFrom: CollapseEdge;
  camber: Meters;
  driving: Newtons;
  /**
   * §4.2's traffic light as the number behind it — the **raw** driving-force
   * ratio, deliberately unclamped, because a diagnostic that folded it would
   * hide the two things worth diagnosing. Back the main and this reads −0.51,
   * not 0; sit a hair off the sampled optimum and it can read just over 1.
   * `render/palette.ts` does the folding onto the ramp, so 1 is green and
   * anything at or below 0 is red.
   */
  quality: number;
}

const pos = {
  /** The live state. */
  get state(): SimState {
    return state;
  },

  /**
   * Patch the state. Angles are radians, like the model — use `pos.deg(45)` if
   * you are typing degrees.
   *
   * No settle, because the loop is running: whatever this leaves behind is what
   * the boat integrates away from, which is the honest thing for a simulator
   * that is always live. §5's rule that *every* site setting a sail angle
   * routes through `clampTrim` covers the console too — otherwise
   * `pos.trim({ mainAngle: pos.deg(150) })` would draw a boom through the
   * shrouds.
   */
  set: (patch: Partial<SimState>): SimState => {
    const next = { ...state, ...patch };
    commit({
      ...next,
      trim: {
        ...next.trim,
        mainAngle: clampTrim(next.trim.mainAngle),
        jibAngle: clampTrim(next.trim.jibAngle),
      },
    });
    return state;
  },

  /** Patch just the trim, which is the field most worth poking at. */
  trim: (patch: Partial<SimState["trim"]>): SimState =>
    pos.set({ trim: { ...state.trim, ...patch } }),

  /**
   * Jump the speed to where this wind, heading and trim would eventually take
   * it, instead of waiting out the acceleration. The loop carries on from
   * there, and since a settled speed is a balance point it stays put.
   */
  settle: (): SimState => {
    commit(settle(state));
    return state;
  },

  deg: degreesToRadians,
  kt: knotsToMetersPerSecond,

  /** What the sails actually feel — not the true wind the ring shows. */
  apparent: () => {
    const wind = apparentWind(state.wind, state.motion);
    return { speed: metersPerSecondToKnots(wind.speed), angle: radiansToDegrees(wind.angle) };
  },

  /**
   * What the drawing is made of: each sail's chord endpoints and signed camber
   * in boat-frame metres, and the §4.2 trim quality it is painted with.
   */
  drawing: () => rigDrawing(state),

  /** Everything at once, in the units a sailor would quote. */
  report: (): Record<string, unknown> => {
    const wind = apparentWind(state.wind, state.motion);
    const drawing = rigDrawing(state);
    const forces = rigForce(state.trim, wind);

    const sail = (
      angle: Radians,
      drawn: { shape: { depth: Meters }; quality: number } | null,
      force: {
        angleOfAttack: Radians;
        collapsedFraction: number;
        collapseFrom: CollapseEdge;
        driving: Newtons;
      } | null,
    ): SailReport | null =>
      drawn === null || force === null
        ? null
        : {
            trim: Number(radiansToDegrees(angle).toFixed(1)),
            angleOfAttack: Number(radiansToDegrees(force.angleOfAttack).toFixed(1)),
            collapsedFraction: Number(force.collapsedFraction.toFixed(3)),
            collapseFrom: force.collapseFrom,
            camber: Number(drawn.shape.depth.toFixed(3)),
            driving: Number(force.driving.toFixed(1)),
            quality: Number(drawn.quality.toFixed(3)),
          };

    return {
      trueWindFrom: Number(radiansToDegrees(state.wind.from).toFixed(1)),
      trueWindKt: Number(metersPerSecondToKnots(state.wind.speed).toFixed(2)),
      heading: Number(radiansToDegrees(state.motion.heading).toFixed(1)),
      boatKt: Number(metersPerSecondToKnots(state.motion.speed).toFixed(2)),
      trueWindAngle: Number(radiansToDegrees(trueWindAngle(state.wind, state.motion)).toFixed(1)),
      apparentWindAngle: Number(radiansToDegrees(wind.angle).toFixed(1)),
      apparentKt: Number(metersPerSecondToKnots(wind.speed).toFixed(2)),
      main: sail(state.trim.mainAngle, drawing.main, forces.main),
      jib: sail(state.trim.jibAngle, drawing.jib, forces.jib),
    };
  },
};

(globalThis as unknown as { pos: typeof pos }).pos = pos;
