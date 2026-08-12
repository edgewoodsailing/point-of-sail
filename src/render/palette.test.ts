import { describe, expect, it } from "vitest";

import {
  formatOklch,
  oklchToLinearSrgb,
  SAIL_INK_PROPERTY,
  setSailInk,
  trimQualityColor,
  trimQualityStop,
  type LinearSrgb,
  type Oklch,
} from "./palette.ts";
import { formatNumber } from "./svg.ts";

/** Samples across the ramp. Fine enough to catch a flat spot or a reversal. */
const SAMPLES = 200;

/**
 * §4.4's five anchors, restated here rather than imported.
 *
 * The module keeps them private, which is right — they are not a knob — but a
 * test that read them back out of the module could only prove the module agrees
 * with itself. Copied from the design document, they pin the ramp to the thing
 * that was actually designed.
 */
const AUTHORED: readonly Oklch[] = [
  { lightness: 0.52, chroma: 0.19, hue: 30 },
  { lightness: 0.62, chroma: 0.16, hue: 52 },
  { lightness: 0.72, chroma: 0.13, hue: 75 },
  { lightness: 0.8, chroma: 0.14, hue: 110 },
  { lightness: 0.86, chroma: 0.16, hue: 145 },
];

/** §4.4's sRGB reference column — documentation there, the check on the matrices here. */
const REFERENCE_HEX = ["#be2517", "#ce6400", "#d49838", "#c3c54f", "#89ec8d"];

describe("the trim-quality ramp (DESIGN.md §4.4)", () => {
  it("lands on the authored anchors at the documented qualities", () => {
    expect(trimQualityColor(0)).toBe("oklch(52% 0.19 30deg)");
    // The one anchor authored outside sRGB, so the only one the clamp moves:
    // 0.16 of chroma comes back as 0.1594. See the gamut block below.
    expect(trimQualityColor(0.25)).toBe("oklch(62% 0.1594 52deg)");
    expect(trimQualityColor(0.5)).toBe("oklch(72% 0.13 75deg)");
    expect(trimQualityColor(0.75)).toBe("oklch(80% 0.14 110deg)");
    expect(trimQualityColor(1)).toBe("oklch(86% 0.16 145deg)");
  });

  it("converts the way §4.4's sRGB column says it does", () => {
    // The column is "reference only" in the design document. Here it is the
    // independent number that catches a transposed row in either matrix — a
    // mistake that otherwise produces a plausible wrong colour, not a failure.
    expect(AUTHORED.map((color) => encodeHex(oklchToLinearSrgb(color)))).toEqual(REFERENCE_HEX);
  });

  it("rises in lightness the whole way, so the ramp reads as a progression", () => {
    const lightness = sweep().map((color) => color.lightness);
    for (let i = 1; i < lightness.length; i += 1) {
      expect(lightness[i]!).toBeGreaterThan(lightness[i - 1]!);
    }
  });

  it("has no crease at an interior anchor, which is what smoothstep bought", () => {
    // A straight lerp between five stops jumps in rate at each interior anchor,
    // and a rate jump in a "am I getting warmer?" ramp reads as a threshold
    // that is not there. Easing makes the slope vanish at every anchor instead.
    for (const quality of [0.25, 0.5, 0.75]) {
      const atAnchor = lightnessSlope(quality);
      const midSegment = lightnessSlope(quality - 0.125);
      expect(midSegment).toBeGreaterThan(0.1);
      expect(atAnchor).toBeLessThan(midSegment * 0.05);
    }
  });

  it("moves monotonically towards green, never doubling back on hue or lightness", () => {
    const hues = sweep().map((color) => color.hue);
    expect(hues[0]).toBeCloseTo(30, 6);
    expect(hues.at(-1)).toBeCloseTo(145, 6);
    for (let i = 1; i < hues.length; i += 1) {
      expect(hues[i]!).toBeGreaterThanOrEqual(hues[i - 1]!);
    }
  });
});

describe("the gamut clamp (the check stylelint cannot make here)", () => {
  it("emits nothing sRGB cannot show", () => {
    // `gamut/color-no-out-gamut-range` guards every colour in `scene.css`, and
    // `npm run lint` never looks at a colour this module computes. This is that
    // rule, applied to the generated output.
    for (const color of sweep()) {
      const { red, green, blue } = oklchToLinearSrgb(color);
      for (const channel of [red, green, blue]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it("leaves an in-gamut colour exactly alone", () => {
    // Four of the five anchors are inside, and a clamp that quietly nudged them
    // would be moving the design document's colours without saying so.
    expect(trimQualityStop(0).chroma).toBe(0.19);
    expect(trimQualityStop(0.5).chroma).toBe(0.13);
    expect(trimQualityStop(1).chroma).toBe(0.16);
  });

  it("has real work to do — the quality-¼ anchor is authored outside sRGB", () => {
    // Stated as a property of the *authored* colour, so this test fails if
    // someone later moves that anchor inside and leaves the clamp unexercised.
    expect(oklchToLinearSrgb(AUTHORED[1]!).blue).toBeLessThan(0);
    // How far outside, pinned rather than left to a comment. `palette.ts` quotes
    // this margin twice — once to say which anchor the clamp moves, once as the
    // distance CHANNEL_TOLERANCE is chosen against — and both said 7e-3 until
    // this was measured. A figure that only lives in prose drifts silently.
    expect(oklchToLinearSrgb(AUTHORED[1]!).blue).toBeCloseTo(-5.72e-4, 6);
    expect(trimQualityStop(0.25).chroma).toBeLessThan(AUTHORED[1]!.chroma);
    // Lightness and hue are what OKLCH lets us hold while chroma gives.
    expect(trimQualityStop(0.25).lightness).toBeCloseTo(0.62, 9);
    expect(trimQualityStop(0.25).hue).toBeCloseTo(52, 9);
  });

  it("clamps to the precision it prints at, so the string is what was checked", () => {
    // A chroma of 0.15937 checked in gamut and printed as `0.1594` would ship a
    // different, possibly out-of-gamut colour. The module's EMITTED_STEP has to
    // match `formatNumber`'s precision; this is the pin between the two.
    expect(formatNumber(1e-4)).toBe("0.0001");
    expect(formatNumber(1e-5)).toBe("0");
    for (const color of sweep()) {
      expect(formatOklch(color)).toBe(formatOklch(roundTrip(color)));
    }
  });
});

describe("the emitted string (the §4.4 rule this module exists to make structural)", () => {
  it("is an oklch() colour and nothing else, at every quality", () => {
    const shape = /^oklch\(\d+(\.\d+)?% \d+(\.\d+)? \d+(\.\d+)?deg\)$/;
    for (let i = 0; i <= SAMPLES; i += 1) {
      expect(trimQualityColor(i / SAMPLES)).toMatch(shape);
    }
  });

  it("never emits hex, rgb(), hsl(), or anything a colour parser would choke on", () => {
    // The three `.stylelintrc.json` rules that stop at the CSS door, applied to
    // the generated colour. Exponent notation is the live risk: CSS accepts no
    // such number, and `String(1e-7)` produces one from ordinary residue.
    for (let i = 0; i <= SAMPLES; i += 1) {
      const color = trimQualityColor(i / SAMPLES);
      expect(color).not.toMatch(/#|rgba?\(|hsla?\(/i);
      expect(color).not.toMatch(/NaN|Infinity|e[+-]/i);
      expect(color).not.toMatch(/(^|[\s(])-0/);
    }
  });

  it("is deterministic, so an unchanged sail rewrites no property", () => {
    expect(trimQualityColor(0.3125)).toBe(trimQualityColor(0.3125));
  });

  it("names the custom property `scene.css` actually reads", () => {
    // `.pos-sailcloth` is painted `stroke: var(--pos-sail-ink, var(--pos-ink))`.
    // Get this name wrong and nothing breaks loudly — the sail just stays ink.
    expect(SAIL_INK_PROPERTY).toBe("--pos-sail-ink");
    // The one structural check on the DOM half that does not need a DOM. That
    // the property resolves in every engine is a browser check, and it is the
    // whole reason §4.4 bans presentation attributes.
    expect(typeof setSailInk).toBe("function");
  });
});

describe("quality at and past its ends", () => {
  it("folds an overshoot onto the ends of the ramp rather than extrapolating", () => {
    // Above 1 because the optimum in the denominator comes from a sampled
    // search and a trim between samples can beat it; below 0 because driving
    // force goes negative in irons.
    expect(trimQualityColor(1.4)).toBe(trimQualityColor(1));
    expect(trimQualityColor(-0.3)).toBe(trimQualityColor(0));
  });

  it("refuses a zero denominator in dev, the way units.ts refuses a bad ratio", () => {
    expect(() => trimQualityColor(Number.NaN)).toThrow(/zero denominator/);
  });
});

describe("colour-vision deficiency (the §4.4 acceptance criterion)", () => {
  /*
   * What this block establishes, and what it deliberately does not.
   *
   * §4.4 argues the ramp survives red-green deficiency on the blue-yellow axis
   * and quotes simulated blue channels of 34 → 58 → 102 → 177 → 215 under both
   * deuteranopia and protanopia. **Those numbers do not reproduce.** Measured
   * here with Machado 2009 at severity 1.0 — and Viénot 1999 agrees on the
   * shape — the anchors give:
   *
   *   deuteranopia  10 →   0 →  59 →  86 → 147
   *   protanopia    18 →   0 →  43 →  65 → 134
   *   tritanopia    36 →  85 → 132 → 172 → 213
   *
   * Neither red-green case is monotonic, and the reason is structural rather
   * than a matter of which simulation one picks: the quality-¼ anchor sits on
   * the sRGB boundary with a blue channel of exactly 0, while the red anchor
   * has 23. Every dichromat model preserves the S-cone signal, so no honest
   * simulation can make that amber bluer than that red. (Only tritanopia's blue
   * is monotonic, which is the case §4.4's blue-yellow argument does *not*
   * cover.)
   *
   * What does hold, and what is asserted below, is the property §4.4 explicitly
   * disclaims: **simulated lightness**. Its own anchors run L 52 → 62 → 72 → 80
   * → 86, and the simulated relative luminance of the ramp rises without a
   * single reversal for all three deficiency types across the whole sweep. That
   * is what a student who cannot name these colours actually reads, so it is
   * what the ramp has to guarantee, and it is a stronger claim than the one
   * asked for because it covers tritanopia too.
   *
   * Reconciling §4.4's prose with these numbers — or retuning the amber anchor
   * until the blue claim becomes true — is pos-kxg. Do not "fix" the ramp here
   * to make a test pass.
   */

  const DEFICIENCIES = ["protanopia", "deuteranopia", "tritanopia"] as const;

  it.each(DEFICIENCIES)("stays ordered under %s, with no reversal anywhere", (deficiency) => {
    const luminance = sweep().map((color) => simulatedLuminance(color, deficiency));
    for (let i = 1; i < luminance.length; i += 1) {
      expect(luminance[i]!).toBeGreaterThan(luminance[i - 1]!);
    }
  });

  it.each(DEFICIENCIES)("keeps every quarter of the ramp legible under %s", (deficiency) => {
    // Monotonicity alone would be satisfied by a ramp that did all its work in
    // one quarter and crawled through the other three. The measured minimum is
    // 0.082 (tritanopia, the first quarter); the floor here leaves room to
    // adjust an anchor without leaving room to flatten a quarter.
    const quarter = SAMPLES / 4;
    const luminance = sweep().map((color) => simulatedLuminance(color, deficiency));
    for (let i = 0; i < 4; i += 1) {
      const rise = luminance[(i + 1) * quarter]! - luminance[i * quarter]!;
      expect(rise).toBeGreaterThan(0.05);
    }
  });
});

// --- helpers ----------------------------------------------------------------

function sweep(): Oklch[] {
  return Array.from({ length: SAMPLES + 1 }, (_, i) => trimQualityStop(i / SAMPLES));
}

/** Central-difference slope of lightness against quality. */
function lightnessSlope(quality: number): number {
  const h = 1 / (2 * SAMPLES);
  const rise = trimQualityStop(quality + h).lightness - trimQualityStop(quality - h).lightness;
  return Math.abs(rise) / (2 * h);
}

/** A colour put through the string and read back, to prove the two agree. */
function roundTrip(color: Oklch): Oklch {
  const [lightness, chroma, hue] = formatOklch(color)
    .match(/-?\d+(\.\d+)?/g)!
    .map(Number) as [number, number, number];
  return { lightness: lightness / 100, chroma, hue };
}

/** The sRGB transfer function, and 8-bit hex. Only the test needs the encoded form. */
function encodeHex(rgb: LinearSrgb): string {
  const channel = (value: number): string => {
    const clipped = Math.min(1, Math.max(0, value));
    const encoded = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(rgb.red)}${channel(rgb.green)}${channel(rgb.blue)}`;
}

/**
 * Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear light.
 *
 * Chosen over Viénot 1999 because it is the model the accessibility tools a
 * teacher is likely to reach for use, and the two agree on everything this
 * block asserts. The matrices are transcribed from the published tables.
 */
const CVD_MATRICES = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const;

/** CIE relative luminance of a colour as the named deficiency sees it. */
function simulatedLuminance(color: Oklch, deficiency: keyof typeof CVD_MATRICES): number {
  const { red, green, blue } = oklchToLinearSrgb(color);
  const source = [red, green, blue];
  const [r, g, b] = CVD_MATRICES[deficiency].map((row) =>
    Math.min(1, Math.max(0, row[0]! * source[0]! + row[1]! * source[1]! + row[2]! * source[2]!)),
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
