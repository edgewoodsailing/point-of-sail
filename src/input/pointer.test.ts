import { describe, expect, it } from "vitest";

import { mainClewPosition, STATIONS } from "../model/boat.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, Radians, Vec2 } from "../model/units.ts";
import {
  degreesToRadians,
  knotsToMetersPerSecond,
  radiansToDegrees,
  rotateVector,
  subtract,
} from "../model/units.ts";
import { SHORT_SPAN } from "../render/scene.ts";
import type { PointerScene, StateAccess } from "./pointer.ts";
import { bindPointers } from "./pointer.ts";

/**
 * `bindPointers` without a DOM (DESIGN.md §5, §6).
 *
 * The suite runs in the `node` environment, deliberately — `model/` is DOM-free
 * by design and `vite.config.ts` says so. That is usually the end of the
 * argument for a module in `input/`, and it was the reason this file did not
 * exist for a while: three of the four fixes that came out of this bead's
 * reviews live in `pointer.ts`, asserted only in prose.
 *
 * It turns out not to need a DOM. `bindPointers` touches exactly five methods
 * on the element it is handed — `addEventListener`, `removeEventListener`,
 * `setPointerCapture`, `hasPointerCapture`, `releasePointerCapture` — and its
 * scene is already two pure functions. So a fake surface of about thirty lines
 * covers the whole module, and jsdom would buy nothing but a slower suite.
 *
 * **What it cannot cover** is the browser's own half: whether a real stationary
 * finger truly sends no `pointermove`, whether capture survives a drag off the
 * element, and what `button` a real pen reports. Those are checked by hand in
 * Chrome, and this file does not pretend otherwise — it pins that *given* those
 * events, this module does the right thing with them.
 */

// --- A fake surface ---------------------------------------------------------

interface FakeSurface {
  /** Passed to `bindPointers` where an `HTMLElement` is expected. */
  readonly element: HTMLElement;
  /** Delivers an event to every listener registered for its type. */
  send(event: FakePointerEvent): void;
  /** Pointer ids this element currently has captured. */
  readonly captured: ReadonlySet<number>;
  /** How many listeners are still registered, so `destroy` can be checked. */
  listenerCount(): number;
  /** Ids for which `setPointerCapture` should throw, as a real one can. */
  readonly refuseCapture: Set<number>;
}

/** Only the fields `pointer.ts` reads, plus the one it calls. */
interface FakePointerEvent {
  type: string;
  pointerId: number;
  clientX: number;
  clientY: number;
  button: number;
  defaultPrevented?: boolean;
  preventDefault(): void;
}

function fakeSurface(): FakeSurface {
  const listeners = new Map<string, Set<(event: FakePointerEvent) => void>>();
  const captured = new Set<number>();
  const refuseCapture = new Set<number>();

  const element = {
    addEventListener(type: string, handler: (event: FakePointerEvent) => void): void {
      const forType = listeners.get(type) ?? new Set();
      forType.add(handler);
      listeners.set(type, forType);
    },
    removeEventListener(type: string, handler: (event: FakePointerEvent) => void): void {
      listeners.get(type)?.delete(handler);
    },
    setPointerCapture(pointerId: number): void {
      if (refuseCapture.has(pointerId)) {
        throw new Error(`no such active pointer ${pointerId}`);
      }
      captured.add(pointerId);
    },
    hasPointerCapture: (pointerId: number): boolean => captured.has(pointerId),
    releasePointerCapture(pointerId: number): void {
      captured.delete(pointerId);
    },
  };

  return {
    element: element as unknown as HTMLElement,
    send(event: FakePointerEvent): void {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
    },
    captured,
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
    refuseCapture,
  };
}

function pointerEvent(
  type: string,
  pointerId: number,
  at: { x: number; y: number },
  button = 0,
): FakePointerEvent {
  return {
    type,
    pointerId,
    clientX: at.x,
    clientY: at.y,
    button,
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
  };
}

// --- A fake scene -----------------------------------------------------------

/**
 * Client pixels ↔ world metres at the 390 px phone scale, with the origin
 * mid-surface. A pure affine map, which is all `pointer.ts` ever asks of the
 * scene — `render/scene.test.ts` owns whether the real one is right.
 */
const METERS_PER_PIXEL = SHORT_SPAN / 390;
const ORIGIN = { x: 195, y: 350 };

const scene: PointerScene = {
  toWorld: (clientX: number, clientY: number): Vec2 => ({
    x: (clientX - ORIGIN.x) * METERS_PER_PIXEL,
    y: (clientY - ORIGIN.y) * METERS_PER_PIXEL,
  }),
  pixelsToMeters: (pixels: number): Meters => pixels * METERS_PER_PIXEL,
};

/** The inverse, so a test can say where on the boat a finger lands. */
function clientOf(boat: Vec2, heading: Radians): { x: number; y: number } {
  const world = rotateVector(subtract(boat, STATIONS.pivot), heading);
  return {
    x: ORIGIN.x + world.x / METERS_PER_PIXEL,
    y: ORIGIN.y + world.y / METERS_PER_PIXEL,
  };
}

// --- Harness ----------------------------------------------------------------

const deg = degreesToRadians;

function openState(patch: { mainAngle?: Radians; jibSet?: boolean } = {}): SimState {
  return {
    wind: { from: deg(200), speed: knotsToMetersPerSecond(10) },
    motion: { heading: 0, speed: 0 },
    trim: {
      mainAngle: patch.mainAngle ?? 0,
      jibAngle: 0,
      jibSet: patch.jibSet ?? true,
    },
    mainHeld: false,
    jibHeld: false,
  };
}

function bound(initial: SimState = openState()) {
  const surface = fakeSurface();
  let state = initial;
  let writes = 0;
  const access: StateAccess = {
    read: () => state,
    write: (next) => {
      state = next;
      writes += 1;
    },
  };
  const binding = bindPointers(surface.element, scene, access);
  return {
    surface,
    binding,
    state: () => state,
    writes: () => writes,
    trim: () => radiansToDegrees(state.trim.mainAngle),
    heading: () => radiansToDegrees(state.motion.heading),
  };
}

/** A deck point clear of both clew discs, and the same point swung 90° about the pivot. */
const DECK_FROM: Vec2 = { x: STATIONS.pivot.x, y: STATIONS.pivot.y - 1.5 };
const DECK_TO: Vec2 = { x: STATIONS.pivot.x + 1.5, y: STATIONS.pivot.y };

// --- Which touchdowns are accepted ------------------------------------------

describe("which touchdowns bindPointers accepts (DESIGN.md §5)", () => {
  it("takes a contact press and steers the hull with it", () => {
    const app = bound();
    app.surface.send(pointerEvent("pointerdown", 1, clientOf(DECK_FROM, 0)));
    app.surface.send(pointerEvent("pointermove", 1, clientOf(DECK_TO, 0)));
    expect(app.heading()).toBeCloseTo(90, 6);
    expect(app.surface.captured.has(1)).toBe(true);
  });

  it("ignores a right or middle button, so neither steers the boat", () => {
    for (const button of [1, 2]) {
      const app = bound();
      app.surface.send(pointerEvent("pointerdown", 1, clientOf(DECK_FROM, 0), button));
      app.surface.send(pointerEvent("pointermove", 1, clientOf(DECK_TO, 0), button));
      expect(app.heading()).toBeCloseTo(0, 12);
      expect(app.writes()).toBe(0);
      // And no capture was taken, so nothing is left holding the pointer.
      expect(app.surface.captured.size).toBe(0);
    }
  });

  it("accepts a second, non-primary finger — the check isPrimary would have broken", () => {
    // There is no `isPrimary` field on these events at all. If `pointer.ts`
    // ever consults one it will read `undefined`, and a filter on it would fail
    // this test rather than silently disabling the second student.
    const app = bound(openState({ jibSet: false }));
    const held = clientOf(mainClewPosition(0), 0);
    app.surface.send(pointerEvent("pointerdown", 1, held));
    app.surface.send(pointerEvent("pointerdown", 2, clientOf(DECK_FROM, 0)));
    expect(app.surface.captured.has(1)).toBe(true);
    expect(app.surface.captured.has(2)).toBe(true);
  });

  it("leaves open water alone, so the perimeter stays free for pos-bwd.2", () => {
    const app = bound();
    const water = pointerEvent("pointerdown", 1, clientOf({ x: 4.5, y: 0 }, 0));
    app.surface.send(water);
    expect(app.surface.captured.size).toBe(0);
    // Not consumed either: an unclaimed touchdown must stay available.
    expect(water.defaultPrevented).toBe(false);
  });

  it("claims nothing when capture is refused, rather than stranding the target", () => {
    // Capture is taken before the claim is recorded. Were it the other way
    // round, a throw here would leave the hull held for the life of the page
    // with no pointer able to release it — so the check is that a *later*
    // pointer can still have it.
    const app = bound();
    app.surface.refuseCapture.add(1);
    expect(() =>
      app.surface.send(pointerEvent("pointerdown", 1, clientOf(DECK_FROM, 0))),
    ).toThrow();

    app.surface.send(pointerEvent("pointerdown", 2, clientOf(DECK_FROM, 0)));
    app.surface.send(pointerEvent("pointermove", 2, clientOf(DECK_TO, 0)));
    expect(app.heading()).toBeCloseTo(90, 6);
  });
});

// --- The stationary finger --------------------------------------------------

describe("a finger that does not move (DESIGN.md §5)", () => {
  it("still tracks the boat when another finger turns it", () => {
    // The whole point: pointer 1 sends *one* event, at touchdown, and never
    // again. Everything after this is pointer 2. A browser sends nothing for a
    // finger holding still, so if `onPointerMove` did not re-apply the others
    // the main would stay at 0° and then jump 70° at the first twitch.
    const app = bound(openState({ jibSet: false }));
    const held = clientOf(mainClewPosition(0), 0);

    app.surface.send(pointerEvent("pointerdown", 1, held));
    expect(app.trim()).toBeCloseTo(0, 12);

    app.surface.send(pointerEvent("pointerdown", 2, clientOf(DECK_FROM, 0)));
    app.surface.send(pointerEvent("pointermove", 2, clientOf(DECK_TO, 0)));

    expect(app.heading()).toBeCloseTo(90, 6);
    expect(app.trim()).toBeCloseTo(70.05, 2);
  });

  /**
   * What the early return in `onPointerMove` actually covers, which is
   * narrower than it looks.
   *
   * `dragTo` returns the state it was handed only when there is **no usable
   * bearing** — inside the dead zone, and on the single move that re-references
   * on the way out. It does *not* return it when the bearing is fine and the
   * computed angle happens to be unchanged, because `axis.apply` builds a new
   * object either way. So a finger redelivering the same position writes an
   * equal-valued state rather than skipping, which costs an assignment and
   * nothing else.
   *
   * Worth pinning both halves rather than the flattering one: a first draft of
   * this test asserted the skip and was simply wrong about the module.
   */
  it("skips the write only when the pointer has no bearing to read", () => {
    const app = bound(openState({ jibSet: false }));

    // Inside the dead zone about the pivot: no bearing, so no write at all.
    const onPivot = clientOf({ x: STATIONS.pivot.x + 0.05, y: STATIONS.pivot.y }, 0);
    app.surface.send(pointerEvent("pointerdown", 1, onPivot));
    const afterTouchdown = app.writes();
    app.surface.send(
      pointerEvent("pointermove", 1, clientOf({ x: STATIONS.pivot.x - 0.05, y: 0.8 }, 0)),
    );
    expect(app.writes()).toBe(afterTouchdown);
    app.surface.send(pointerEvent("pointerup", 1, onPivot));

    // Outside it, redelivering one position writes each time — and the value
    // does not drift, which is the property that actually matters.
    const clew = clientOf(mainClewPosition(0), 0);
    app.surface.send(pointerEvent("pointerdown", 2, clew));
    const before = app.writes();
    app.surface.send(pointerEvent("pointermove", 2, clew));
    app.surface.send(pointerEvent("pointermove", 2, clew));
    expect(app.writes()).toBe(before + 2);
    expect(app.trim()).toBeCloseTo(0, 9);
  });

  it("stops tracking once the hull finger lifts", () => {
    const app = bound(openState({ jibSet: false }));
    app.surface.send(pointerEvent("pointerdown", 1, clientOf(mainClewPosition(0), 0)));
    app.surface.send(pointerEvent("pointerdown", 2, clientOf(DECK_FROM, 0)));
    app.surface.send(pointerEvent("pointerup", 2, clientOf(DECK_FROM, 0)));
    expect(app.surface.captured.has(2)).toBe(false);

    const heading = app.heading();
    // Pointer 2 is gone; its events are now nobody's.
    app.surface.send(pointerEvent("pointermove", 2, clientOf(DECK_TO, 0)));
    expect(app.heading()).toBeCloseTo(heading, 12);
  });
});

// --- Exclusivity and teardown -----------------------------------------------

describe("one target, one pointer (DESIGN.md §5)", () => {
  it("gives a second finger on a held clew nothing — not the hull under it", () => {
    const app = bound();
    const clew = clientOf(mainClewPosition(0), 0);
    app.surface.send(pointerEvent("pointerdown", 1, clew));
    const heading = app.heading();

    app.surface.send(pointerEvent("pointerdown", 2, clew));
    app.surface.send(pointerEvent("pointermove", 2, clientOf(DECK_TO, 0)));
    expect(app.heading()).toBeCloseTo(heading, 12);
    expect(app.surface.captured.has(2)).toBe(false);
  });

  it("frees a sail again after its pointer is cancelled", () => {
    const app = bound();
    const clew = clientOf(mainClewPosition(0), 0);
    app.surface.send(pointerEvent("pointerdown", 1, clew));
    app.surface.send(pointerEvent("pointercancel", 1, clew));
    expect(app.surface.captured.has(1)).toBe(false);

    // A fresh pointer can take it, which it could not if the claim had leaked.
    app.surface.send(pointerEvent("pointerdown", 2, clew));
    expect(app.surface.captured.has(2)).toBe(true);
  });

  it("drops a claim when capture is lost for reasons this module never causes", () => {
    const app = bound();
    const clew = clientOf(mainClewPosition(0), 0);
    app.surface.send(pointerEvent("pointerdown", 1, clew));
    app.surface.send(pointerEvent("lostpointercapture", 1, clew));

    app.surface.send(pointerEvent("pointerdown", 2, clew));
    expect(app.surface.captured.has(2)).toBe(true);
  });

  it("unbinds everything on destroy, including a capture still held", () => {
    const app = bound();
    app.surface.send(pointerEvent("pointerdown", 1, clientOf(DECK_FROM, 0)));
    expect(app.surface.listenerCount()).toBeGreaterThan(0);

    app.binding.destroy();
    expect(app.surface.listenerCount()).toBe(0);
    expect(app.surface.captured.size).toBe(0);

    const heading = app.heading();
    app.surface.send(pointerEvent("pointerdown", 3, clientOf(DECK_FROM, 0)));
    app.surface.send(pointerEvent("pointermove", 3, clientOf(DECK_TO, 0)));
    expect(app.heading()).toBeCloseTo(heading, 12);
  });
});
