/**
 * The traffic light: a trim quality in `0..1` to a CSS colour (DESIGN.md §4.2,
 * §4.4).
 *
 * Green at optimal trim, deteriorating through amber to red in *both*
 * directions — §4.2 owns why the scale is driving-force ratio rather than
 * angular error, and `pos-dmg.1` owns computing it. This module owns only the
 * last step: five authored OKLCH stops, interpolated, clamped to gamut, and
 * handed to the CSS parser.
 *
 * Four constraints between them fix everything about the shape of this file,
 * and none of them is a preference:
 *
 * **Colour is a string, and it goes through CSS.** `oklch()` in an SVG
 * presentation attribute — `fill="oklch(…)"` — parses only in Safari (§4.4). A
 * school iPad *is* Safari, so that mistake would survive testing here and break
 * on a student's Android phone. `scene.css` already cut the seam this writes
 * to: the sailcloth is painted `stroke: var(--pos-sail-ink, var(--pos-ink))`,
 * and a custom property runs the CSS parser on any engine. So the output of
 * this module is a finished colour *string* fit for `setProperty` — not a
 * struct, not separate channels — and {@link setSailInk} is the only route it
 * offers to the DOM, which makes §4.4's rule structural rather than something
 * to remember.
 *
 * **The interpolation is arithmetic, here, in TypeScript.** `vite.config.ts`
 * pins safari15.4 / chrome111 / firefox113, which is exactly where `oklch()`
 * shipped in each engine. `color-mix()` lands at Safari 16.2 and relative
 * colour syntax higher still, so both are above the floor. Handing the browser
 * two stops and asking it to mix is not available to us; we mix and hand it the
 * answer.
 *
 * **The mixing happens in OKLCH, which is the point of authoring there.**
 * Interpolating the same endpoints through sRGB puts a muddy desaturated sag in
 * the middle of the ramp, exactly where "getting warmer" has to read clearly.
 *
 * **Nothing lints this module's output.** `npm run lint` points stylelint —
 * `gamut/color-no-out-gamut-range`, `color-no-hex`, the ban on `rgb()`/`hsl()`
 * — at the CSS files and nothing else. A colour computed at runtime passes
 * through none of it. That is why the gamut clamp is code rather than a lint
 * rule, and why `palette.test.ts` and `no-color-attributes.test.ts` assert by
 * hand what the CSS files get for free.
 *
 * **The anchors live here, not in `model/tuning.ts`.** §6 lists them under that
 * file, but its very next paragraph is the one that governs: "Drawing decisions
 * … stay beside the code that draws with them. A render module reaching into
 * model tuning for a curve handle would blur the very line `tuning.ts` exists
 * to draw." `render/sail.ts` settled the same question the same way for the
 * camber constants. A ramp of colours is drawing taste, and `tuning.ts`'s remit
 * is the model.
 */

import type { Degrees } from "../model/units.ts";
import { cos, degreesToRadians, sin, smoothstep } from "../model/units.ts";
import { formatNumber } from "./svg.ts";

// --- The validated ramp -----------------------------------------------------

/** A colour in OKLCH, the space §4.4 authors in. */
export interface Oklch {
  /** Perceptual lightness, `0..1`. Emitted as a percentage. */
  readonly lightness: number;
  /** Chroma. Not normalised — sRGB runs out somewhere around 0.2–0.3. */
  readonly chroma: number;
  /** Hue angle in degrees. Not a bearing: this is the OKLCH convention, not §2's. */
  readonly hue: Degrees;
}

/**
 * §4.4's five anchor stops, worst trim to best, at quality 0, ¼, ½, ¾ and 1.
 *
 * These were designed and then checked under colour-vision-deficiency
 * simulation rather than assumed — roughly 8% of boys have some red-green
 * deficiency, and this ramp is the simulator's main teaching signal, so it has
 * to carry its meaning for them too. `palette.test.ts` re-runs that check on
 * every commit, and its docblock is the place to read what the check actually
 * establishes before moving any number here.
 *
 * The stop at quality ¼ is authored a little *outside* sRGB — its blue channel
 * comes out at −5.7e-4 — so it is the one anchor {@link clampToGamut} visibly
 * moves. Left as authored rather than pre-clamped, because the clamp's job is
 * to be the single place a gamut decision is made.
 */
const TRIM_QUALITY_RAMP: readonly Oklch[] = [
  { lightness: 0.52, chroma: 0.19, hue: 30 },
  { lightness: 0.62, chroma: 0.16, hue: 52 },
  { lightness: 0.72, chroma: 0.13, hue: 75 },
  { lightness: 0.8, chroma: 0.14, hue: 110 },
  { lightness: 0.86, chroma: 0.16, hue: 145 },
];

// --- OKLCH to linear sRGB ---------------------------------------------------

/**
 * Linear-light sRGB, before the transfer function. In gamut means every channel
 * lands in `[0, 1]`.
 *
 * Linear rather than encoded because that is where the gamut test is honest and
 * where the conversion naturally stops. Nothing here needs the encoded form —
 * we emit OKLCH and let the browser finish the journey.
 */
export interface LinearSrgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/**
 * OKLCH → linear sRGB, by way of OKLab and Björn Ottosson's LMS' cone space.
 *
 * The two matrices are his published ones and are transcribed, not derived, so
 * `palette.test.ts` pins them against §4.4's sRGB reference column — an
 * independent number, from the design document rather than from reading this
 * code back to itself. A transposed row here would otherwise show up as a
 * plausible wrong colour rather than as a failure.
 */
export function oklchToLinearSrgb(color: Oklch): LinearSrgb {
  const hue = degreesToRadians(color.hue);
  const a = color.chroma * cos(hue);
  const b = color.chroma * sin(hue);

  // OKLab → LMS', which is a cube root away from cone response.
  const long = (color.lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (color.lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (color.lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    red: 4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    green: -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    blue: -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  };
}

/**
 * How far outside `[0, 1]` a channel may stray before the colour counts as out
 * of gamut. Nothing legitimate misses by more than rounding; the anchor that
 * really is outside misses by 5.7e-4, five orders of magnitude clear of this.
 * `palette.test.ts` pins that figure, because it is the margin this tolerance
 * is chosen against and a comment is a poor place to keep a measurement.
 */
const CHANNEL_TOLERANCE = 1e-9;

function inSrgbGamut({ red, green, blue }: LinearSrgb): boolean {
  return [red, green, blue].every(
    (channel) => channel >= -CHANNEL_TOLERANCE && channel <= 1 + CHANNEL_TOLERANCE,
  );
}

/**
 * Bisection steps for the chroma search. Twenty halvings take the widest gap a
 * ramp stop could open — under 0.2 of chroma — to 2e-7, which is three orders
 * of magnitude finer than {@link EMITTED_STEP} rounds to anyway.
 */
const GAMUT_SEARCH_STEPS = 20;

/**
 * The smallest difference {@link formatNumber} can print. Must match the
 * precision in `svg.ts`; `palette.test.ts` pins the two together rather than
 * trusting the comment.
 */
const EMITTED_STEP = 1e-4;

/** Rounds down to a whole number of emitted steps. Only ever *reduces* chroma. */
function floorToStep(value: number): number {
  return Math.floor(value / EMITTED_STEP) * EMITTED_STEP;
}

/** Rounds a component to what {@link formatNumber} will print, via that function. */
function asEmitted(value: number): number {
  return Number(formatNumber(value));
}

/**
 * The nearest colour to this one that sRGB can actually show, reached by
 * lowering chroma and holding lightness and hue.
 *
 * Holding lightness is the whole reason §4.4 authors in OKLCH: a naive clip of
 * the three channels darkens or lightens as a side effect, and this ramp is
 * read as a progression, so a stop that shifts in lightness for a reason
 * unrelated to trim quality is a lie about the trim. Chroma is the axis that
 * can afford to give.
 *
 * **The result is quantised to what will be emitted, not to full precision.**
 * The string is the product of this module, and a chroma of 0.15937 printed as
 * `0.1594` would be a *different*, possibly out-of-gamut colour from the one
 * checked here. Rounding first — and flooring rather than rounding the clamped
 * chroma, since only downward is safe — means the colour that was verified is
 * the colour that ships.
 *
 * Bisection is sound because the gamut is star-shaped about the achromatic
 * axis: at fixed lightness and hue, once a chroma is inside, every smaller one
 * is too. That is the same assumption CSS Color 4's gamut mapping makes.
 */
function clampToGamut(color: Oklch): Oklch {
  const emitted: Oklch = {
    lightness: asEmitted(color.lightness * 100) / 100,
    chroma: floorToStep(color.chroma),
    hue: asEmitted(color.hue),
  };
  if (inSrgbGamut(oklchToLinearSrgb(emitted))) return emitted;

  let inside = 0;
  let outside = emitted.chroma;
  for (let step = 0; step < GAMUT_SEARCH_STEPS; step += 1) {
    const chroma = (inside + outside) / 2;
    if (inSrgbGamut(oklchToLinearSrgb({ ...emitted, chroma }))) inside = chroma;
    else outside = chroma;
  }
  return { ...emitted, chroma: floorToStep(inside) };
}

// --- The traffic light ------------------------------------------------------

/**
 * The colour at a trim quality, interpolated between the two anchors it falls
 * between and clamped to gamut.
 *
 * **Eased with `smoothstep` rather than mixed linearly.** Straight lerp between
 * five stops is continuous but creased: the rate of colour change jumps at each
 * interior anchor, and a crease in a ramp whose whole job is "am I getting
 * warmer?" reads as a threshold that is not there. Easing the segment parameter
 * makes the ramp C¹ throughout, which is exactly the argument `units.ts` makes
 * where `smoothstep` lives — that docblock already names this ramp as one of
 * its callers.
 *
 * Hue is mixed as a plain number, with no shortest-path wrapping. The stops run
 * 30 → 52 → 75 → 110 → 145, monotonic and spanning well under half a turn, so
 * wrapping would be machinery with nothing to do. A future stop that crossed 0°
 * would need it — and would need the interpolation reconsidered anyway, since
 * §4.4's ramp is a hue sweep by design.
 */
export function trimQualityStop(quality: number): Oklch {
  const position = clampQuality(quality) * (TRIM_QUALITY_RAMP.length - 1);
  const index = Math.min(Math.floor(position), TRIM_QUALITY_RAMP.length - 2);
  const from = TRIM_QUALITY_RAMP[index]!;
  const to = TRIM_QUALITY_RAMP[index + 1]!;
  const t = smoothstep(position - index);

  return clampToGamut({
    lightness: mix(from.lightness, to.lightness, t),
    chroma: mix(from.chroma, to.chroma, t),
    hue: mix(from.hue, to.hue, t),
  });
}

/** The colour at a trim quality, as a CSS string fit for a custom property. */
export function trimQualityColor(quality: number): string {
  return formatOklch(trimQualityStop(quality));
}

/**
 * A colour as CSS writes it: `oklch(72% 0.13 75deg)`.
 *
 * The authored form from §4.4 and `scene.css` — percentage lightness, `deg` on
 * the hue — so that a computed colour and a hand-written one read the same in
 * devtools. `formatNumber` is `svg.ts`'s, reused for the same two reasons it
 * exists there: it never emits exponent notation, which no CSS colour parser
 * accepts, and it rounds away the floating-point residue that would otherwise
 * rewrite this property on every frame when nothing had changed.
 */
export function formatOklch(color: Oklch): string {
  const lightness = formatNumber(color.lightness * 100);
  return `oklch(${lightness}% ${formatNumber(color.chroma)} ${formatNumber(color.hue)}deg)`;
}

// --- The one route to the DOM -----------------------------------------------

/**
 * The custom property `scene.css` paints the sailcloth with, through
 * `stroke: var(--pos-sail-ink, var(--pos-ink))`. The fallback is why nothing
 * breaks until this is set.
 */
export const SAIL_INK_PROPERTY = "--pos-sail-ink";

/**
 * Paints a sail's group with its trim quality.
 *
 * The property inherits down to the `.pos-sailcloth` path inside the group, so
 * the caller sets it once per sail rather than reaching for the path. Setting
 * it on the group is also what lets a later bead colour something else in the
 * same sail — a telltale, a clew handle — from the same value.
 *
 * This is deliberately the *only* thing in `render/` that hands a colour to the
 * DOM, and it hands it to `style.setProperty`. There is no overload that takes
 * an attribute name, which is what makes §4.4's rule impossible to break by
 * accident rather than merely documented.
 */
export function setSailInk(group: SVGElement, quality: number): void {
  group.style.setProperty(SAIL_INK_PROPERTY, trimQualityColor(quality));
}

// --- helpers ----------------------------------------------------------------

function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Folds a quality onto `0..1`.
 *
 * Both ends genuinely overshoot in normal use. Above 1, because the optimum in
 * the denominator comes from a sampled search (`model/sail.ts`) and a trim
 * between two samples can beat it by a hair — measured at 7e-5 over the points
 * of sail. Below 0, because driving force goes negative in irons and with a
 * backed sail. Both mean "as bad as the ramp goes" or "as good as it goes", so
 * the clamp is the answer rather than an error.
 *
 * A *non-finite* quality is different: it is `0/0` from a zero denominator, so
 * it is a bug upstream, and it throws in dev and test builds the way
 * `units.ts`'s `clampRatio` does. In the production bundle the check is dropped
 * and it paints red, because a student mid-lesson is better served by a wrongly
 * red sail than by a page that has stopped.
 *
 * **It is unreachable from the one caller there is, and that is the point of
 * keeping it.** `render/sail.ts`'s `trimQuality` settled what §4.2 does with a
 * vanishing optimum (pos-dmg.1): it floors the denominator at a drive
 * coefficient, and returns 0 outright in a flat calm, where the floor itself
 * would be zero. So the denominator it divides by is positive whenever there
 * is any wind at all, and zero never reaches here. This throw guards the
 * *next* caller — pos-dmg.3's speed-arrow ratio divides by a ghost-boat speed
 * that is zero in exactly the same circumstances — rather than the current one.
 */
function clampQuality(quality: number): number {
  if (import.meta.env.DEV && !Number.isFinite(quality)) {
    throw new Error(
      `trimQuality got ${quality} — the driving-force ratio has a zero denominator upstream.`,
    );
  }
  if (!Number.isFinite(quality)) return 0;
  return Math.min(1, Math.max(0, quality));
}
