import { describe, expect, it } from "vitest";

import {
  HULL,
  JIB,
  jibClewPosition,
  mainClewPosition,
  STATIONS,
  SWING_LIMIT,
} from "../model/boat.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, Radians, Vec2 } from "../model/units.ts";
import {
  angleOfVector,
  degreesToRadians,
  knotsToMetersPerSecond,
  magnitude,
  radiansToDegrees,
  rotateVector,
  subtract,
} from "../model/units.ts";
import { SHORT_SPAN } from "../render/scene.ts";
import type { GrabTarget, TouchScale } from "./gestures.ts";
import {
  beginGrab,
  clewGap,
  DEAD_ZONE_PX,
  dragTo,
  GRAB_RADIUS_PX,
  insideHull,
  reapply,
  toBoatPoint,
  touchScale,
} from "./gestures.ts";

const deg = degreesToRadians;

/** Degrees, for angle comparisons. Nothing here is a millidegree question. */
const ANGLE_PRECISION = 6;

// --- Fixtures ---------------------------------------------------------------

function stateWith(patch: {
  heading?: Radians;
  mainAngle?: Radians;
  jibAngle?: Radians;
  jibSet?: boolean;
}): SimState {
  return {
    wind: { from: deg(200), speed: knotsToMetersPerSecond(10) },
    motion: { heading: patch.heading ?? 0, speed: 0 },
    trim: {
      mainAngle: patch.mainAngle ?? 0,
      jibAngle: patch.jibAngle ?? 0,
      jibSet: patch.jibSet ?? true,
    },
    mainHeld: false,
    jibHeld: false,
  };
}

/**
 * The inverse of `toBoatPoint`, so a test can say where a finger is in the
 * boat's own terms and hand the module the world point a pointer would produce.
 *
 * `world = rotate(heading) · (boat − pivot)` — written out here rather than
 * imported so the module and its test do not share one possibly-wrong function.
 */
function worldPoint(boat: Vec2, heading: Radians): Vec2 {
  return rotateVector(subtract(boat, STATIONS.pivot), heading);
}

/**
 * The scene's pixel scale on a 390 px phone in portrait — the binding display
 * for every touch-target question in §5, and the one its corrected pixel
 * figures are quoted against.
 *
 * `render/scene.ts` maps `SHORT_SPAN` metres across the shorter side, so this
 * is that map and not an assumption about it. It puts the boat at 189.9 px.
 */
const PHONE_SHORT_SIDE_PX = 390;
const phoneMetersPerPixel = SHORT_SPAN / PHONE_SHORT_SIDE_PX;
const phonePixelsToMeters = (pixels: number): Meters => pixels * phoneMetersPerPixel;

/** A desktop, where the same span is spread over more pixels. */
const desktopPixelsToMeters = (pixels: number): Meters => (pixels * SHORT_SPAN) / 900;

function scaleOn(state: SimState, pixelsToMeters: (pixels: number) => Meters): TouchScale {
  return touchScale(state, pixelsToMeters);
}

/** Every legal trim pair, at a resolution finer than a finger. */
function sweepTrims(step: number, visit: (mainAngle: Radians, jibAngle: Radians) => void): void {
  const limit = radiansToDegrees(SWING_LIMIT);
  for (let main = -limit; main <= limit; main += step) {
    for (let jib = -limit; jib <= limit; jib += step) {
      visit(deg(main), deg(jib));
    }
  }
}

// --- The scene's own numbers ------------------------------------------------

describe("the phone the touch sizes are quoted against (DESIGN.md §5)", () => {
  it("puts the boat at the ~190 px §5's correction claims", () => {
    expect(HULL.loa / phoneMetersPerPixel).toBeCloseTo(189.9, 1);
  });
});

// --- Frames -----------------------------------------------------------------

describe("world → boat frame", () => {
  it("is the inverse of the scene's boat transform at any heading", () => {
    for (const heading of [0, 35, 90, -120, 179]) {
      for (const boat of [STATIONS.mast, STATIONS.bow, STATIONS.pivot, { x: 1.5, y: -0.4 }]) {
        const round = toBoatPoint(worldPoint(boat, deg(heading)), deg(heading));
        expect(round.x).toBeCloseTo(boat.x, 9);
        expect(round.y).toBeCloseTo(boat.y, 9);
      }
    }
  });

  it("puts the pivot on the world origin, which is what the hull turns about", () => {
    const at = worldPoint(STATIONS.pivot, deg(35));
    expect(magnitude(at)).toBeCloseTo(0, 12);
  });
});

// --- Grab disc sizing -------------------------------------------------------

describe("clew grab discs (DESIGN.md §5)", () => {
  it("takes the 22 px cap when the trim leaves room for it", () => {
    const flat = stateWith({ mainAngle: 0, jibAngle: 0 });
    const cap = phonePixelsToMeters(GRAB_RADIUS_PX);
    expect(scaleOn(flat, phonePixelsToMeters).grab).toBeCloseTo(cap, 12);
    // …and the cap really is a 44 px target on this display, rather than a
    // number that happens to agree with one.
    expect((2 * cap) / phoneMetersPerPixel).toBeCloseTo(44, 9);
  });

  it("takes the 22 px cap at every trim when the jib is struck", () => {
    const cap = phonePixelsToMeters(GRAB_RADIUS_PX);
    for (const mainAngle of [0, SWING_LIMIT, -SWING_LIMIT, deg(45)]) {
      const state = stateWith({ mainAngle, jibSet: false });
      expect(clewGap(state)).toBeNull();
      expect(scaleOn(state, phonePixelsToMeters).grab).toBeCloseTo(cap, 12);
    }
  });

  /**
   * The gap's minimum is *derived*, not sampled. For a fixed main clew the
   * nearest point of the jib's whole circle is `|M − tack| − foot`, and
   * `|M − tack|` is smallest at either end of the boom's legal swing — so the
   * closest the two grab points ever come is that one expression. The sweep
   * below then looks for a counterexample, which is all a sweep can do.
   */
  const MIN_GAP: Meters =
    magnitude(subtract(mainClewPosition(SWING_LIMIT), STATIONS.jibTack)) - JIB.foot;

  it("derives the closest the clews ever come, and §5's 22% of LOA is that number", () => {
    expect(MIN_GAP / HULL.loa).toBeCloseTo(0.218, 3);
    expect(MIN_GAP / phoneMetersPerPixel).toBeCloseTo(41.4, 1);
  });

  it("finds nothing closer across the whole legal trim square", () => {
    let closest = Infinity;
    sweepTrims(0.5, (mainAngle, jibAngle) => {
      const gap = clewGap(stateWith({ mainAngle, jibAngle }));
      if (gap !== null) closest = Math.min(closest, gap);
    });
    expect(closest).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
    // And the sweep reaches it: a bound nothing approaches would be a bound
    // this test could not tell from one ten times too low.
    expect(closest).toBeLessThan(MIN_GAP + 0.005);
  });

  it("shrinks below the cap where the trim is tight — so the min() is not decoration", () => {
    // The derived worst case, in the trims that produce it. The jib angle is
    // the one whose clew lies nearest the boom end, found from the geometry
    // rather than swept for.
    const worst = stateWith({ mainAngle: SWING_LIMIT, jibAngle: deg(56.2) });
    const gap = clewGap(worst);
    expect(gap).not.toBeNull();
    expect(gap ?? 0).toBeCloseTo(MIN_GAP, 2);

    const grab = scaleOn(worst, phonePixelsToMeters).grab;
    expect(grab).toBeLessThan(phonePixelsToMeters(GRAB_RADIUS_PX));
    expect(grab).toBeCloseTo((gap ?? 0) / 2, 9);
  });

  it("never lets a point lie inside both discs, at any legal trim", () => {
    // An identity rather than a measurement — `min(cap, gap/2)` means the discs
    // are at worst tangent, so the triangle inequality forbids a shared
    // interior point. Asserted across the sweep anyway, because the identity is
    // only as good as the expression that implements it.
    sweepTrims(2, (mainAngle, jibAngle) => {
      const state = stateWith({ mainAngle, jibAngle });
      const gap = clewGap(state) ?? 0;
      expect(2 * scaleOn(state, phonePixelsToMeters).grab).toBeLessThanOrEqual(gap + 1e-12);
      expect(2 * scaleOn(state, desktopPixelsToMeters).grab).toBeLessThanOrEqual(gap + 1e-12);
    });
  });

  it("keeps the dead zone a pure pixel size, independent of the trim", () => {
    const tight = scaleOn(stateWith({ mainAngle: SWING_LIMIT }), phonePixelsToMeters);
    const flat = scaleOn(stateWith({ mainAngle: 0 }), phonePixelsToMeters);
    expect(tight.deadZone).toBeCloseTo(phonePixelsToMeters(DEAD_ZONE_PX), 12);
    expect(flat.deadZone).toBeCloseTo(tight.deadZone, 12);
  });
});

// --- The hull silhouette ----------------------------------------------------

describe("the hull silhouette as a hit target (DESIGN.md §5)", () => {
  it("contains the stations that are inside a boat", () => {
    for (const inside of [STATIONS.mast, STATIONS.pivot, STATIONS.jibTack]) {
      expect(insideHull(inside)).toBe(true);
    }
  });

  it("excludes the water, and the ends by a hair rather than by a margin", () => {
    // Just outside the widest point, and just inside it: the pair is what says
    // the boundary is where the drawing puts it rather than somewhere safe.
    expect(insideHull({ x: HULL.beam / 2 + 0.02, y: STATIONS.pivot.y })).toBe(false);
    expect(insideHull({ x: HULL.beam / 2 - 0.05, y: STATIONS.pivot.y })).toBe(true);

    expect(insideHull({ x: 0, y: STATIONS.bow.y - 0.02 })).toBe(false);
    expect(insideHull({ x: 0, y: STATIONS.bow.y + 0.05 })).toBe(true);
    expect(insideHull({ x: 0, y: STATIONS.stern.y + 0.02 })).toBe(false);
    expect(insideHull({ x: 0, y: STATIONS.stern.y - 0.05 })).toBe(true);

    // Open water, where pos-bwd.2's wind ring will live.
    expect(insideHull({ x: 4, y: 0 })).toBe(false);
  });

  it("is symmetric, because the polygon is mirrored rather than written twice", () => {
    for (let y = STATIONS.bow.y; y <= STATIONS.stern.y; y += 0.1) {
      for (let x = 0.05; x < HULL.beam; x += 0.1) {
        expect(insideHull({ x, y })).toBe(insideHull({ x: -x, y }));
      }
    }
  });
});

// --- Touchdown --------------------------------------------------------------

/** What a touchdown at a boat-frame point claims, with nothing already held. */
function grabAt(state: SimState, boat: Vec2, scale?: TouchScale): GrabTarget | null {
  return (
    beginGrab(
      state,
      worldPoint(boat, state.motion.heading),
      scale ?? scaleOn(state, phonePixelsToMeters),
      new Set(),
    )?.target ?? null
  );
}

describe("touchdown arbitration (DESIGN.md §5)", () => {
  it("gives each clew to its own sail, at a heading that is not zero", () => {
    const state = stateWith({ heading: deg(35), mainAngle: deg(-40), jibAngle: deg(25) });
    expect(grabAt(state, mainClewPosition(state.trim.mainAngle))).toBe("main");
    expect(grabAt(state, jibClewPosition(state.trim.jibAngle))).toBe("jib");
  });

  it("gives the boom's midpoint to the hull, which is the whole reason for clews-only", () => {
    const state = stateWith({});
    const clew = mainClewPosition(state.trim.mainAngle);
    const midpoint: Vec2 = { x: clew.x / 2, y: clew.y / 2 };

    // §5's argument, as a measurement: a fat hit path along the boom would have
    // grabbed the wrong sail, because its midpoint is nearer the jib's clew
    // than its own.
    const toMain = magnitude(subtract(midpoint, clew));
    const toJib = magnitude(subtract(midpoint, jibClewPosition(state.trim.jibAngle)));
    expect(toJib).toBeLessThan(toMain);

    // And what actually happens there: neither sail. The boom lies on the deck,
    // so the deck answers.
    expect(grabAt(state, midpoint)).toBe("hull");
  });

  it("gives open water to nobody, so pos-bwd.2 can have the perimeter", () => {
    expect(grabAt(stateWith({}), { x: 4.5, y: 0 })).toBeNull();
  });

  it("does not offer a sail another pointer already holds", () => {
    // The main eased right out, so its clew swings clear of the topside and
    // there is nothing but water behind the disc.
    const state = stateWith({ mainAngle: SWING_LIMIT });
    const clew = mainClewPosition(state.trim.mainAngle);
    const world = worldPoint(clew, 0);
    const scale = scaleOn(state, phonePixelsToMeters);
    expect(insideHull(clew)).toBe(false);

    expect(beginGrab(state, world, scale, new Set())?.target).toBe("main");
    expect(beginGrab(state, world, scale, new Set<GrabTarget>(["main"]))).toBeNull();
  });

  /**
   * The case the test above cannot see, because it chose a clew over water.
   *
   * At ordinary trim **both** clews lie over the deck, so "skip the taken sail"
   * and "then try the hull" compose into handing a second finger the heading
   * from a touch that landed on the sail someone else is holding. Turning the
   * boat then drags that student's own sail around under their stationary
   * finger, which is a genuinely baffling thing to have happen.
   */
  it("does not turn a held clew into a hull grab, though the clew is on the deck", () => {
    const state = stateWith({ mainAngle: 0, jibAngle: 0 });
    const scale = scaleOn(state, phonePixelsToMeters);
    const cases: readonly (readonly [GrabTarget, Vec2])[] = [
      ["main", mainClewPosition(state.trim.mainAngle)],
      ["jib", jibClewPosition(state.trim.jibAngle)],
    ];

    for (const [target, clew] of cases) {
      // The premise: this clew really is over the deck, so the fall-through had
      // something to fall through to.
      expect(insideHull(clew)).toBe(true);

      const world = worldPoint(clew, 0);
      expect(beginGrab(state, world, scale, new Set())?.target).toBe(target);
      expect(beginGrab(state, world, scale, new Set<GrabTarget>([target]))).toBeNull();
    }
  });

  it("still gives the deck to the hull a whisker outside a held clew's disc", () => {
    // The other direction, so the block above is a reservation of the disc
    // rather than a blanket refusal whenever a sail is held.
    const state = stateWith({ mainAngle: 0, jibAngle: 0 });
    const scale = scaleOn(state, phonePixelsToMeters);
    const clew = mainClewPosition(state.trim.mainAngle);
    const justOutside: Vec2 = { x: clew.x, y: clew.y - scale.grab - 0.01 };
    expect(insideHull(justOutside)).toBe(true);
    expect(
      beginGrab(state, worldPoint(justOutside, 0), scale, new Set<GrabTarget>(["main"]))?.target,
    ).toBe("hull");
  });

  it("does not offer the hull to a second pointer either", () => {
    const state = stateWith({});
    // Amidships and outboard of the centreline: deck, and clear of both discs.
    const onDeck: Vec2 = { x: 0.7, y: STATIONS.pivot.y };
    const world = worldPoint(onDeck, 0);
    expect(insideHull(onDeck)).toBe(true);
    expect(beginGrab(state, world, scaleOn(state, phonePixelsToMeters), new Set())?.target).toBe(
      "hull",
    );
    expect(
      beginGrab(state, world, scaleOn(state, phonePixelsToMeters), new Set<GrabTarget>(["hull"])),
    ).toBeNull();
  });

  it("never offers a struck jib's clew", () => {
    const state = stateWith({ jibSet: false });
    const clew = jibClewPosition(state.trim.jibAngle);
    expect(clewGap(state)).toBeNull();
    // The struck jib's clew station is on the foredeck, so the hull takes it —
    // the point being that nothing reaches a sail that is not there.
    expect(grabAt(state, clew)).not.toBe("jib");
  });

  /**
   * The tie-break, exercised against a scale the sizing rule would never
   * produce.
   *
   * With `min(cap, gap/2)` the two discs are at worst tangent, so no point can
   * be strictly inside both and the nearer test decides only the single point
   * where they touch. That makes it belt-and-braces rather than the thing §5
   * called load-bearing — the *sizing* is what is load-bearing on a phone. It
   * is still worth pinning, because `beginGrab` takes the scale as an argument
   * and a future caller with a different sizing rule would land straight on it.
   */
  it("breaks a tie on the nearer clew when the discs are made to overlap", () => {
    const state = stateWith({ mainAngle: SWING_LIMIT, jibAngle: deg(56.2) });
    const main = mainClewPosition(state.trim.mainAngle);
    const jib = jibClewPosition(state.trim.jibAngle);
    const gap = clewGap(state) ?? 0;
    const overlapping: TouchScale = { grab: gap, deadZone: phonePixelsToMeters(DEAD_ZONE_PX) };

    // A point 40% of the way from the jib clew to the main clew: inside both
    // discs, nearer the jib. Then the mirror of it.
    const between = (fraction: number): Vec2 => ({
      x: jib.x + fraction * (main.x - jib.x),
      y: jib.y + fraction * (main.y - jib.y),
    });
    expect(grabAt(state, between(0.4), overlapping)).toBe("jib");
    expect(grabAt(state, between(0.6), overlapping)).toBe("main");

    // The instrument reaches what it measures: both points really are inside
    // both discs, so the answer came from the tie-break and not from one disc
    // simply missing.
    for (const fraction of [0.4, 0.6]) {
      expect(magnitude(subtract(between(fraction), main))).toBeLessThan(overlapping.grab);
      expect(magnitude(subtract(between(fraction), jib))).toBeLessThan(overlapping.grab);
    }
  });
});

// --- Dragging ---------------------------------------------------------------

/** Touch down at one boat-frame point and drag to another, returning the state. */
function drag(state: SimState, from: Vec2, to: Vec2): SimState {
  const scale = scaleOn(state, phonePixelsToMeters);
  const grab = beginGrab(state, worldPoint(from, state.motion.heading), scale, new Set());
  if (grab === null) throw new Error("touchdown claimed nothing, so there is no drag to test");
  return dragTo(state, grab, worldPoint(to, state.motion.heading), scale.deadZone).state;
}

describe("dragging a clew (DESIGN.md §5)", () => {
  it("puts the clew where the finger is", () => {
    const state = stateWith({ mainAngle: 0 });
    const from = mainClewPosition(0);
    // Dead abeam to starboard is the boom fully eased on that side.
    const next = drag(state, from, mainClewPosition(deg(75)));
    expect(radiansToDegrees(next.trim.mainAngle)).toBeCloseTo(75, ANGLE_PRECISION);
  });

  it("preserves where you grabbed, so the sail does not jump to meet a finger", () => {
    const state = stateWith({ mainAngle: 0 });
    const clew = mainClewPosition(0);
    // Touch down 0.5 m to starboard of the clew — inside the disc, but well off
    // centre — and move by exactly the same offset from the 45° clew.
    const offset = { x: 0.5, y: 0 };
    const from: Vec2 = { x: clew.x + offset.x, y: clew.y + offset.y };
    const target = mainClewPosition(deg(45));
    const next = drag(state, from, { x: target.x + offset.x, y: target.y + offset.y });

    // Not 45° — the finger kept its offset, and that is the point. What the
    // grab must not do is snap: an offset-ignoring drag would land on the
    // bearing of the moved *finger*, which is a different number again.
    expect(radiansToDegrees(next.trim.mainAngle)).not.toBeCloseTo(45, 1);

    // Landing on the clew itself, however, is exact: no offset, no correction.
    const exact = drag(state, clew, target);
    expect(radiansToDegrees(exact.trim.mainAngle)).toBeCloseTo(45, ANGLE_PRECISION);
  });

  it("drives the jib from its own tack, not the mast", () => {
    const state = stateWith({ jibAngle: 0 });
    const next = drag(state, jibClewPosition(0), jibClewPosition(deg(-50)));
    expect(radiansToDegrees(next.trim.jibAngle)).toBeCloseTo(-50, ANGLE_PRECISION);
    expect(next.trim.mainAngle).toBe(state.trim.mainAngle);
  });

  it("clamps at the shrouds, on the side the drag was heading for", () => {
    const state = stateWith({ mainAngle: 0 });
    const clew = mainClewPosition(0);
    // Well forward of abeam on each side: an ease the boom physically cannot
    // take, dragged for anyway.
    const eased = drag(state, clew, { x: 3.5, y: -2.5 });
    expect(radiansToDegrees(eased.trim.mainAngle)).toBeCloseTo(
      radiansToDegrees(SWING_LIMIT),
      ANGLE_PRECISION,
    );
    const other = drag(state, clew, { x: -3.5, y: -2.5 });
    expect(radiansToDegrees(other.trim.mainAngle)).toBeCloseTo(
      -radiansToDegrees(SWING_LIMIT),
      ANGLE_PRECISION,
    );
  });

  it("leaves a legal trim alone, so the clamp is not simply always firing", () => {
    const state = stateWith({ mainAngle: 0 });
    const next = drag(state, mainClewPosition(0), mainClewPosition(deg(80)));
    expect(radiansToDegrees(next.trim.mainAngle)).toBeCloseTo(80, ANGLE_PRECISION);
    expect(radiansToDegrees(next.trim.mainAngle)).toBeLessThan(radiansToDegrees(SWING_LIMIT));
  });

  it("never touches the heading", () => {
    const state = stateWith({ heading: deg(35) });
    const next = drag(state, mainClewPosition(0), mainClewPosition(deg(60)));
    expect(next.motion.heading).toBe(state.motion.heading);
    expect(next.motion.speed).toBe(state.motion.speed);
  });
});

describe("dragging the hull (DESIGN.md §5)", () => {
  it("rotates the boat by the angle the finger swept about the pivot", () => {
    const state = stateWith({ heading: deg(35) });
    // Touch down 1.5 m forward of the pivot — on the deck, well clear of either
    // clew — and swing 90° clockwise about it. Both points are boat-frame, so
    // `worldPoint` turns them into the world points a finger would land on.
    const from: Vec2 = { x: STATIONS.pivot.x, y: STATIONS.pivot.y - 1.5 };
    const to: Vec2 = { x: STATIONS.pivot.x + 1.5, y: STATIONS.pivot.y };
    expect(insideHull(from)).toBe(true);
    const next = drag(state, from, to);
    expect(radiansToDegrees(next.motion.heading)).toBeCloseTo(35 + 90, ANGLE_PRECISION);
  });

  it("leaves both trims exactly where they were", () => {
    const state = stateWith({ mainAngle: deg(-30), jibAngle: deg(-20) });
    const next = drag(
      state,
      { x: 0, y: STATIONS.pivot.y - 1.2 },
      { x: 1.5, y: STATIONS.pivot.y - 1 },
    );
    expect(next.trim.mainAngle).toBe(state.trim.mainAngle);
    expect(next.trim.jibAngle).toBe(state.trim.jibAngle);
    expect(next.motion.heading).not.toBe(state.motion.heading);
  });
});

describe("the dead zone about a rotation's centre", () => {
  /**
   * Both sails eased right out, so the pivot is deck rather than a clew disc.
   *
   * Sheeted flat the jib's clew lands 0.48 m from the pivot — 16 px on a phone
   * — and its grab disc covers the pivot entirely, which is §5 working as
   * designed and not what these tests are about.
   */
  const state = stateWith({ heading: deg(35), mainAngle: SWING_LIMIT, jibAngle: SWING_LIMIT });
  const scale = scaleOn(state, phonePixelsToMeters);
  /** Well inside the dead zone, which is 0.738 m on a phone. */
  const atPivot: Vec2 = { x: STATIONS.pivot.x + 0.05, y: STATIONS.pivot.y };

  it("gives a touchdown on the pivot the hull, but no bearing to steer by", () => {
    const grab = beginGrab(state, worldPoint(atPivot, state.motion.heading), scale, new Set());
    expect(grab?.target).toBe("hull");
    expect(grab?.offset).toBeNull();
  });

  it("holds the heading rather than following noise, and holds the state's identity", () => {
    const grab = beginGrab(state, worldPoint(atPivot, state.motion.heading), scale, new Set());
    const nudged: Vec2 = { x: STATIONS.pivot.x - 0.05, y: STATIONS.pivot.y + 0.05 };
    const result = dragTo(state, grab!, worldPoint(nudged, state.motion.heading), scale.deadZone);
    // The very same object, which is what `input/pointer.ts` compares against
    // to decide whether a move is worth writing back.
    expect(result.state).toBe(state);
    expect(result.grab.offset).toBeNull();
  });

  it("re-references on the way out without a jump, then rotates from there", () => {
    let grab = beginGrab(state, worldPoint(atPivot, state.motion.heading), scale, new Set())!;

    // Out of the dead zone: this move takes a reference and moves nothing.
    const out: Vec2 = { x: STATIONS.pivot.x, y: STATIONS.pivot.y - 1.5 };
    const first = dragTo(state, grab, worldPoint(out, state.motion.heading), scale.deadZone);
    expect(first.state).toBe(state);
    expect(first.grab.offset).not.toBeNull();
    grab = first.grab;

    // And the next move rotates by what the finger swept from there.
    const swept: Vec2 = { x: STATIONS.pivot.x + 1.5, y: STATIONS.pivot.y };
    const second = dragTo(
      first.state,
      grab,
      worldPoint(swept, state.motion.heading),
      scale.deadZone,
    );
    expect(radiansToDegrees(second.state.motion.heading)).toBeCloseTo(35 + 90, ANGLE_PRECISION);
  });

  it("would have spun the boat without it, which is why it is there", () => {
    // The same two points, referenced from outside the dead zone: 0.07 m of
    // finger movement about the pivot is 135° of heading. That is the motion
    // the guard suppresses, measured rather than asserted to be large.
    const near: Vec2 = { x: STATIONS.pivot.x + 0.05, y: STATIONS.pivot.y };
    const nudged: Vec2 = { x: STATIONS.pivot.x - 0.05, y: STATIONS.pivot.y + 0.05 };
    const noDeadZone = 0;
    const grab = beginGrab(state, worldPoint(near, state.motion.heading), scale, new Set())!;
    const referenced = dragTo(
      state,
      { target: grab.target, offset: null },
      worldPoint(near, state.motion.heading),
      noDeadZone,
    ).grab;
    const spun = dragTo(
      state,
      referenced,
      worldPoint(nudged, state.motion.heading),
      noDeadZone,
    ).state;
    const swing = Math.abs(
      radiansToDegrees(spun.motion.heading) - radiansToDegrees(state.motion.heading),
    );
    expect(swing).toBeGreaterThan(90);
  });
});

describe("two pointers at once (DESIGN.md §5)", () => {
  it("lets one sail be dragged while the other is held, without either moving the other", () => {
    let state = stateWith({ mainAngle: 0, jibAngle: 0 });
    const scale = scaleOn(state, phonePixelsToMeters);

    const mainGrab = beginGrab(
      state,
      worldPoint(mainClewPosition(0), state.motion.heading),
      scale,
      new Set(),
    )!;
    const jibGrab = beginGrab(
      state,
      worldPoint(jibClewPosition(0), state.motion.heading),
      scale,
      new Set<GrabTarget>([mainGrab.target]),
    )!;
    expect(mainGrab.target).toBe("main");
    expect(jibGrab.target).toBe("jib");

    // Interleaved, the way two fingers actually deliver moves.
    state = dragTo(
      state,
      mainGrab,
      worldPoint(mainClewPosition(deg(60)), state.motion.heading),
      scale.deadZone,
    ).state;
    state = dragTo(
      state,
      jibGrab,
      worldPoint(jibClewPosition(deg(-30)), state.motion.heading),
      scale.deadZone,
    ).state;
    state = dragTo(
      state,
      mainGrab,
      worldPoint(mainClewPosition(deg(70)), state.motion.heading),
      scale.deadZone,
    ).state;

    expect(radiansToDegrees(state.trim.mainAngle)).toBeCloseTo(70, ANGLE_PRECISION);
    expect(radiansToDegrees(state.trim.jibAngle)).toBeCloseTo(-30, ANGLE_PRECISION);
  });

  /**
   * The stationary finger, which is the one the event model does not report.
   *
   * A finger holding still sends no `pointermove`, so the only gesture a frame
   * recomputes is the one whose finger moved. That is harmless for two sails
   * and wrong for a sail plus the hull, so `reapply` re-runs the others from
   * where they still are.
   *
   * **The clew finger issues no second gesture here, and that is the test.** An
   * earlier version of this dragged the main again after the hull drag and
   * passed on the strength of it — supplying by hand exactly the `pointermove`
   * a browser will never send for a finger that has not moved, so it went green
   * against code where the behaviour did not exist. The only call after the
   * hull drag is the one `input/pointer.ts` makes on its own.
   */
  it("re-applies a held clew when the other finger turned the boat under it", () => {
    const state = stateWith({ heading: 0, mainAngle: 0, jibSet: false });
    const scale = scaleOn(state, phonePixelsToMeters);
    const heldAt = worldPoint(mainClewPosition(0), 0);

    const mainGrab = beginGrab(state, heldAt, scale, new Set())!;
    const hullGrab = beginGrab(
      state,
      worldPoint({ x: 0, y: STATIONS.pivot.y - 1.5 }, 0),
      scale,
      new Set<GrabTarget>(["main"]),
    )!;
    expect(hullGrab.target).toBe("hull");

    // The hull finger moves; the clew finger does not.
    const turned = dragTo(state, hullGrab, { x: 3, y: 0 }, scale.deadZone).state;
    expect(radiansToDegrees(turned.motion.heading)).toBeCloseTo(90, ANGLE_PRECISION);

    // Without the re-application the trim would still read 0 here, and would
    // then jump the whole 90° the moment the held finger twitched.
    expect(radiansToDegrees(turned.trim.mainAngle)).toBeCloseTo(0, ANGLE_PRECISION);

    const after = reapply(turned, [{ grab: mainGrab, at: heldAt }], scale.deadZone);
    expect(radiansToDegrees(after.state.trim.mainAngle)).toBeCloseTo(70.05, 2);

    // And the clew really is back under the finger: same bearing from the mast.
    const mastAt = worldPoint(STATIONS.mast, after.state.motion.heading);
    const clewAt = worldPoint(
      mainClewPosition(after.state.trim.mainAngle),
      after.state.motion.heading,
    );
    expect(angleOfVector(subtract(clewAt, mastAt))).toBeCloseTo(
      angleOfVector(subtract(heldAt, mastAt)),
      9,
    );
  });

  it("leaves a re-applied pointer alone when nothing under it moved", () => {
    // The other direction: `reapply` is not a free-running recompute. Two sails
    // are independent, so re-running the jib after the main moved must land on
    // exactly the trim it already had.
    const state = stateWith({ heading: deg(20), mainAngle: deg(-30), jibAngle: deg(-25) });
    const scale = scaleOn(state, phonePixelsToMeters);
    const jibAt = worldPoint(jibClewPosition(state.trim.jibAngle), state.motion.heading);
    const jibGrab = beginGrab(state, jibAt, scale, new Set<GrabTarget>(["main"]))!;
    expect(jibGrab.target).toBe("jib");

    const after = reapply(state, [{ grab: jibGrab, at: jibAt }], scale.deadZone);
    expect(after.state.trim.jibAngle).toBeCloseTo(state.trim.jibAngle, 12);
    expect(after.state.motion.heading).toBe(state.motion.heading);
    expect(after.state.trim.mainAngle).toBe(state.trim.mainAngle);
  });

});
