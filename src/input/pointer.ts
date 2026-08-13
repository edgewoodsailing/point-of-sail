/**
 * Pointer events, capture, and the multi-touch bookkeeping behind them
 * (DESIGN.md §5).
 *
 * The whole of this module is plumbing. What a touchdown claims and what a drag
 * computes live in `gestures.ts` as pure functions; this one turns browser
 * events into calls on them and writes the answer back. §6's rule that
 * **`input/` writes state, never renders** is why nothing here paints: the frame
 * loop in `main.ts` is already drawing every frame, so a gesture's whole job is
 * to leave the right state behind.
 *
 * ## Three decisions worth stating, because none is the obvious default
 *
 * **Listen on the host, not the `<svg>`.** An SVG with no painted background
 * receives events only over painted geometry, so a drag that began on the boat
 * and continued over open water would stop being delivered. The host is an
 * ordinary HTML element and receives events over its whole box. It also already
 * carries `touch-action: none` (§6.2), which is what stops the browser
 * speculatively treating a drag as a scroll or a pinch.
 *
 * **Capture per pointer, on the same element.** `setPointerCapture` is
 * per-`pointerId`, so two fingers can be captured by one element at once and
 * each keeps being delivered to it wherever it wanders. That is what makes
 * hit-testing a touchdown-only concern: once a finger owns a sail, nothing it
 * passes over can take it away.
 *
 * **A target belongs to one pointer at a time.** A second finger landing on a
 * sail another finger already has is given nothing rather than a shared claim,
 * and the same for the hull — two fingers fighting over one heading is not a
 * gesture, it is a tug of war. Two fingers on *different* sails is the case §5
 * built this for and it works by construction, since the two claims never meet.
 */

import type { SimState } from "../model/simulation.ts";
import type { Scene } from "../render/scene.ts";
import type { Grab, GrabTarget } from "./gestures.ts";
import { beginGrab, DEAD_ZONE_PX, dragTo, touchScale } from "./gestures.ts";

/** The state the gestures read and write. `main.ts` supplies both halves. */
export interface StateAccess {
  /** The live state, read afresh on every event. */
  read(): SimState;
  /** The state a gesture has produced. Called only when a drag actually moved something. */
  write(next: SimState): void;
}

/** What `render/scene.ts` owes the input layer, and nothing else it has. */
export type PointerScene = Pick<Scene, "toWorld" | "pixelsToMeters">;

export interface PointerBinding {
  /** Removes every listener and drops any capture still held. */
  destroy(): void;
}

/**
 * Wires the surface up to the gestures of §5, and returns the way to unwire it.
 *
 * `surface` is `.pos-sim .surface` — see the note above on why it is not the
 * `<svg>`.
 */
export function bindPointers(
  surface: HTMLElement,
  scene: PointerScene,
  state: StateAccess,
): PointerBinding {
  /** Live pointers, by `pointerId`. Its values are also the set of claimed targets. */
  const active = new Map<number, Grab>();

  function taken(): ReadonlySet<GrabTarget> {
    const targets = new Set<GrabTarget>();
    for (const grab of active.values()) targets.add(grab.target);
    return targets;
  }

  function onPointerDown(event: PointerEvent): void {
    if (active.has(event.pointerId)) return;

    const current = state.read();
    const world = scene.toWorld(event.clientX, event.clientY);
    const grab = beginGrab(current, world, touchScale(current, scene.pixelsToMeters), taken());
    // Nothing here claims open water or the perimeter. Leaving the event
    // untouched is what keeps it available to pos-bwd.2's wind ring.
    if (grab === null) return;

    active.set(event.pointerId, grab);
    surface.setPointerCapture(event.pointerId);
    // Suppresses the text selection a mouse drag would otherwise start, and the
    // synthesised mouse events a touch would. `touch-action: none` in the
    // stylesheet is what handles scrolling and zooming, not this.
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    const grab = active.get(event.pointerId);
    if (grab === undefined) return;

    const current = state.read();
    const result = dragTo(
      current,
      grab,
      scene.toWorld(event.clientX, event.clientY),
      scene.pixelsToMeters(DEAD_ZONE_PX),
    );
    active.set(event.pointerId, result.grab);
    // Identity, not deep equality: `dragTo` returns the state it was given when
    // a move asks for no change, so this is exact rather than approximate.
    if (result.state !== current) state.write(result.state);
    event.preventDefault();
  }

  /**
   * Drops a pointer's claim.
   *
   * Also reached through `lostpointercapture`, which fires for reasons this
   * module never causes — a device disconnected mid-drag, or a browser deciding
   * the capture is over. Without it the target would stay claimed for the life
   * of the page and neither finger could ever grab that sail again.
   */
  function release(event: PointerEvent): void {
    if (!active.delete(event.pointerId)) return;
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }
  }

  surface.addEventListener("pointerdown", onPointerDown);
  surface.addEventListener("pointermove", onPointerMove);
  surface.addEventListener("pointerup", release);
  surface.addEventListener("pointercancel", release);
  surface.addEventListener("lostpointercapture", release);

  return {
    destroy(): void {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", release);
      surface.removeEventListener("pointercancel", release);
      surface.removeEventListener("lostpointercapture", release);
      for (const pointerId of active.keys()) {
        if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
      }
      active.clear();
    },
  };
}
