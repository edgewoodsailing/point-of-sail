/**
 * A prototyping overlay that draws the scene's **invisible geometry**: every
 * radius `render/scene.ts` reserves and every region `input/gestures.ts` can
 * claim, painted as pale fills so the apportionment of the drawing surface can
 * be looked at rather than derived from docblocks.
 *
 * Not a shipping layer. It exists so design conversations about how much of the
 * surface each thing owns can happen in front of the thing itself. Every number
 * it draws is read live from the modules that own it — `SCENE`, `touchScale`,
 * `ARROW_REACH`, `mainClewPosition` — so the overlay cannot describe a scene
 * that is not the one running.
 *
 * Three kinds of mark, and the distinction is the point:
 *
 * - **Filled regions** are things a pointer can claim. The wind's annulus, the
 *   hull silhouette, the two clew discs, the rotation dead zone.
 * - **The amber annulus is claimed by nothing** — the open water between the
 *   furthest a clew grab reaches and the inner edge of the wind band. §5 argues
 *   that gap should exist; this is how wide it actually is.
 * - **Dashed circles are reservations**, not targets: `contentRadius`,
 *   `windRingRadius`, `shortRadius`.
 */

import { jibClewPosition, mainClewPosition, SWING_LIMIT } from "../model/boat.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, Vec2 } from "../model/units.ts";
import { vectorFromAngle } from "../model/units.ts";
import { RADIAL, touchScale } from "../input/gestures.ts";
import { jibChord } from "../model/sail.ts";
import { apparentWind } from "../model/wind.ts";
import { hullPathData } from "./hull.ts";
import { boatTransform, SCENE } from "./scene.ts";
import { formatNumber, svgElement } from "./svg.ts";
import { radiusForWind, WIND_CONTROL } from "./wind.ts";
import "./geometry.css";

/** Samples along a clew's travel arc. Smooth enough at the sizes in play. */
const ARC_SAMPLES = 48;

/** Draws an annulus as a fat stroke, so one element carries inner and outer. */
function setAnnulus(circle: SVGCircleElement, inner: Meters, outer: Meters): void {
  circle.setAttribute("r", formatNumber((inner + outer) / 2));
  // In user units, deliberately: this is a region of the *drawing*, so it scales
  // with the boat rather than with the viewport. No `non-scaling-stroke` here.
  circle.setAttribute("stroke-width", formatNumber(Math.max(outer - inner, 0)));
}

function place(circle: SVGCircleElement, at: Vec2, radius: Meters): void {
  circle.setAttribute("cx", formatNumber(at.x));
  circle.setAttribute("cy", formatNumber(at.y));
  circle.setAttribute("r", formatNumber(radius));
}

/** The path a clew sweeps across its legal travel, as a polyline. */
function travelPathData(clew: (angle: number) => Vec2): string {
  const points: string[] = [];
  for (let i = 0; i <= ARC_SAMPLES; i += 1) {
    const angle = -SWING_LIMIT + (2 * SWING_LIMIT * i) / ARC_SAMPLES;
    const at = clew(angle);
    points.push(`${formatNumber(at.x)} ${formatNumber(at.y)}`);
  }
  return `M ${points.join(" L ")}`;
}

/** A radial spoke from the origin, for the ruler that labels the bands. */
function spokePathData(from: Meters, to: Meters, bearing: number): string {
  const a = vectorFromAngle(bearing, from);
  const b = vectorFromAngle(bearing, to);
  return `M ${formatNumber(a.x)} ${formatNumber(a.y)} L ${formatNumber(b.x)} ${formatNumber(b.y)}`;
}

/**
 * Display sizes worth comparing, in CSS pixels.
 *
 * The point of the list is that §5's arithmetic changes character across it: the
 * pixel-sized targets (clew disc, wind band, dead zone) hold their pixel size and
 * therefore grow in *metres* as the display shrinks, until they start colliding
 * with things stated in metres. A phone is where that binds and a classroom TV is
 * where it goes slack, and the two look nothing alike.
 */
const DEVICES: readonly { readonly label: string; readonly size: [number, number] | null }[] = [
  { label: "Fill window", size: null },
  { label: "Phone 390×844", size: [390, 844] },
  { label: "Phone landscape", size: [844, 390] },
  { label: "Small phone 320×568", size: [320, 568] },
  { label: "iPad 820×1180", size: [820, 1180] },
  { label: "iPad landscape", size: [1180, 820] },
  { label: "Classroom TV 1920×1080", size: [1920, 1080] },
];

/**
 * A size picker for the shell, so a phone and an iPad can be compared without
 * resizing the browser — which cannot reach a 390 px viewport anyway.
 *
 * Sets the size on the simulator root and centres it in the page; the scene's
 * own `ResizeObserver` does the rest, so nothing here knows anything about the
 * drawing.
 */
export function createDevicePicker(root: HTMLElement): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "pos-geo-device";

  const caption = document.createElement("span");
  caption.textContent = "Display";

  const select = document.createElement("select");
  for (const [index, device] of DEVICES.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = device.label;
    select.append(option);
  }

  select.addEventListener("change", () => {
    const device = DEVICES[Number(select.value)];
    const page = document.body;
    if (device.size === null) {
      root.style.width = "";
      root.style.height = "";
      root.style.outline = "";
      page.style.display = "";
      page.style.alignItems = "";
      page.style.justifyContent = "";
      return;
    }
    const [width, height] = device.size;
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
    // A hairline so the simulated display's edge is visible against the page —
    // outline rather than border, so it costs no layout.
    root.style.outline = "1px solid oklch(45% 0.04 250deg / 40%)";
    page.style.display = "flex";
    page.style.alignItems = "center";
    page.style.justifyContent = "center";
  });

  wrapper.append(caption, select);
  return wrapper;
}

/**
 * The two knobs on the wind-as-a-radial-control prototype that cannot be settled
 * by argument: how a radial drag references itself, and how far the display
 * layer gets out of the boat's way.
 */
export function createWindKnobs(root: HTMLElement): HTMLElement {
  const strip = document.createElement("div");
  strip.className = "pos-geo-knobs";

  const mode = document.createElement("label");
  const modeCaption = document.createElement("span");
  modeCaption.textContent = "Radial";
  const modeSelect = document.createElement("select");
  for (const [value, label] of [
    ["relative", "relative (drag from where it was)"],
    ["absolute", "absolute (tail snaps to finger)"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    modeSelect.append(option);
  }
  modeSelect.addEventListener("change", () => {
    RADIAL.absolute = modeSelect.value === "absolute";
  });
  mode.append(modeCaption, modeSelect);

  const polarity = document.createElement("label");
  const polarityCaption = document.createElement("span");
  polarityCaption.textContent = "More wind";
  const polaritySelect = document.createElement("select");
  for (const [value, label] of [
    ["inward", "drag inward (tip tracks finger)"],
    ["outward", "drag outward (dial-like)"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    polaritySelect.append(option);
  }
  polaritySelect.addEventListener("change", () => {
    WIND_CONTROL.inward = polaritySelect.value === "inward";
  });
  polarity.append(polarityCaption, polaritySelect);

  const opacity = document.createElement("label");
  const opacityCaption = document.createElement("span");
  opacityCaption.textContent = "Wind layer";
  const opacityInput = document.createElement("input");
  opacityInput.type = "range";
  opacityInput.min = "0.1";
  opacityInput.max = "1";
  opacityInput.step = "0.05";
  opacityInput.value = "0.55";
  const opacityValue = document.createElement("span");
  opacityValue.className = "pos-geo-knob-value";
  opacityValue.textContent = "0.55";
  opacityInput.addEventListener("input", () => {
    root.style.setProperty("--pos-wind-opacity", opacityInput.value);
    opacityValue.textContent = opacityInput.value;
  });
  opacity.append(opacityCaption, opacityInput, opacityValue);

  strip.append(mode, polarity, opacity);
  return strip;
}

export interface GeometryOverlay {
  /** Mounts on the SVG root, above everything — the fills are translucent. */
  readonly element: SVGGElement;
  /** The corner readout. Mounts on the drawing surface, not in the SVG. */
  readonly legend: HTMLElement;
  update(state: SimState): void;
  setVisible(visible: boolean): void;
}

/**
 * Builds the overlay. `pixelsToMeters` is `Scene.pixelsToMeters`, so the
 * pixel-sized targets are measured at the live scale exactly as the input layer
 * measures them.
 */
export function createGeometryOverlay(
  pixelsToMeters: (pixels: number) => Meters,
  surfaceSize: () => { readonly width: number; readonly height: number },
): GeometryOverlay {
  const element = svgElement("g", { class: "pos-geo" });

  // --- World frame ----------------------------------------------------------

  const world = svgElement("g", { class: "pos-geo-world" });

  /**
   * The water no gesture claims: from the furthest a clew disc can reach out to
   * the band's inner edge. §5 says this is 6 px on a phone and much wider on an
   * iPad — worth seeing at the size it really is.
   */
  const gap = svgElement("circle", { class: "pos-geo-gap", cx: 0, cy: 0 });

  /** The disc the boat sweeps at any heading and any legal trim. */
  const sweep = svgElement("circle", {
    class: "pos-geo-sweep",
    cx: 0,
    cy: 0,
    r: SCENE.boatRadius,
  });

  const rule = (className: string, radius: Meters): SVGCircleElement =>
    svgElement("circle", {
      class: `pos-geo-rule ${className}`,
      cx: 0,
      cy: 0,
      r: radius,
      "vector-effect": "non-scaling-stroke",
    });

  const contentRule = rule("pos-geo-content", SCENE.contentRadius);
  const ringRule = rule("pos-geo-ring", SCENE.windRingRadius);
  const shortRule = rule("pos-geo-short", SCENE.shortRadius);
  /** Where the radial control's handle stands right now — the arrowhead, under
      `inward`. Set per frame, because it is the one reference that moves. */
  const handleRule = rule("pos-geo-arrow", 0);

  /** The rotation dead zone, shared by the hull and the wind. */
  const dead = svgElement("circle", { class: "pos-geo-dead", cx: 0, cy: 0 });

  /** A ruler along one bearing, so the bands can be counted off against it. */
  const ruler = svgElement("path", {
    class: "pos-geo-ruler",
    "vector-effect": "non-scaling-stroke",
  });

  // No fill for the wind's region. It is the whole surface now, so shading it
  // shaded everything and said nothing — the useful marks are the ones that
  // bound something.
  world.append(gap, sweep, dead, contentRule, handleRule, ringRule, shortRule, ruler);

  // --- Boat frame -----------------------------------------------------------

  const boat = svgElement("g", { class: "pos-geo-boat" });

  /**
   * The hull's hit region. `input/gestures.ts` tests against a 64-sample
   * inscribed polygon of this same outline — under a tenth of a millimetre
   * inside it — so the drawn path is the honest picture of the target.
   */
  const hull = svgElement("path", { class: "pos-geo-hull", d: hullPathData() });

  const mainTravel = svgElement("path", {
    class: "pos-geo-travel",
    d: travelPathData(mainClewPosition),
    "vector-effect": "non-scaling-stroke",
  });
  const jibTravel = svgElement("path", {
    class: "pos-geo-travel",
    d: travelPathData(jibClewPosition),
    "vector-effect": "non-scaling-stroke",
  });

  const mainDisc = svgElement("circle", { class: "pos-geo-clew" });
  const jibDisc = svgElement("circle", { class: "pos-geo-clew" });

  boat.append(hull, mainTravel, jibTravel, mainDisc, jibDisc);

  element.append(world, boat);

  // --- The readout ----------------------------------------------------------

  const legend = document.createElement("div");
  legend.className = "pos-geo-legend";

  const rows: [key: string, label: string][] = [
    ["dead", "dead zone"],
    ["hull", "hull"],
    ["clew", "clew grab"],
    ["sweep", "boat sweep"],
    ["gap", "unclaimed"],
    ["band", "wind"],
    ["ring", "drawn ring"],
    ["short", "short axis"],
    ["surface", "surface"],
  ];

  const values = new Map<string, HTMLElement>();
  for (const [key, label] of rows) {
    const row = document.createElement("div");
    row.className = "pos-geo-row";

    const swatch = document.createElement("span");
    swatch.className = `pos-geo-swatch pos-geo-swatch-${key}`;

    const name = document.createElement("span");
    name.className = "pos-geo-name";
    name.textContent = label;

    const value = document.createElement("span");
    value.className = "pos-geo-value";

    row.append(swatch, name, value);
    legend.append(row);
    values.set(key, value);
  }

  function report(key: string, text: string): void {
    const cell = values.get(key);
    if (cell !== undefined && cell.textContent !== text) cell.textContent = text;
  }

  /** `4.45–5.75 m · 61 px` — the band as a student's finger meets it. */
  function span(inner: Meters, outer: Meters, metersPerPixel: number): string {
    const width = outer - inner;
    const px = metersPerPixel > 0 ? Math.round(width / metersPerPixel) : 0;
    return `${inner.toFixed(2)}–${outer.toFixed(2)} m · ${px} px`;
  }

  function radius(value: Meters, metersPerPixel: number): string {
    const px = metersPerPixel > 0 ? Math.round(value / metersPerPixel) : 0;
    return `r ${value.toFixed(2)} m · ${px} px`;
  }

  return {
    element,
    legend,

    update(state: SimState): void {
      // Hidden costs nothing. `surfaceSize()` reads `clientWidth`, which forces
      // a synchronous layout immediately after the frame's SVG writes — a
      // reflow at 60 Hz for an overlay that is `display: none` by default.
      if (element.classList.contains("pos-geo-off")) return;
      const scale = touchScale(state, pixelsToMeters);
      const metersPerPixel = pixelsToMeters(1);

      boat.setAttribute("transform", boatTransform(state.motion.heading));

      setAnnulus(gap, SCENE.boatRadius + scale.grab, scale.windRing.inner);
      dead.setAttribute("r", formatNumber(scale.deadZone));

      place(mainDisc, mainClewPosition(state.trim.mainAngle), scale.grab);
      // The live chord, because that is where `beginGrab` hit-tests. Drawing it
      // on the rigid foot put the disc ~14 cm from the target it claims to show,
      // which is the discrepancy `liveJibClew` exists to remove and exactly what
      // this overlay's docblock promises not to do.
      place(
        jibDisc,
        jibClewPosition(state.trim.jibAngle, jibChord(state.trim.jibAngle, apparentWind(state.wind, state.motion))),
        scale.grab,
      );
      jibDisc.classList.toggle("pos-geo-struck", !state.trim.jibSet);
      jibTravel.classList.toggle("pos-geo-struck", !state.trim.jibSet);

      // Along the wind's own bearing, so the ruler is never under the boat.
      ruler.setAttribute("d", spokePathData(0, SCENE.shortRadius, state.wind.from));

      report("dead", radius(scale.deadZone, metersPerPixel));
      report("hull", "silhouette fill");
      report("clew", radius(scale.grab, metersPerPixel));
      report("sweep", radius(SCENE.boatRadius, metersPerPixel));
      // Under the radial-control prototype the wind's region is the fall-through
      // rather than an annulus, so there is no unclaimed water left to measure —
      // which is itself the finding, and worth printing rather than hiding.
      const unclaimed = scale.windRing.inner - (SCENE.boatRadius + scale.grab);
      report(
        "gap",
        unclaimed > 0
          ? span(SCENE.boatRadius + scale.grab, scale.windRing.inner, metersPerPixel)
          : "none — wind is the fall-through",
      );
      const handle = radiusForWind(state.wind.speed);
      handleRule.setAttribute("r", formatNumber(handle));
      report(
        "band",
        `all water · ${RADIAL.absolute ? "absolute" : "relative"} · ${WIND_CONTROL.inward ? "in" : "out"}=more`,
      );
      report("ring", radius(SCENE.windRingRadius, metersPerPixel));
      report("short", radius(SCENE.shortRadius, metersPerPixel));

      const size = surfaceSize();
      report("surface", `${Math.round(size.width)} × ${Math.round(size.height)} px`);
    },

    setVisible(visible: boolean): void {
      element.classList.toggle("pos-geo-off", !visible);
      legend.classList.toggle("pos-geo-off", !visible);
    },
  };
}
