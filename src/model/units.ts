/**
 * Angles, vectors, and unit conversions — the shared vocabulary every other
 * module speaks (DESIGN.md §2, "Conventions").
 *
 * The conventions, fixed once here so nothing downstream has to re-derive them:
 *
 * - **Angles are radians** internally; degrees only at the UI edge.
 * - **Zero is screen-up / north**, and **positive is clockwise**, which is both
 *   the compass convention and what SVG's y-down axis wants: a bearing θ points
 *   along `(sin θ, −cos θ)`.
 * - **Wind direction is stored as the direction the wind blows *from***, the way
 *   sailors say it. Use {@link oppositeAngle} to get the direction it blows to.
 * - **SI internally** (m, m/s, N, kg); knots and feet appear only at the edges.
 * - **Speed is signed**, positive forward.
 *
 * Sign errors in a sailing model are miserable to debug, so the named helpers
 * below are the only place raw trigonometry is allowed to live. `no-raw-trig.test.ts`
 * enforces that: `Math.sin` and friends outside this file fail the test suite.
 */

/** An angle in radians. Bearings are measured clockwise from screen-up. */
export type Radians = number;
/** An angle in degrees — UI edge only. */
export type Degrees = number;
export type Meters = number;
export type MetersPerSecond = number;
/** Speed in knots — display only. */
export type Knots = number;
export type Kilograms = number;
export type SquareMeters = number;
export type Newtons = number;

/** A full turn. Clearer than `2 * Math.PI` at every use site. */
export const TAU = 2 * Math.PI;

/**
 * A 2-D vector. Components are frame- and unit-agnostic — the caller decides
 * whether this is metres in the world frame, metres in the boat frame, or
 * newtons of sail force — but the axes are always the same: **+x to the right
 * (starboard/east), +y downward (aft/south)**, matching SVG.
 *
 * The boat frame is just the world frame rotated so that the heading reads
 * zero, so one vector type and one {@link rotateVector} serve both.
 */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const ZERO_VECTOR: Vec2 = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
// Raw trigonometry — the only place it is allowed
// ---------------------------------------------------------------------------

/** Sine of an angle. Wrapped so callers state their units in the type. */
export function sin(angle: Radians): number {
  return Math.sin(angle);
}

/** Cosine of an angle. */
export function cos(angle: Radians): number {
  return Math.cos(angle);
}

/** Tangent of an angle. */
export function tan(angle: Radians): number {
  return Math.tan(angle);
}

/**
 * How far outside [−1, 1] a ratio may stray before we call it a bug rather than
 * rounding. Normalising a vector and dotting it can overshoot 1 by an ulp or
 * two; nothing legitimate overshoots by 1e-6.
 */
const RATIO_TOLERANCE = 1e-6;

/**
 * Clamps a cosine/sine ratio into [−1, 1].
 *
 * Rounding-sized overshoot is silently absorbed, because that is exactly what
 * the clamp is for. A gross overshoot is a different animal — a unit mix-up or
 * an unnormalised vector upstream — and clamping it would return a confident,
 * plausible, wrong angle. In dev and test builds that throws instead; in the
 * production bundle the check is dropped and the clamp stands, since a student
 * mid-lesson is better served by a slightly wrong sail than a blank page.
 */
function clampRatio(ratio: number, caller: string): number {
  if (import.meta.env.DEV && !(Math.abs(ratio) <= 1 + RATIO_TOLERANCE)) {
    throw new Error(
      `${caller}() got ${ratio}, which is not a ratio — check for a unit mix-up or an unnormalised vector upstream.`,
    );
  }
  return Math.min(1, Math.max(-1, ratio));
}

/** Arcsine, returning an angle in [−π/2, π/2]. See {@link clampRatio} for out-of-range input. */
export function asin(ratio: number): Radians {
  return Math.asin(clampRatio(ratio, "asin"));
}

/** Arccosine, returning an angle in [0, π]. See {@link clampRatio} for out-of-range input. */
export function acos(ratio: number): Radians {
  return Math.acos(clampRatio(ratio, "acos"));
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Hermite smoothstep on [0, 1], clamped outside it.
 *
 * Not a unit conversion, but it lives here for the same reason the trigonometry
 * does: it is shared vocabulary, and two copies could drift apart. Every soft
 * threshold in the model is one of these — the stall blend in `foil.ts`, the
 * luff fraction in `sail.ts`, the colour ramp later on.
 *
 * Chosen over a linear ramp for the derivative, not the values. Its slope
 * vanishes at both ends, so a curve blended with it is C¹ at *both* junctions
 * rather than merely continuous. The trim-quality colour ramp downstream (§4.2)
 * reads driving-force gradients, so a crease anywhere upstream would show.
 *
 * The clamp is what lets callers skip the two-limb branch: feed it a raw
 * `(x − low) / (high − low)` and the ends take care of themselves.
 */
export function smoothstep(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Angle normalisation and comparison
// ---------------------------------------------------------------------------

/** Wraps an angle into [0, 2π) — the form to use when a compass bearing reads better. */
export function normalizeUnsigned(angle: Radians): Radians {
  const wrapped = angle % TAU;
  // `%` yields −0 for exact negative multiples of a turn, and −0 is not < 0.
  if (wrapped === 0) return 0;
  if (wrapped < 0) {
    // Adding TAU to a tiny negative can round up to exactly TAU, which is out
    // of range; fold that case to zero.
    const shifted = wrapped + TAU;
    return shifted >= TAU ? 0 : shifted;
  }
  return wrapped;
}

/**
 * Wraps an angle into (−π, π] — the form to use whenever the sign carries
 * meaning, which for this model is nearly everywhere: which tack, which side
 * the clew is on, which way to turn.
 *
 * The half-open interval means exactly −180° normalises to +180°. That is the
 * usual convention and it keeps the result single-valued.
 */
export function normalizeSigned(angle: Radians): Radians {
  // Already in range: return it untouched rather than losing a bit or two of
  // precision to the round trip below.
  if (angle > -Math.PI && angle <= Math.PI) return angle;
  const wrapped = normalizeUnsigned(angle);
  return wrapped > Math.PI ? wrapped - TAU : wrapped;
}

/**
 * The signed angle you turn through to get from `from` to `to`, in (−π, π].
 * Positive is clockwise. Correct across the 0/360 seam by construction.
 */
export function angleBetween(from: Radians, to: Radians): Radians {
  return normalizeSigned(to - from);
}

/** The angle 180° away — e.g. from "wind blows from" to "wind blows toward". */
export function oppositeAngle(angle: Radians): Radians {
  return normalizeSigned(angle + Math.PI);
}

/**
 * Converts a world bearing into the boat frame: the angle off the bow, in
 * (−π, π], positive to starboard. Zero is dead ahead, ±π dead astern.
 */
export function toBoatFrame(worldAngle: Radians, heading: Radians): Radians {
  return normalizeSigned(worldAngle - heading);
}

/** The inverse of {@link toBoatFrame}: an angle off the bow back to a world bearing. */
export function toWorldFrame(boatAngle: Radians, heading: Radians): Radians {
  return normalizeSigned(boatAngle + heading);
}

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

/** The unit vector pointing along a bearing: `(sin θ, −cos θ)`. */
export function unitVector(angle: Radians): Vec2 {
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}

/** A vector of the given length along a bearing. Negative lengths point backwards. */
export function vectorFromAngle(angle: Radians, length: number): Vec2 {
  return { x: Math.sin(angle) * length, y: -Math.cos(angle) * length };
}

/**
 * The bearing a vector points along, in (−π, π]. The zero vector has no
 * direction, so it reports zero rather than throwing — callers that care should
 * check {@link magnitude} first.
 */
export function angleOfVector(v: Vec2): Radians {
  if (v.x === 0 && v.y === 0) return 0;
  // `atan2` can hand back exactly −π (dead astern reached from the port side,
  // or via a signed zero); normalising folds that onto +π so the result really
  // does live in (−π, π].
  return normalizeSigned(Math.atan2(v.x, -v.y));
}

export function magnitude(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vec2, factor: number): Vec2 {
  return { x: v.x * factor, y: v.y * factor };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * Rotates a vector clockwise by the given angle. Rotating a boat-frame vector
 * by the heading puts it in the world frame; rotating by `−heading` brings it
 * back.
 */
export function rotateVector(v: Vec2, angle: Radians): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** The vector turned 90° clockwise — e.g. lift, which acts across the apparent wind. */
export function perpendicular(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

/** How much of `v` acts along the given bearing. Negative means it acts against it. */
export function componentAlong(v: Vec2, angle: Radians): number {
  return dot(v, unitVector(angle));
}

/** How much of `v` acts 90° clockwise of the given bearing. */
export function componentAcross(v: Vec2, angle: Radians): number {
  return dot(v, unitVector(angle + Math.PI / 2));
}

// ---------------------------------------------------------------------------
// Conversions — the edges of the model
// ---------------------------------------------------------------------------

const METERS_PER_FOOT = 0.3048;
const METERS_PER_SECOND_PER_KNOT = 1852 / 3600;
const KILOGRAMS_PER_POUND = 0.45359237;

export function degreesToRadians(degrees: Degrees): Radians {
  return (degrees * Math.PI) / 180;
}

export function radiansToDegrees(radians: Radians): Degrees {
  return (radians * 180) / Math.PI;
}

export function knotsToMetersPerSecond(knots: Knots): MetersPerSecond {
  return knots * METERS_PER_SECOND_PER_KNOT;
}

export function metersPerSecondToKnots(speed: MetersPerSecond): Knots {
  return speed / METERS_PER_SECOND_PER_KNOT;
}

export function feetToMeters(feet: number): Meters {
  return feet * METERS_PER_FOOT;
}

export function metersToFeet(meters: Meters): number {
  return meters / METERS_PER_FOOT;
}

export function poundsToKilograms(pounds: number): Kilograms {
  return pounds * KILOGRAMS_PER_POUND;
}

export function squareFeetToSquareMeters(squareFeet: number): SquareMeters {
  return squareFeet * METERS_PER_FOOT * METERS_PER_FOOT;
}
