import { describe, expect, it } from "vitest";

import sceneCss from "./scene.css?raw";
import { HULL, STATIONS } from "../model/boat.ts";
import type { Meters, Vec2 } from "../model/units.ts";
import {
  degreesToRadians,
  knotsToMetersPerSecond,
  magnitude,
  rotateVector,
  subtract,
} from "../model/units.ts";
import { SCENE, SHORT_SPAN, sceneExtent } from "./scene.ts";
import {
  SPEED_FULL_SCALE,
  SPEED_KNEE,
  SPEED_LIMIT,
  SPEED_REACH,
  createSpeedLayer,
  speedArrowLength,
  speedArrowPathData,
  underWay,
} from "./speed.ts";

/**
 * Every measurement below is read back out of the emitted `d` string, because
 * that string is what the renderer actually hands the DOM. So the tolerance is
 * the *formatter's*, not the arithmetic's: `formatNumber` rounds to four
 * decimals, which puts up to a fifth of a millimetre on a length built from two
 * coordinates. On a boat measured in metres that is exactness enough.
 */
const METRES = 3;

/** Figures written down in `speed.ts`, restated so the module cannot agree with itself. */
const ARROW_BARB = 0.4;
const HULL_GAP = 0.2;

const kt = knotsToMetersPerSecond;

/**
 * `scene.css` with its comments stripped.
 *
 * That stylesheet is heavily annotated, and several of its comments quote the
 * declarations they explain. Scanning the raw text would let a commented-out or
 * merely *quoted* declaration answer for a live one, which is the same class of
 * mistake as reading a declaration that loses the cascade.
 */
const STYLESHEET = sceneCss.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The three terms of `--pos-rule-speed`, read out of `scene.css`.
 *
 * The stroke is the one input to the arrow's edge margin that is not in metres
 * and does not live in TypeScript, so restating it here — as this test used to
 * — meant `scene.css` could raise it and nothing would notice (pos-7nt). The
 * margin is generous enough that the invariant would have held anyway, but the
 * figure in `speed.ts`'s `EDGE_KEEP_OUT` comment would have gone quietly wrong,
 * which is the failure this repository keeps writing tests against.
 *
 * Parsed rather than evaluated because `clamp()` needs a viewport to resolve
 * and the test supplies several. Anything it cannot read — an unknown shape, a
 * missing declaration, or more than one — throws with instructions, since
 * silently falling back to a default or to the first match would restore
 * exactly the coupling it is here to remove.
 */
const SPEED_STROKE = parseStrokeClamp("--pos-rule-speed");

function parseStrokeClamp(property: string): {
  minPx: number;
  vminPercent: number;
  maxPx: number;
} {
  const declarations = [...STYLESHEET.matchAll(new RegExp(`${property}\\s*:\\s*([^;]+);`, "g"))];
  if (declarations.length === 0) throw new Error(`${property} is not declared in scene.css.`);
  if (declarations.length > 1) {
    // Reading the first match would be reading a declaration that need not win
    // the cascade: a `@media` override later in the file paints a different
    // stroke while this test carries on checking the old one — which is the
    // drift pos-7nt exists to close, reintroduced through the tripwire itself.
    throw new Error(
      `${property} is declared ${declarations.length} times in scene.css. This test reads a ` +
        `single declaration and cannot resolve a cascade, so it would silently check a value ` +
        `the browser does not paint. Fold them into one, or teach this which one wins and ` +
        `re-check EDGE_KEEP_OUT's comment in speed.ts against the result.`,
    );
  }
  const declared = declarations[0]![1]!.trim();
  const terms = /^clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vmin\s*,\s*([\d.]+)px\s*\)$/.exec(declared);
  if (terms === null) {
    throw new Error(
      `${property} is \`${declared}\`, which this test cannot read. It understands ` +
        `clamp(<min>px, <n>vmin, <max>px). Teach it the new shape, then re-check ` +
        `EDGE_KEEP_OUT's comment in speed.ts against the overhang that falls out.`,
    );
  }
  return {
    minPx: Number(terms[1]),
    vminPercent: Number(terms[2]),
    maxPx: Number(terms[3]),
  };
}

/** Every `x y` pair in some path data, in order. */
function pathPoints(d: string): Vec2[] {
  const numbers = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const points: Vec2[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    points.push({ x: numbers[i]!, y: numbers[i + 1]! });
  }
  return points;
}

/** Distance from the pivot, which is the scene origin and what the bands measure from. */
const fromPivot = (p: Vec2): number => magnitude(subtract(p, STATIONS.pivot));

/** The tip is the second point of the shaft. */
const tipOf = (speed: number): Vec2 => pathPoints(speedArrowPathData(speed))[1]!;

describe("speed arrow scale (DESIGN.md §4.1, §4.3)", () => {
  it("reaches exactly the band reserved for it, at hull speed", () => {
    // The calibration, and the reason `SPEED_REACH` is derived rather than
    // typed: `contentRadius` exists to hold this arrow at this speed, so the two
    // have to agree by construction and not by coincidence.
    expect(fromPivot(tipOf(SPEED_FULL_SCALE))).toBeCloseTo(SCENE.contentRadius, METRES);
    expect(fromPivot(tipOf(-SPEED_FULL_SCALE))).toBeCloseTo(SCENE.contentRadius, METRES);
    expect(SPEED_FULL_SCALE).toBeCloseTo(HULL.hullSpeed, 10);
  });

  it("gives the arrow room worth having, after handing the hull its gap back", () => {
    // `scene.test.ts` makes the same claim about the *band* — better than ¾ of a
    // metre per m/s. The arrow gets that less the clear water it leaves at the
    // stem, and what this pins is that the gap stays a trim off the end rather
    // than growing into a real share of the drawing.
    const band = SCENE.contentRadius - magnitude(subtract(STATIONS.bow, STATIONS.pivot));
    expect(SPEED_REACH).toBeCloseTo(band - HULL_GAP, 9);
    expect(SPEED_REACH / HULL.hullSpeed).toBeGreaterThan(0.7);
    expect(SPEED_REACH).toBeGreaterThan(2);
    expect(HULL_GAP / band).toBeLessThan(0.1);
  });

  it("is linear in speed everywhere out to the wind ring", () => {
    const half = speedArrowLength(SPEED_FULL_SCALE / 2);
    expect(half).toBeCloseTo(SPEED_REACH / 2, METRES);
    expect(speedArrowLength(SPEED_FULL_SCALE)).toBeCloseTo(2 * half, METRES);
    // The decision §4.1 asks for in as many words: `contentRadius` is a
    // reservation, not a clamp. Above hull speed the arrow keeps growing and
    // crosses the wind ring rather than pretending 5.6 kt and 8 kt are the same.
    expect(speedArrowLength(kt(8))).toBeGreaterThan(SPEED_REACH);
    expect(fromPivot(tipOf(kt(8)))).toBeGreaterThan(SCENE.windRingRadius);
  });

  it("draws the plain linear law, unbent, at every speed short of the ring", () => {
    // What pos-w4v's knee placement buys, asserted rather than claimed: the
    // bend is in the band past `windRingRadius` and nowhere else, so every
    // speed the boat sails at draws exactly what it drew before.
    const linear = (speed: number): number => (SPEED_REACH * Math.abs(speed)) / SPEED_FULL_SCALE;
    for (let knots = 0; knots <= 6.8; knots += 0.05) {
      expect(speedArrowLength(kt(knots))).toBeCloseTo(linear(kt(knots)), 12);
    }
    expect(SPEED_KNEE).toBeCloseTo(SCENE.windRingRadius - (SCENE.contentRadius - SPEED_REACH), 12);
    expect(SPEED_KNEE).toBeGreaterThan(SPEED_REACH);
  });

  it("leaves the linear law tangentially, with no corner at the knee", () => {
    // Slope 1 on both sides, so the arrow does not visibly kink as it crosses
    // the ring. Compared across the knee rather than at it, since that is where
    // a corner would show.
    const step = 1e-4;
    const at = (length: Meters): number =>
      speedArrowLength((length * SPEED_FULL_SCALE) / SPEED_REACH);
    const before = (at(SPEED_KNEE) - at(SPEED_KNEE - step)) / step;
    const after = (at(SPEED_KNEE + step) - at(SPEED_KNEE)) / step;
    expect(before).toBeCloseTo(1, 3);
    expect(after).toBeCloseTo(1, 3);
  });

  it("grows with speed wherever it still can, and reads the same either way", () => {
    // Swept far past anything the model can produce on purpose: the wind
    // slider's 30 kt ceiling is scaffolding pos-bwd.1 deletes, so no top speed
    // is a safe thing for this law to be correct only below.
    //
    // "Wherever it still can" is the honest claim rather than a hedge. The law
    // is monotone everywhere, and strictly so until it is within a *nanometre*
    // of `SPEED_LIMIT` — after which the remaining gap is a handful of ulps,
    // consecutive speeds round together, and by 30.35 kt it is flat outright.
    // Stating the strict half against a distance rather than a speed is what
    // keeps the assertion about the law instead of about the model's ceiling.
    const RESOLVED: Meters = 1e-9;
    let previous = speedArrowLength(0);
    expect(previous).toBe(0);
    for (let knots = 0.25; knots <= 60; knots += 0.25) {
      const length = speedArrowLength(kt(knots));
      expect(length).toBeGreaterThanOrEqual(previous);
      if (previous < SPEED_LIMIT - RESOLVED) expect(length).toBeGreaterThan(previous);
      expect(speedArrowLength(kt(-knots))).toBeCloseTo(length, 12);
      previous = length;
    }
  });

  it("has no arrow at all below a length its own stroke would swallow", () => {
    expect(underWay(0)).toBe(false);
    expect(underWay(kt(0.1))).toBe(false);
    expect(underWay(kt(-0.1))).toBe(false);
    // A boat ghosting along at a quarter knot is moving, and should say so.
    expect(underWay(kt(0.25))).toBe(true);
    expect(underWay(kt(-0.25))).toBe(true);
  });
});

describe("the speed arrow never leaves the viewBox (pos-w4v)", () => {
  /**
   * The one invariant this bead is actually about, and it is stated over the
   * *whole* speed domain rather than over what the model happens to reach
   * today. The model is being made slower as this lands, and the wind slider's
   * 30 kt ceiling is scaffolding pos-bwd.1 deletes — a test pinned to any
   * measured top speed would be testing the wrong thing and would break the
   * moment either changed.
   *
   * `SCENE.shortRadius` is the whole bound, on every viewport: see the extent
   * test below for why. It is radial, and the boat group only ever rotates
   * about the origin, so heading cannot break it.
   */
  const speeds = (): number[] => {
    const swept = [];
    for (let knots = -60; knots <= 60; knots += 0.05) swept.push(kt(knots));
    // Absurd on purpose: the law has to be total, not merely adequate.
    return [...swept, kt(1e3), kt(1e6), Number.MAX_VALUE, Infinity, -Infinity];
  };

  it("keeps every point it draws inside the short-axis half-span", () => {
    for (const speed of speeds()) {
      if (!underWay(speed)) continue;
      for (const drawn of pathPoints(speedArrowPathData(speed))) {
        expect(fromPivot(drawn)).toBeLessThan(SCENE.shortRadius);
      }
    }
  });

  /**
   * Half the drawn stroke, in metres — the bit that overhangs the tip, because
   * `.pos-speed-mark` is round-capped.
   *
   * Derived rather than asserted from memory, since it is the number that
   * justifies `EDGE_KEEP_OUT` and it is not obvious. Two different lengths are
   * in play and they are *not* the same one:
   *
   * - The stroke is `clamp(1.6px, 0.45vmin, 4px)`, and `vmin` is the
   *   **viewport's** short side.
   * - Metres per pixel is `SHORT_SPAN / surfaceShort`, and `surfaceShort` is
   *   the **drawing surface's** short side.
   *
   * §6.2 stacks the control strip *below* the surface, so in landscape the
   * strip comes off the short axis and the surface is shorter than the
   * viewport. Assuming the two were equal — as this test first did — understates
   * the overhang by up to a factor of two.
   *
   * The clamp's terms come from {@link SPEED_STROKE}, which reads them out of
   * `scene.css`, so this stays a derivation of the stroke the browser will
   * actually paint rather than a second copy of it.
   */
  const halfStrokeMeters = (viewport: [number, number], stripPx: number): Meters => {
    const [width, height] = viewport;
    const surfaceShort = Math.min(width, height - stripPx);
    const vmin = Math.min(width, height);
    const { minPx, vminPercent, maxPx } = SPEED_STROKE;
    // `clamp(MIN, VAL, MAX)` is `max(MIN, min(VAL, MAX))` — MIN wins outright if
    // someone ever writes one above MAX. Nesting it the other way round would
    // agree on every sane declaration and quietly disagree on that one.
    const strokePx = Math.max(minPx, Math.min((vminPercent * vmin) / 100, maxPx));
    return (strokePx / 2) * (SHORT_SPAN / surfaceShort);
  };

  it("reads the stroke width from the stylesheet that actually sets it", () => {
    // The pin itself. `--pos-rule-speed` is the one input to the overhang that
    // does not live in TypeScript, and until pos-7nt this test restated it as a
    // literal — so raising it in `scene.css` left the suite green, `speed.ts`'s
    // comment stale, and the round cap a little further through the viewport
    // edge. Parsing it means the CSS cannot move on its own.
    expect(SPEED_STROKE).toEqual({ minPx: 1.6, vminPercent: 0.45, maxPx: 4 });
    // And the property this parsed is the one `.pos-speed-mark` actually paints
    // with. Matching `stroke-width: var(--pos-rule-speed)` anywhere in the file
    // would be satisfied by a dead rule, or by a different element using the
    // same custom property, while the arrow itself had moved to a literal — so
    // the margin would again be derived from a width the arrow does not use.
    // The check has to name the selector the sentence above names.
    const rules = [...STYLESHEET.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(([, selector]) =>
      selector!.includes(".pos-speed-mark"),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]![2]).toMatch(/stroke-width:\s*var\(--pos-rule-speed\)/);
  });

  it("leaves room for the stroke, which overhangs the tip it is drawn on", () => {
    // The module keeps the tail radius private, so it is recovered the only way
    // the exports allow: it is what `contentRadius` has left over once the
    // arrow's own hull-speed reach is taken out of it.
    const tailRadius = SCENE.contentRadius - SPEED_REACH;
    const viewports: [number, number][] = [
      [320, 568],
      [568, 320],
      [390, 844],
      [844, 390],
      [768, 1024],
      [1024, 768],
      [1440, 900],
      [2560, 1080],
    ];
    // 160 px is the *current* scaffolding strip — seven rows of controls — and
    // so more than §5's eventual strip will ever want. Worst case across all of
    // it is 0.060 m, on a 568x320 landscape phone, where the strip leaves only
    // 160 px of surface. Portrait never exceeds 0.030 m.
    for (const viewport of viewports) {
      for (const stripPx of [0, 100, 160]) {
        const overhang = halfStrokeMeters(viewport, stripPx);
        expect(overhang).toBeLessThan(0.07);
        expect(SPEED_LIMIT + tailRadius + overhang).toBeLessThan(SCENE.shortRadius);
      }
    }
  });

  it("is bounded by its limit at every speed there is, finite or not", () => {
    // The bound is a property of the law and not of how hard the test happened
    // to push, which is what makes it worth having: `1 − e^(−x)` cannot exceed
    // 1, so nothing that can be handed to this function gets past the limit.
    for (const speed of speeds()) {
      expect(speedArrowLength(speed)).toBeLessThanOrEqual(SPEED_LIMIT);
    }
    // 20 kt is already nonsense for a 19-foot keelboat, and the law is still
    // strictly below its limit there — by a nanometre, but below. It rounds up
    // to the limit at 30.35 kt.
    expect(speedArrowLength(kt(20))).toBeLessThan(SPEED_LIMIT);
    expect(speedArrowLength(kt(20))).toBeCloseTo(SPEED_LIMIT, 6);
    expect(SPEED_LIMIT).toBeGreaterThan(SPEED_KNEE);
  });

  it("is bounded by the viewBox itself, on every viewport shape", () => {
    // The link the invariant above rests on: `sceneExtent` scales by the
    // *shorter* side, so the smaller half-span is `shortRadius` exactly —
    // portrait, landscape or square. Nothing narrower than that exists to fall
    // foul of.
    for (const [width, height] of [
      [390, 844],
      [844, 390],
      [768, 768],
      [1440, 900],
      [320, 480],
      [2560, 1080],
    ]) {
      const extent = sceneExtent(width!, height!);
      expect(Math.min(extent.halfWidth, extent.halfHeight)).toBeCloseTo(SCENE.shortRadius, 9);
    }
  });

  it("stays on screen at every heading, in the world frame the viewBox measures", () => {
    // Belt as well as braces: the bound above is radial because the boat group
    // only rotates, and this is that assumption spent rather than assumed —
    // the drawn points carried through `boatTransform`'s rotation by hand and
    // checked against the viewBox's actual sides.
    //
    // The samples are *derived*, deliberately. They were once the literals
    // 5.646 and 8.915 — hull speed and the measured top speed — which is
    // precisely what the comment at the top of this block says a test must not
    // be pinned to. Written that way they would not have failed when the model
    // changed; they would have gone on passing while quietly sampling speeds
    // that no longer meant anything. Each of these is the speed at which the
    // arrow reaches a *landmark of the drawing*, so they keep their meaning
    // whatever the model does.
    const speedAtLength = (length: Meters): number => (length * SPEED_FULL_SCALE) / SPEED_REACH;
    const hullSpeed = SPEED_FULL_SCALE; // tip on contentRadius
    const atRing = speedAtLength(SPEED_KNEE); // tip on the wind ring: the knee
    const saturated = speedAtLength(SPEED_LIMIT) * 10; // far into the flat tail
    const extent = sceneExtent(768, 768);
    for (const speed of [-saturated, -atRing, -hullSpeed, hullSpeed, atRing, saturated]) {
      const drawn = pathPoints(speedArrowPathData(speed));
      for (let degrees = 0; degrees < 360; degrees += 5) {
        for (const point of drawn) {
          const world = rotateVector(subtract(point, STATIONS.pivot), degreesToRadians(degrees));
          expect(Math.abs(world.x)).toBeLessThan(extent.halfWidth);
          expect(Math.abs(world.y)).toBeLessThan(extent.halfHeight);
        }
      }
    }
  });
});

describe("speed arrow direction (DESIGN.md §3.4)", () => {
  it("projects off the bow with way on, and off the stern with sternway", () => {
    const ahead = pathPoints(speedArrowPathData(kt(4)));
    // −y is forward in the boat frame, so ahead of the bow is *above* it.
    expect(ahead[0]!.y).toBeCloseTo(STATIONS.bow.y - HULL_GAP, METRES);
    expect(ahead[1]!.y).toBeLessThan(ahead[0]!.y);

    const astern = pathPoints(speedArrowPathData(kt(-4)));
    expect(astern[0]!.y).toBeCloseTo(STATIONS.stern.y + HULL_GAP, METRES);
    expect(astern[1]!.y).toBeGreaterThan(astern[0]!.y);
  });

  it("never touches the boat, at any speed and either way", () => {
    // The arrow is a thing said *about* the boat, so it may not appear welded to
    // it. Anchored at the station rather than clear of it, the tail would share
    // a point with the stem — and at the stern, where the layer paints under the
    // hull, it would look like it was sliding out from beneath the transom.
    for (let knots = -9; knots <= 9; knots += 0.25) {
      if (!underWay(kt(knots))) continue;
      const tail = pathPoints(speedArrowPathData(kt(knots)))[0]!;
      const station = knots < 0 ? STATIONS.stern : STATIONS.bow;
      expect(magnitude(subtract(tail, station))).toBeCloseTo(HULL_GAP, METRES);
    }
  });

  it("stays on the centreline, so it never leans off to one side", () => {
    for (const knots of [-6, -3, -0.5, 0.5, 3, 6]) {
      const [station, tip] = pathPoints(speedArrowPathData(kt(knots)));
      expect(station!.x).toBeCloseTo(0, 6);
      expect(tip!.x).toBeCloseTo(0, 6);
    }
  });

  it("reaches equally far ahead and astern, because the pivot is amidships", () => {
    // Sternway is no longer the cramped case it was when the boat turned about
    // the mast — the arrow gets the same budget in both directions.
    for (const knots of [1, 3, 5.6, 8]) {
      expect(fromPivot(tipOf(kt(knots)))).toBeCloseTo(fromPivot(tipOf(kt(-knots))), 9);
    }
  });

  it("puts both barbs behind the tip, splayed either side of the shaft", () => {
    // The path runs station, tip, barb, tip, barb — the head is one stroke
    // through the tip rather than two, so the join rounds instead of forking.
    const [, tip, firstBarb, , secondBarb] = pathPoints(speedArrowPathData(kt(4)));
    // Behind, in the boat frame: nearer the transom than the tip is.
    expect(firstBarb!.y).toBeGreaterThan(tip!.y);
    expect(secondBarb!.y).toBeGreaterThan(tip!.y);
    // One either side of the centreline, evenly. Which barb is to port is not
    // worth asserting: the arrow is symmetric, so it carries no meaning.
    expect(firstBarb!.x).toBeCloseTo(-secondBarb!.x, 9);
    expect(Math.abs(firstBarb!.x)).toBeGreaterThan(0.1);
    // And they face the other way on sternway, or the head would be a tail.
    const sternway = pathPoints(speedArrowPathData(kt(-4)));
    expect(sternway[2]!.y).toBeLessThan(sternway[1]!.y);
    expect(sternway[4]!.y).toBeLessThan(sternway[1]!.y);
  });
});

describe("speed arrow head", () => {
  it("never outgrows half its own shaft, so a slow boat draws a small arrow", () => {
    for (let knots = 0.25; knots <= 9; knots += 0.25) {
      const speed = kt(knots);
      const [, tip, barb] = pathPoints(speedArrowPathData(speed));
      const spread = magnitude(subtract(barb!, tip!));
      expect(spread).toBeLessThanOrEqual(Math.min(ARROW_BARB, speedArrowLength(speed) / 2) + 1e-4);
    }
  });

  it("is full size everywhere the boat normally sails", () => {
    // The shrinking only bites below ~2.3 kt; above that the head is a constant
    // size in metres, which is what keeps the *length* the thing that encodes
    // speed rather than the whole shape scaling together.
    for (const knots of [3, 4, 5.6, 8]) {
      const [, tip, barb] = pathPoints(speedArrowPathData(kt(knots)));
      expect(magnitude(subtract(barb!, tip!))).toBeCloseTo(ARROW_BARB, 3);
    }
  });
});

describe("speed path data", () => {
  it("emits nothing a renderer would choke on, at any speed the model reaches", () => {
    for (let knots = -9; knots <= 9; knots += 0.1) {
      const data = speedArrowPathData(kt(knots));
      expect(data).not.toMatch(/NaN|Infinity|e[+-]/i);
      expect(data).not.toMatch(/(^|\s)-0(\s|$)/);
    }
  });

  it("exports a layer factory", () => {
    // The DOM half is exercised by hand in the browser, as `createHullLayer` and
    // `createSailLayer` are; the suite runs in node.
    expect(typeof createSpeedLayer).toBe("function");
  });
});
