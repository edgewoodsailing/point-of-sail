/**
 * The two clew fittings — the only grab points on the rig (DESIGN.md §5).
 *
 * §5's discoverability argument, drawn: with no labels anywhere, the grab
 * points have to announce themselves, and a small ring at each clew reads as
 * boat hardware — a shackle, a sheet block — rather than as UI chrome. That
 * signals the affordance without handing a student the answer, which is what
 * the no-scaffolding position was actually about.
 *
 * **This layer is not the hit target.** Arbitration is geometric and lives in
 * `input/gestures.ts`, sized in CSS pixels against §5's ~44 px disc, and it
 * never consults an event's target. The ring is a dimension *of the boat*, so
 * it is in metres and scales with the drawing (`render/scene.ts`) — the two
 * sizes are deliberately independent, and on a phone the invisible disc is
 * several times the visible ring.
 */

import { jibClewPosition, mainClewPosition } from "../model/boat.ts";
import type { SimState } from "../model/simulation.ts";
import type { Meters, Vec2 } from "../model/units.ts";
import type { Layer } from "./scene.ts";
import { formatNumber, svgElement } from "./svg.ts";

/**
 * The ring's radius, in metres.
 *
 * Sized against the mast dot (0.11 m in `hull.ts`), which is the only other
 * piece of drawn hardware, so the two read as the same kind of thing — and
 * drawn as a ring rather than a filled dot so they are still told apart at a
 * glance. In pixels that is a 6.8 px circle on a 390 px phone, 14.6 px on an
 * iPad and 15.8 px on a desktop, against a hull-weight stroke of 1.4 px to 4 px
 * laid on top of it.
 *
 * **Diameter, not inked extent.** The stroke straddles the path, so a bounding
 * box reads about 2 px wider on a phone; quoting one of those as the mark's
 * size is what put a wrong number in DESIGN §5 once already.
 */
const FITTING_RADIUS: Meters = 0.105;

/**
 * Set on the jib's fitting when the jib is struck; `scene.css` hides it.
 *
 * The same class `render/sail.ts` puts on the struck jib's group, and for the
 * same reason: a struck jib is absent entirely (§4.1), which has to include the
 * fitting a student would otherwise reach for. The two are independent
 * elements in different layers, so each sets it for itself.
 */
const STRUCK_CLASS = "pos-struck";

/** `formatNumber` for the same reason every other layer uses it: no per-frame churn. */
function place(fitting: SVGCircleElement, at: Vec2): void {
  fitting.setAttribute("cx", formatNumber(at.x));
  fitting.setAttribute("cy", formatNumber(at.y));
}

/** Both fittings, as a layer for `main.ts` to mount on `scene.layers.handles`. */
export function createClewLayer(): Layer {
  const element = svgElement("g", { class: "pos-clews" });

  const fitting = (className: string): SVGCircleElement =>
    svgElement("circle", {
      class: `pos-clew ${className}`,
      r: FITTING_RADIUS,
      "vector-effect": "non-scaling-stroke",
    });

  const main = fitting("pos-main-clew");
  const jib = fitting("pos-jib-clew");
  element.append(main, jib);

  return {
    element,
    update(state: SimState): void {
      place(main, mainClewPosition(state.trim.mainAngle));

      // Struck: hidden, and no position written for it. What is left behind is
      // stale and harmlessly so — the element is `display: none`, and the frame
      // that unstrikes the jib writes its position before anything paints.
      jib.classList.toggle(STRUCK_CLASS, !state.trim.jibSet);
      if (state.trim.jibSet) place(jib, jibClewPosition(state.trim.jibAngle));
    },
  };
}
