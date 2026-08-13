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
  normalizeSigned,
  radiansToDegrees,
  rotateVector,
  subtract,
  vectorFromAngle,
} from "../model/units.ts";
import { trueWindAngle } from "../model/wind.ts";
import { boatTransform, SCENE, SHORT_SPAN } from "../render/scene.ts";
import { ARROW_REACH, windArrowPathData, windTickPathData } from "../render/wind.ts";
import type { GrabTarget, TouchScale } from "./gestures.ts";
import {
  beginGrab,
  clewGap,
  DEAD_ZONE_PX,
  dragTo,
  GRAB_RADIUS_PX,
  insideHull,
  onWindRing,
  reapply,
  toBoatPoint,
  touchScale,
  WIND_BAND_PX,
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

/** A world point at a bearing and radius from the scene origin. */
function ringPoint(bearingDegrees: number, radius: Meters): Vec2 {
  return vectorFromAngle(deg(bearingDegrees), radius);
}

/**
 * The radii of every point the drawn wind arrow is made of, read out of its own
 * path data.
 *
 * Measured rather than assumed, because the band's inner edge is chosen to cover
 * the arrow and "the arrow reaches 4.45 m" is exactly the kind of claim that
 * stops being true when someone changes a barb. Parsing the `d` string is ugly
 * and it is the only way to ask the *drawing* rather than the constant.
 */
function arrowPathRadii(from: Radians): readonly Meters[] {
  const numbers = windArrowPathData(from)
    .replace(/[ML]/g, " ")
    .trim()
    .split(/\s+/)
    .map(Number);
  const radii: Meters[] = [];
  for (let i = 0; i < numbers.length; i += 2) {
    radii.push(magnitude({ x: numbers[i], y: numbers[i + 1] }));
  }
  return radii;
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

  /**
   * The ring's band, sized by the same shape of rule as the discs above: a
   * figure that would grow without bound, capped by a geometric fact so it can
   * never reach what it must not. Here the fact is the boat.
   *
   * The band is **not symmetric**, and the reason is the arrow. The whole point
   * of the wind being out here is that it has a mark you reach for; a band 22 px
   * either side of the drawn ring would put most of that mark outside the target
   * that moves it — see the two tests below, which measure exactly how much.
   */
  it("reaches out 22 px beyond the drawn ring on a phone", () => {
    const state = stateWith({ mainAngle: 0, jibAngle: 0 });
    const ring = scaleOn(state, phonePixelsToMeters).windRing;
    expect((ring.outer - SCENE.windRingRadius) / phoneMetersPerPixel).toBeCloseTo(
      WIND_BAND_PX,
      9,
    );
  });

  /**
   * The arrow inside the target, which is the whole reason the band is
   * asymmetric — and the measurement of what a symmetric one would have cost.
   *
   * `ARROW_REACH` is read from `render/wind.ts` rather than written down here,
   * so lengthening the arrow moves the target with it. The uncovered figures are
   * the ones the shape of the band was chosen against.
   */
  it("reaches in far enough to cover the whole arrow, arrowhead included", () => {
    const state = stateWith({ mainAngle: 0, jibAngle: 0 });
    for (const [label, toMeters] of [
      ["phone", phonePixelsToMeters],
      ["desktop", desktopPixelsToMeters],
    ] as const) {
      const ring = scaleOn(state, toMeters).windRing;
      expect(`${label}: ${(ring.inner <= ARROW_REACH).toString()}`).toBe(`${label}: true`);
      // Every point of the drawn arrow, at any bearing, is inside the band —
      // pushed out by one attribute quantum first, because the tip sits exactly
      // on the inner edge and `svg.ts` rounds path data to four decimals, so the
      // *drawn* tip can land a twentieth of a millimetre inside the *computed*
      // one. That is 0.002 px and it is a formatting artefact rather than a gap
      // a finger could fall into, but `>=` does not care.
      const quantum = 1e-4;
      for (let bearing = 0; bearing < 360; bearing += 30) {
        for (const radius of arrowPathRadii(deg(bearing))) {
          expect(onWindRing(ringPoint(bearing, radius + quantum), ring)).toBe(true);
        }
      }
    }
  });

  it("measures what a symmetric band would have missed, which is most of the arrow", () => {
    const state = stateWith({ mainAngle: 0, jibAngle: 0 });
    const symmetricInner = SCENE.windRingRadius - phonePixelsToMeters(WIND_BAND_PX);
    // The arrowhead first: the barb tips stand at 4.807 m, outside it.
    const radii = arrowPathRadii(0);
    expect(Math.min(...radii)).toBeCloseTo(ARROW_REACH, 12);
    expect(Math.max(...radii)).toBeCloseTo(SCENE.windRingRadius, 12);
    expect(symmetricInner).toBeGreaterThan(4.8);

    // And 17 px of the arrow's 39 px on a phone.
    expect((symmetricInner - ARROW_REACH) / phoneMetersPerPixel).toBeCloseTo(17.0, 1);
    expect((SCENE.windRingRadius - ARROW_REACH) / phoneMetersPerPixel).toBeCloseTo(39.0, 1);

    // The shipped band covers it, which is the pair that makes the figure above
    // a cost that was paid rather than one that was merely quoted.
    expect(scaleOn(state, phonePixelsToMeters).windRing.inner).toBeCloseTo(ARROW_REACH, 12);
  });

  /**
   * The separation, derived and then swept for a counterexample.
   *
   * The derivation is one inequality — the band's inner edge must clear the
   * furthest out a clew disc can reach — and it holds at every trim because both
   * terms are bounded independently of it. The sweep can only look for a
   * counterexample, which is all a sweep can ever do.
   */
  it("never reaches a point the boat can claim, at any legal trim or scale", () => {
    for (const toMeters of [phonePixelsToMeters, desktopPixelsToMeters]) {
      sweepTrims(3, (mainAngle, jibAngle) => {
        const scale = scaleOn(stateWith({ mainAngle, jibAngle }), toMeters);
        expect(scale.windRing.inner).toBeGreaterThanOrEqual(SCENE.boatRadius + scale.grab);
      });
    }
  });

  it("leaves 6 px of open water between the two targets on a phone", () => {
    const scale = scaleOn(stateWith({ mainAngle: 0, jibAngle: 0 }), phonePixelsToMeters);
    const clear = scale.windRing.inner - (SCENE.boatRadius + scale.grab);
    expect(clear / phoneMetersPerPixel).toBeCloseTo(5.9, 1);
    // Thinner than a symmetric band's 22.9 px, and that is the trade: the
    // arrowhead is worth more than water nothing can be aimed at.
    expect(clear).toBeGreaterThan(0);
  });

  /**
   * The cap, checked from both sides of the display size where it starts to
   * bind — a guard that only ever passes says nothing about its own resolution.
   *
   * The jib is struck so that `grab` is the 22 px cap rather than half a clew
   * gap, which is the worst case and the one the threshold is derived at: the
   * cap bites when `boatRadius + 22px` reaches the arrow's tip, which is at
   * 307.1 px of short axis, so 308 is the first integer that is slack.
   */
  it("is slack at a 308 px short axis and capped at 307", () => {
    const state = stateWith({ jibSet: false });
    const at = (shortSidePx: number): TouchScale =>
      scaleOn(state, (pixels) => (pixels * SHORT_SPAN) / shortSidePx);

    const slack = at(308);
    expect(slack.windRing.inner).toBeCloseTo(ARROW_REACH, 12);
    expect(slack.windRing.inner).toBeGreaterThan(SCENE.boatRadius + slack.grab);

    const capped = at(307);
    expect(capped.windRing.inner).toBeGreaterThan(ARROW_REACH);
    expect(capped.windRing.inner).toBeCloseTo(SCENE.boatRadius + capped.grab, 12);

    // What the cap costs when it binds: the arrow's tip, and nothing more than
    // the tip. Sub-pixel here, which is why 307 rather than something coarser is
    // the honest place to say the cap begins.
    expect((capped.windRing.inner - ARROW_REACH) / (SHORT_SPAN / 307)).toBeLessThan(1);
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

    // Open water, out where the wind ring lives.
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

  /**
   * The water between the boat and the ring still claims nothing.
   *
   * This is the gap the two targets are separated by, and the point is that it
   * belongs to neither rather than being handed to whichever is nearer. The
   * The gap is narrow now that the band reaches in to the arrow's tip: on a
   * phone it runs from 4.267 m to 4.450 m, about six pixels of it. The point is
   * taken as the midpoint of that gap rather than written down, because a
   * hand-picked radius six pixels wide is one refairing away from being on the
   * wrong side of a boundary and passing for the wrong reason.
   */
  it("gives the water between the boat and the ring to nobody", () => {
    const state = stateWith({});
    const scale = scaleOn(state, phonePixelsToMeters);
    const boatReach = SCENE.boatRadius + scale.grab;
    const gap = scale.windRing.inner - boatReach;
    expect(gap / phoneMetersPerPixel).toBeCloseTo(5.9, 1);

    const at = ringPoint(90, boatReach + gap / 2);
    expect(insideHull(toBoatPoint(at, state.motion.heading))).toBe(false);
    expect(onWindRing(at, scale.windRing)).toBe(false);
    expect(beginGrab(state, at, scale, new Set())).toBeNull();
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
    // The struck jib's clew station is on the foredeck, so the hull takes it.
    // Asserted as `toBe("hull")` rather than `not.toBe("jib")`: the negative
    // form passes on `null` too, which is the one answer this comment rules out
    // and the one a struck-jib bug would most plausibly produce.
    expect(insideHull(clew)).toBe(true);
    expect(grabAt(state, clew)).toBe("hull");
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
    const overlapping: TouchScale = {
      grab: gap,
      deadZone: phonePixelsToMeters(DEAD_ZONE_PX),
      windRing: scaleOn(state, phonePixelsToMeters).windRing,
    };

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

// --- The wind ring ----------------------------------------------------------

describe("touching the wind ring (DESIGN.md §5)", () => {
  const state = stateWith({ heading: deg(35), mainAngle: deg(-40), jibAngle: deg(25) });
  const scale = scaleOn(state, phonePixelsToMeters);
  const claim = (world: Vec2, taken: ReadonlySet<GrabTarget> = new Set()): GrabTarget | null =>
    beginGrab(state, world, scale, taken)?.target ?? null;

  /**
   * §5's "drag anywhere on the perimeter ring", as the thing it actually says:
   * not near the arrow, not near a graduation — anywhere.
   */
  it("claims the ring at every bearing, not only where the arrow is", () => {
    for (let bearing = 0; bearing < 360; bearing += 15) {
      expect(claim(ringPoint(bearing, SCENE.windRingRadius))).toBe("wind");
    }
  });

  /**
   * Both edges of the band, and both directions across each of them. A test that
   * only ever lands inside the band would pass just as well against a band of
   * infinite width, which is the mistake the outward edge exists to rule out.
   */
  it("stops at the band's edges, inward and outward", () => {
    const ring = scale.windRing;
    const bearing = 20;
    const step = 0.005;
    for (const [edge, outward] of [
      [ring.inner, false],
      [ring.outer, true],
    ] as const) {
      const inside = edge + (outward ? -step : step);
      const outside = edge + (outward ? step : -step);
      expect(claim(ringPoint(bearing, inside))).toBe("wind");
      expect(claim(ringPoint(bearing, outside))).toBeNull();
      // The predicate the arbitration reads, so a change to either is visible.
      expect(onWindRing(ringPoint(bearing, inside), ring)).toBe(true);
      expect(onWindRing(ringPoint(bearing, outside), ring)).toBe(false);
    }
    // The two edges are genuinely apart rather than a degenerate annulus, which
    // the four assertions above would also be satisfied by.
    expect(ring.outer - ring.inner).toBeGreaterThan(1);
  });

  /**
   * The water outside the band claims nothing, which is the deliberate half of
   * choosing an outward band over "everything outside the ring".
   *
   * §5's reason is the table: an iPad flat with students leaning over it collects
   * resting palms at the screen edges, and a target belongs to one pointer at a
   * time — so a palm that claimed the wind would lock every deliberate ring drag
   * out of it for as long as the hand stayed there.
   *
   * The radii are chosen to be reachable rather than merely far away. On a
   * phone the band's outer edge is 6.327 m, and a portrait 390 px phone shows
   * ±12.98 m down its long axis — so the first radius is a whisker outside the
   * band rather than out in space where any implementation would return null,
   * and the last is the far edge of the glass.
   */
  it("leaves the water outside the band alone, so a resting palm claims nothing", () => {
    expect(scale.windRing.outer).toBeCloseTo(6.327, 3);
    for (const radius of [scale.windRing.outer + 0.005, 9, 12.9]) {
      expect(claim(ringPoint(200, radius))).toBeNull();
    }
  });

  /**
   * The bead's own acceptance criterion: a second finger reaches the wind while
   * a first is already on a sail.
   *
   * It works because the band and the clew discs are disjoint by construction
   * and `wind` is a target of its own for the exclusivity rule — so neither the
   * held sail nor the clew-disc reservation is in the way.
   */
  it("gives the ring to a second finger while a sail is held", () => {
    const onRing = ringPoint(120, SCENE.windRingRadius);
    expect(claim(onRing, new Set<GrabTarget>(["main"]))).toBe("wind");
    expect(claim(onRing, new Set<GrabTarget>(["main", "jib"]))).toBe("wind");
    expect(claim(onRing, new Set<GrabTarget>(["hull"]))).toBe("wind");
  });

  it("does not offer the wind to a second pointer, any more than the hull", () => {
    expect(claim(ringPoint(120, SCENE.windRingRadius), new Set<GrabTarget>(["wind"]))).toBeNull();
  });

  /**
   * The fall-through the restructured `beginGrab` opened up: a touchdown on the
   * deck while the hull is held no longer returns early, it goes on to try the
   * wind. It must still come back null, and it does — not by a second guard but
   * because the band cannot reach inside the hull. Pinned because the guard was
   * removed on purpose and the reason it is safe is a separate invariant.
   */
  it("does not hand a held hull's deck to the wind on the way past", () => {
    const onDeck: Vec2 = { x: 0.7, y: STATIONS.pivot.y };
    expect(insideHull(onDeck)).toBe(true);
    const world = worldPoint(onDeck, state.motion.heading);
    expect(onWindRing(world, scale.windRing)).toBe(false);
    expect(claim(world, new Set<GrabTarget>(["hull"]))).toBeNull();
  });

  it("does not hand a held clew's disc to the wind either", () => {
    const clew = mainClewPosition(state.trim.mainAngle);
    const world = worldPoint(clew, state.motion.heading);
    expect(claim(world)).toBe("main");
    expect(claim(world, new Set<GrabTarget>(["main"]))).toBeNull();
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

  /**
   * Three implementations, three different numbers, and this pins the right one.
   *
   * **It has to name the number.** An earlier version asserted only
   * `not.toBeCloseTo(45, 1)` — that the sail had not snapped to the finger —
   * and both the shipped code and an offset-ignoring one clear 45° by about
   * six degrees, so deleting `+ grab.offset` from `dragTo` left the whole suite
   * green. §5's "a drag preserves where you grabbed" and the module docblock
   * arguing for it could both have been deleted with nothing going red.
   *
   * Touch down 0.5 m to starboard of the clew — inside the disc but well off
   * centre — and move by exactly that same offset from the 45° clew. Then:
   *
   * | Implementation | Trim |
   * | --- | --- |
   * | Grab offset preserved (shipped) | **41.498°** |
   * | Grab offset ignored | 51.097° |
   * | Snapped to the finger's own clew | 45° |
   *
   * The middle row is what the mutation produces and the reason the old
   * assertion was worthless; the bottom row is the jump the whole mechanism
   * exists to avoid.
   */
  it("preserves where you grabbed, so the sail does not jump to meet a finger", () => {
    const state = stateWith({ mainAngle: 0 });
    const clew = mainClewPosition(0);
    const offset = { x: 0.5, y: 0 };
    const from: Vec2 = { x: clew.x + offset.x, y: clew.y + offset.y };
    const target = mainClewPosition(deg(45));
    const next = drag(state, from, { x: target.x + offset.x, y: target.y + offset.y });

    expect(radiansToDegrees(next.trim.mainAngle)).toBeCloseTo(41.498, 3);

    // Landing on the clew itself, however, is exact: no offset, no correction.
    // Which is also why every *other* drag test in this file is blind to the
    // offset — they all touch down precisely on a clew, where it is zero.
    const exact = drag(state, clew, target);
    expect(radiansToDegrees(exact.trim.mainAngle)).toBeCloseTo(45, ANGLE_PRECISION);
  });

  /**
   * The offset's **sign**, which pinning one number does not cover.
   *
   * Grab to starboard of the clew and the sail must end up *short* of where a
   * finger landing on the clew would have put it; grab to port and it must
   * overshoot. Both a dropped offset term and a negated one flip that ordering
   * — dropped gives 51.097°/37.265° against the 45° zero-offset answer, on the
   * wrong sides — so this catches the same mutation from a second direction and
   * one it cannot.
   *
   * **The two are deliberately not asserted equal and opposite**, which is what
   * they look like they should be and what a first draft of this claimed. The
   * grab offsets themselves are exactly symmetric — ±9.5988°, since 0.5 m
   * across is perpendicular to a clew lying dead aft — but the results are not,
   * because at the 45° target that same 0.5 m is no longer perpendicular. The
   * corrections come out 3.502° and 1.864°.
   */
  it("carries the grab offset into the trim, on the side it was taken", () => {
    const state = stateWith({ mainAngle: 0 });
    const clew = mainClewPosition(0);
    const target = mainClewPosition(deg(45));

    const draggedWith = (dx: number): number =>
      radiansToDegrees(
        drag(state, { x: clew.x + dx, y: clew.y }, { x: target.x + dx, y: target.y }).trim
          .mainAngle,
      );

    const onTheClew = radiansToDegrees(drag(state, clew, target).trim.mainAngle);
    const toStarboard = draggedWith(0.5);
    const toPort = draggedWith(-0.5);

    expect(onTheClew).toBeCloseTo(45, ANGLE_PRECISION);
    expect(toStarboard).toBeLessThan(onTheClew);
    expect(toPort).toBeGreaterThan(onTheClew);
    // And there is something to measure on both sides: whole degrees, not a
    // rounding difference that the two orderings above would also be satisfied
    // by. 3.502° and 1.864°.
    expect(onTheClew - toStarboard).toBeGreaterThan(3);
    expect(toPort - onTheClew).toBeGreaterThan(1.5);
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

describe("dragging the wind ring (DESIGN.md §5)", () => {
  /** Touch down at one world point on the ring and drag to another. */
  function dragRing(state: SimState, from: Vec2, to: Vec2): SimState {
    const scale = scaleOn(state, phonePixelsToMeters);
    const grab = beginGrab(state, from, scale, new Set());
    if (grab?.target !== "wind") throw new Error(`touchdown claimed ${String(grab?.target)}`);
    return dragTo(state, grab, to, scale.deadZone).state;
  }

  it("turns the wind by the angle the finger swept around the ring", () => {
    const state = stateWith({ heading: deg(35) });
    const from = radiansToDegrees(state.wind.from);
    const next = dragRing(
      state,
      ringPoint(from, SCENE.windRingRadius),
      ringPoint(from + 40, SCENE.windRingRadius),
    );
    expect(radiansToDegrees(normalizeSigned(next.wind.from))).toBeCloseTo(
      radiansToDegrees(normalizeSigned(state.wind.from + deg(40))),
      ANGLE_PRECISION,
    );
  });

  /**
   * **The half that makes "drag anywhere on the ring" mean anything.**
   *
   * Grabbing the track 90° away from the arrow must rotate the wind by what the
   * finger sweeps, not snap the arrow round to meet the finger — which is the
   * same grab-offset rule the clews live by, and the same mutation is available
   * here. Three implementations, three different answers:
   *
   * | Implementation | Wind from |
   * | --- | --- |
   * | Grab offset preserved (shipped) | **240°** |
   * | Snapped to the finger — `+ grab.offset` dropped | 330° |
   * | Offset subtracted rather than added | 60° |
   *
   * The middle row is the mutation actually available in `dragTo`, and it would
   * jump the arrow a quarter turn under a finger that had barely moved. An
   * earlier version of this table put 160° in the third row, which is reachable
   * only from a sign flip inside `fromBearing`, not from anything the offset
   * term can do — corrected rather than deleted, because a mutant table that
   * names the wrong mutant is worse than none.
   */
  it("rotates the wind from where it was, however far from the arrow you grabbed", () => {
    const state = stateWith({});
    expect(radiansToDegrees(state.wind.from)).toBeCloseTo(200, ANGLE_PRECISION);

    const grabbedAt = 200 + 90;
    const next = dragRing(
      state,
      ringPoint(grabbedAt, SCENE.windRingRadius),
      ringPoint(grabbedAt + 40, SCENE.windRingRadius),
    );
    expect(radiansToDegrees(normalizeSigned(next.wind.from))).toBeCloseTo(240 - 360, 6);
    // The two answers this is not, stated so the assertion cannot be satisfied
    // by a mutant that happens to be close.
    expect(radiansToDegrees(normalizeSigned(next.wind.from))).not.toBeCloseTo(330 - 360, 1);
    expect(radiansToDegrees(normalizeSigned(next.wind.from))).not.toBeCloseTo(60, 1);
  });

  it("works the same at a radius anywhere in the band, not only on the drawn line", () => {
    const state = stateWith({});
    const from = radiansToDegrees(state.wind.from);
    const ring = scaleOn(state, phonePixelsToMeters).windRing;
    for (const radius of [
      ring.inner + 0.005,
      ARROW_REACH + 0.3,
      SCENE.windRingRadius,
      ring.outer - 0.005,
    ]) {
      const next = dragRing(state, ringPoint(from, radius), ringPoint(from + 25, radius));
      expect(radiansToDegrees(normalizeSigned(next.wind.from))).toBeCloseTo(
        radiansToDegrees(normalizeSigned(state.wind.from + deg(25))),
        ANGLE_PRECISION,
      );
    }
  });

  /**
   * The bearing stays inside (−π, π], however many times the ring is dragged
   * round.
   *
   * Uncovered until a review looked for it, because every other wind assertion
   * in this file and in `pointer.test.ts` wraps its *actual* in
   * `normalizeSigned` before comparing — so all of them pass against an `apply`
   * that never normalises. Nothing in the model minds an unbounded bearing, and
   * that is exactly why it needs saying here: `pos.report()` would print 560°,
   * and §6.3's `?wind=` serialisation would carry it into a URL.
   *
   * The hull's identical guard was equally uncovered and is checked alongside,
   * since the two share the mechanism and would be broken by the same edit.
   *
   * **A grab offset well away from zero is the whole trick**, and a first draft
   * of this test did not have one. `angleOfVector` already returns (−π, π], so a
   * touchdown *on* the arrow gives an offset of zero and every later bearing is
   * normalised before `apply` ever sees it — the test passed against the mutant.
   * Grabbing 90° round from the arrow makes the offset 110°, and a bearing near
   * +180° then sums past π with nothing but this guard to bring it back.
   */
  it("keeps both world bearings normalised, whatever the grab offset", () => {
    const state = stateWith({ heading: deg(170) });
    const scale = scaleOn(state, phonePixelsToMeters);

    // Wind from 200° — that is −160° signed — grabbed at bearing 90°.
    const windGrab = beginGrab(state, ringPoint(90, SCENE.windRingRadius), scale, new Set())!;
    expect(windGrab.target).toBe("wind");
    expect(radiansToDegrees(windGrab.offset!)).toBeCloseTo(110, 6);

    const windy = dragTo(state, windGrab, ringPoint(179, SCENE.windRingRadius), scale.deadZone)
      .state;
    // 179 + 110 = 289, which is what an unnormalised `apply` would store.
    expect(radiansToDegrees(windy.wind.from)).toBeCloseTo(289 - 360, 6);
    expect(windy.wind.from).toBeGreaterThan(-Math.PI);
    expect(windy.wind.from).toBeLessThanOrEqual(Math.PI);

    // The hull, the same way: heading 170° grabbed at bearing 20° is an offset
    // of 150°, and 179 + 150 = 329 needs folding just as much.
    const hullGrab = beginGrab(state, ringPoint(20, 1.5), scale, new Set())!;
    expect(hullGrab.target).toBe("hull");
    expect(radiansToDegrees(hullGrab.offset!)).toBeCloseTo(150, 6);

    const turned = dragTo(state, hullGrab, ringPoint(179, 1.5), scale.deadZone).state;
    expect(radiansToDegrees(turned.motion.heading)).toBeCloseTo(329 - 360, 6);
    expect(turned.motion.heading).toBeGreaterThan(-Math.PI);
    expect(turned.motion.heading).toBeLessThanOrEqual(Math.PI);
  });

  it("leaves the heading, the trims and the speed exactly where they were", () => {
    const state = stateWith({ heading: deg(35), mainAngle: deg(-40), jibAngle: deg(25) });
    const from = radiansToDegrees(state.wind.from);
    const next = dragRing(
      state,
      ringPoint(from, SCENE.windRingRadius),
      ringPoint(from + 40, SCENE.windRingRadius),
    );
    expect(next.motion.heading).toBe(state.motion.heading);
    expect(next.motion.speed).toBe(state.motion.speed);
    expect(next.trim.mainAngle).toBe(state.trim.mainAngle);
    expect(next.trim.jibAngle).toBe(state.trim.jibAngle);
    expect(next.wind.speed).toBe(state.wind.speed);
  });

  /**
   * A finger that grabbed the ring and wandered into the middle of the scene.
   *
   * Pointer capture means the drag follows it there, so unlike the hull — where
   * the dead zone is about a student putting a finger on the pivot in the first
   * place — this one is reached by an ordinary drag going somewhere odd. Same
   * answer: hold the bearing, re-reference on the way out, no jump.
   */
  it("holds the wind rather than following noise when a finger crosses the centre", () => {
    const state = stateWith({});
    const scale = scaleOn(state, phonePixelsToMeters);
    const from = radiansToDegrees(state.wind.from);
    let grab = beginGrab(state, ringPoint(from, SCENE.windRingRadius), scale, new Set())!;
    expect(grab.target).toBe("wind");

    const middle = ringPoint(0, scale.deadZone * 0.5);
    const held = dragTo(state, grab, middle, scale.deadZone);
    expect(held.state).toBe(state);
    expect(held.grab.offset).toBeNull();
    grab = held.grab;

    // Back out at a bearing 150° from where the drag began: the re-reference
    // move changes nothing, so the wind does not jump to meet the finger.
    const out = ringPoint(from + 150, SCENE.windRingRadius);
    const back = dragTo(held.state, grab, out, scale.deadZone);
    expect(back.state).toBe(state);
    // `typeof`, not `not.toBeNull()`: the negative form passes on `undefined`
    // too, which is the shape a dropped re-reference would most plausibly take.
    expect(typeof back.grab.offset).toBe("number");

    // And from there it turns by what the finger sweeps, off the new reference.
    const swept = dragTo(
      back.state,
      back.grab,
      ringPoint(from + 170, SCENE.windRingRadius),
      scale.deadZone,
    ).state;
    expect(radiansToDegrees(normalizeSigned(swept.wind.from))).toBeCloseTo(
      radiansToDegrees(normalizeSigned(state.wind.from + deg(20))),
      ANGLE_PRECISION,
    );
  });
});

/**
 * §1's whole argument, as the one property a test can actually establish.
 *
 * "Rotating the hull and rotating the wind are the same operation — only the
 * angle between them enters the model. We keep them as two distinct gestures
 * anyway, because they are two completely different experiences on the water."
 * Both halves of that are checkable: the *same* is the true wind angle, and the
 * *different* is which half of the drawing moves.
 *
 * What no test here establishes is whether they actually feel different to a
 * student, which is a question for a person in front of the screen.
 */
describe("the two rotations: same number, different events (DESIGN.md §1)", () => {
  const state = stateWith({ heading: deg(35), mainAngle: deg(-40), jibAngle: deg(25) });
  const scale = scaleOn(state, phonePixelsToMeters);

  /**
   * The state after turning the hull by `by` degrees about the pivot.
   *
   * The touchdown is 1.5 m dead ahead of the pivot in the boat frame, which puts
   * it on the world bearing of the heading itself — so the grab offset is zero
   * and dragging to `heading + by` turns the boat by exactly `by`.
   */
  function turnHull(by: number): SimState {
    const heading = radiansToDegrees(state.motion.heading);
    const touchdown = worldPoint({ x: STATIONS.pivot.x, y: STATIONS.pivot.y - 1.5 }, deg(heading));
    expect(radiansToDegrees(angleOfVector(touchdown))).toBeCloseTo(heading, 9);

    const grab = beginGrab(state, touchdown, scale, new Set())!;
    expect(grab.target).toBe("hull");
    return dragTo(state, grab, ringPoint(heading + by, 1.5), scale.deadZone).state;
  }

  /** The state after dragging the wind the same 30° the same way round. */
  function shiftWind(by: number): SimState {
    const from = radiansToDegrees(state.wind.from);
    const grab = beginGrab(state, ringPoint(from, SCENE.windRingRadius), scale, new Set())!;
    expect(grab.target).toBe("wind");
    return dragTo(state, grab, ringPoint(from + by, SCENE.windRingRadius), scale.deadZone).state;
  }

  /**
   * The *same*: 30° of hull and 30° of wind move the true wind angle by 30° in
   * opposite directions. That is not two gestures that happen to be related — it
   * is one number reached from either side, which is what §1 says the student is
   * meant to work out.
   */
  it("changes the same underlying number, in opposite senses", () => {
    const before = trueWindAngle(state.wind, state.motion);
    const turned = turnHull(30);
    const shifted = shiftWind(30);

    const byHull = radiansToDegrees(
      normalizeSigned(trueWindAngle(turned.wind, turned.motion) - before),
    );
    const byWind = radiansToDegrees(
      normalizeSigned(trueWindAngle(shifted.wind, shifted.motion) - before),
    );

    expect(Math.abs(byHull)).toBeCloseTo(30, 6);
    expect(Math.abs(byWind)).toBeCloseTo(30, 6);
    expect(Math.sign(byHull)).toBe(-Math.sign(byWind));
  });

  /**
   * The *different*: the two gestures move disjoint halves of the drawing.
   *
   * `boatTransform` is every pixel of the boat and its sails; the two wind paths
   * are every pixel of the ring. A hull drag rewrites the first and leaves the
   * second character for character, and a wind drag does the reverse. Asserted
   * on the drawn output rather than on the state fields, because the mistake
   * worth catching is a *rendering* one — orienting the world to the wind, so
   * that a wind shift swings the boat and the two gestures become pixel for
   * pixel the same animation.
   */
  it("moves disjoint halves of the drawing", () => {
    const boatBefore = boatTransform(state.motion.heading);
    const ringBefore = [
      windTickPathData(state.wind.from),
      windArrowPathData(state.wind.from),
    ].join(" ");

    const turned = turnHull(30);
    expect(boatTransform(turned.motion.heading)).not.toBe(boatBefore);
    expect(turned.wind.from).toBe(state.wind.from);
    expect(
      [windTickPathData(turned.wind.from), windArrowPathData(turned.wind.from)].join(" "),
    ).toBe(ringBefore);

    const shifted = shiftWind(30);
    expect(
      [windTickPathData(shifted.wind.from), windArrowPathData(shifted.wind.from)].join(" "),
    ).not.toBe(ringBefore);
    expect(shifted.motion.heading).toBe(state.motion.heading);
    expect(boatTransform(shifted.motion.heading)).toBe(boatBefore);
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
    expect(typeof first.grab.offset).toBe("number");
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
    // The same two points, referenced from outside the dead zone. The finger
    // travels 0.1118 m — the straight-line distance between them, not the
    // 0.0707 m radius of either, which an earlier version of this comment
    // quoted by mistake — and the heading swings **exactly 135°**. That is the
    // motion the guard suppresses, and the number is asserted rather than
    // bounded, since a bound is what let the wrong figure sit here.
    const near: Vec2 = { x: STATIONS.pivot.x + 0.05, y: STATIONS.pivot.y };
    const nudged: Vec2 = { x: STATIONS.pivot.x - 0.05, y: STATIONS.pivot.y + 0.05 };
    expect(magnitude(subtract(nudged, near))).toBeCloseTo(0.1118, 4);

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
    expect(swing).toBeCloseTo(135, 6);

    // Both points are inside the dead zone the shipped code uses, so the guard
    // really does cover the motion just measured rather than merely a motion.
    for (const point of [near, nudged]) {
      expect(magnitude(subtract(point, STATIONS.pivot))).toBeLessThan(scale.deadZone);
    }
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
