/**
 * The two things every renderer in `render/` needs before it can draw anything:
 * a namespace-correct element factory, and a number formatter for attribute
 * values.
 *
 * It lives in its own module rather than in `scene.ts` so that the layer
 * modules (`hull.ts`, and later `sail.ts`, `wind.ts`, `speed.ts`) can use it
 * without importing the scene that composes them.
 */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** The SVG element tags this project creates, so a typo is a type error. */
interface SvgTagMap {
  svg: SVGSVGElement;
  g: SVGGElement;
  path: SVGPathElement;
  line: SVGLineElement;
  circle: SVGCircleElement;
  title: SVGTitleElement;
}

/**
 * Creates an SVG element with attributes.
 *
 * `document.createElement` would silently make an *HTML* element of the same
 * name, which renders as nothing at all and is a genuinely annoying bug to
 * spot, so nothing in `render/` should call it.
 *
 * Attribute values are numbers or strings; numbers go through
 * {@link formatNumber}. Note DESIGN.md §4.4's rule and its boundary: **colour**
 * never goes through an attribute, because `oklch()` in a presentation
 * attribute only parses in Safari. Geometry attributes — `d`, `transform`, `r`,
 * `vector-effect` — are fine here, and two of them are actively preferable to
 * their CSS equivalents.
 */
export function svgElement<K extends keyof SvgTagMap>(
  tag: K,
  attributes: Readonly<Record<string, string | number>> = {},
): SvgTagMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, tag) as SvgTagMap[K];
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, typeof value === "number" ? formatNumber(value) : value);
  }
  return element;
}

/** Decimal places kept in attribute values. Sub-tenth-of-a-millimetre on a boat. */
const ATTRIBUTE_PRECISION = 4;

/**
 * Formats a number for an SVG attribute: fixed precision, no trailing zeros, no
 * exponent, and no `-0`.
 *
 * The precision is not about accuracy — it is about churn. Path data and
 * transforms are rebuilt every frame once the simulation is running, and
 * without rounding, floating-point noise in the last few bits would rewrite
 * every attribute on every frame even when nothing moved.
 *
 * Exponent notation matters because SVG attribute grammar does accept it but
 * `toFixed` never emits it — worth stating, since the obvious "optimisation" of
 * dropping to `String(value)` would reintroduce `1e-7` into path data.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot format ${value} as an SVG attribute value.`);
  }
  const fixed = value.toFixed(ATTRIBUTE_PRECISION);
  // Strip trailing zeros, then a bare trailing point: "1.2000" → "1.2", "3.0000" → "3".
  const trimmed = fixed.replace(/\.?0+$/, "");
  // `(-0.00001).toFixed(4)` is "-0.0000", which trims to "-0". Harmless to SVG,
  // but it makes attribute values compare unequal to their positive twins.
  return trimmed === "-0" ? "0" : trimmed;
}
