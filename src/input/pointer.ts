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
import type { GrabTarget, Held } from "./gestures.ts";
import { beginGrab, DEAD_ZONE_PX, dragTo, reapply, touchScale } from "./gestures.ts";

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
  /**
   * Live pointers, by `pointerId`: what each has hold of and where it last was.
   *
   * The position is kept because a finger holding still sends no
   * `pointermove`, and {@link reapply} needs somewhere to read it from. It is
   * stored in **world metres** rather than client pixels, which is what makes
   * it survive: `toWorld` depends on the layout and the viewBox, neither of
   * which a gesture changes, so a stored world point stays the point that
   * finger is on however far the boat turns under it.
   */
  const active = new Map<number, Held>();

  function taken(): ReadonlySet<GrabTarget> {
    const targets = new Set<GrabTarget>();
    for (const held of active.values()) targets.add(held.grab.target);
    return targets;
  }

  function onPointerDown(event: PointerEvent): void {
    if (active.has(event.pointerId)) return;
    // Contact only. A touch or a pen touching down reports button 0, as does a
    // left mouse button; a right or middle button reports 2 or 1, and without
    // this a right-button drag would steer the boat — with the context menu
    // opening over the drawing partway through, since `preventDefault` on a
    // pointerdown does not suppress `contextmenu`.
    //
    // **Not `isPrimary`**, which looks like the same check and is the opposite
    // of what multi-touch needs: the second finger down is by definition not
    // primary, and it is the whole point of §5's two students.
    if (event.button !== 0) return;

    const current = state.read();
    const world = scene.toWorld(event.clientX, event.clientY);
    const grab = beginGrab(current, world, touchScale(current, scene.pixelsToMeters), taken());
    // Nothing here claims open water or the perimeter. Leaving the event
    // untouched is what keeps it available to pos-bwd.2's wind ring.
    if (grab === null) return;

    // Capture *then* claim, not the other way round. The two lines look
    // interchangeable and are not: if `setPointerCapture` ever threw, claiming
    // first would leave the target held for the life of the page with no
    // pointer able to release it, whereas this way the touchdown simply does
    // not take.
    surface.setPointerCapture(event.pointerId);
    active.set(event.pointerId, { grab, at: world });
    // Suppresses the text selection a mouse drag would otherwise start, and the
    // synthesised mouse events a touch would. `touch-action: none` in the
    // stylesheet is what handles scrolling and zooming, not this.
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    const held = active.get(event.pointerId);
    if (held === undefined) return;
    event.preventDefault();

    const deadZone = scene.pixelsToMeters(DEAD_ZONE_PX);
    const current = state.read();
    const world = scene.toWorld(event.clientX, event.clientY);

    const moved = dragTo(current, held.grab, world, deadZone);
    active.set(event.pointerId, { grab: moved.grab, at: world });
    // Identity, not deep equality: `dragTo` returns the state it was given when
    // a move asks for no change, so this is exact rather than approximate — and
    // a move that changed nothing cannot have changed anything for the other
    // fingers either.
    if (moved.state === current) return;

    // The other fingers have not moved, but the world under them may have.
    const others = [...active].filter(([id]) => id !== event.pointerId);
    const again = reapply(
      moved.state,
      others.map(([, other]) => other),
      deadZone,
    );
    others.forEach(([id], index) => active.set(id, again.held[index]));
    state.write(again.state);
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
