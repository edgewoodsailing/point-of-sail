import { describe, expect, it } from "vitest";

/**
 * `oklch()` in an SVG presentation attribute — `fill="oklch(…)"` — parses only
 * in Safari (DESIGN.md §4.4). A school iPad is Safari, so that mistake passes
 * every test written here and breaks on a student's Android phone. The rule is
 * therefore absolute: **colour goes through CSS**, either a custom property or
 * `element.style`, both of which run the CSS parser on every engine.
 *
 * `render/palette.ts` makes the rule structural for the one colour that is
 * computed — it offers no route to the DOM except `setProperty`. This test is
 * the other half: the rule is a property of the whole repository, not of one
 * module, and a hand-written `fill` three beads from now would not go anywhere
 * near the palette. So it gets the same treatment `no-raw-trig.test.ts` gives
 * the angle conventions.
 *
 * It also carries the three `.stylelintrc.json` rules across the door they stop
 * at. `npm run lint` points stylelint at `src` CSS only, so a hex colour or an
 * `rgb()` written in TypeScript is unlinted; here it is not.
 *
 * The rule has a boundary, and over-applying it would cost something real. This
 * bans *colour* attributes. Geometry attributes — `d`, `transform`, `r`,
 * `vector-effect` — are untouched, and two of them are actively preferable to
 * their CSS equivalents: CSS `transform` on an SVG group rotates about the
 * reference box's centre rather than the user-space origin, which for a boat
 * that turns about its mast is simply the wrong point.
 *
 * Sources are read through Vite's own glob rather than `node:fs`, which keeps
 * the test suite free of Node typings and resolves paths the way the bundler
 * does.
 */

const sources = import.meta.glob("./**/*.ts", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/** The SVG presentation attributes that take a colour. */
const COLOR_ATTRIBUTES = ["fill", "stroke", "stop-color", "flood-color", "lighting-color"];

const NAMES = COLOR_ATTRIBUTES.join("|");

/** `setAttribute("fill", …)` — the direct form. */
const SET_ATTRIBUTE = new RegExp(`setAttribute\\(\\s*["'\`](${NAMES})["'\`]`, "g");

/**
 * `svgElement("path", { fill: … })` — the indirect form, and the likelier one,
 * since `svg.ts`'s factory takes attributes as an object.
 *
 * Matches a colour name in *key* position only. `element.style.fill = …` is
 * expressly allowed by §4.4 and does not match, because a property assignment
 * has no colon.
 */
const ATTRIBUTE_KEY = new RegExp(`(?:^|[{,\\s])["']?(${NAMES})["']?\\s*:`, "gm");

/** Hex, and the legacy colour functions. Stylelint bans both in the CSS files. */
const HEX_COLOR = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
const LEGACY_COLOR_FUNCTION = /\b(?:rgba?|hsla?)\(/g;

const PATTERNS = {
  "a colour presentation attribute": [SET_ATTRIBUTE, ATTRIBUTE_KEY],
  "a hex colour": [HEX_COLOR],
  "rgb()/hsl()": [LEGACY_COLOR_FUNCTION],
};

function modulesUnderTest(): [path: string, source: string][] {
  return Object.entries(sources).filter(([path]) => !path.endsWith(".test.ts"));
}

/**
 * Comments out.
 *
 * §4.4's rule is quoted verbatim in several docblocks — `svg.ts` writes out the
 * broken `fill="oklch(…)"` in order to forbid it — and prose describing the
 * rule must not be mistaken for breaking it.
 *
 * The `[^:]` guard on the line-comment form is what keeps `"http://…"` intact;
 * it is the one `//` inside a string literal in this repository.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function offenders(pattern: RegExp): string[] {
  return modulesUnderTest().flatMap(([path, source]) =>
    (withoutComments(source).match(pattern) ?? []).map((hit) => `${path}: ${hit.trim()}`),
  );
}

describe("colour never goes through an SVG attribute (DESIGN.md §4.4)", () => {
  for (const [what, patterns] of Object.entries(PATTERNS)) {
    it(`keeps ${what} out of every module`, () => {
      expect(patterns.flatMap(offenders)).toEqual([]);
    });
  }

  it("leaves geometry attributes alone, which is the boundary of the rule", () => {
    const geometry = modulesUnderTest().filter(([, source]) =>
      /setAttribute\(\s*["']d["']/.test(source),
    );
    expect(geometry.length).toBeGreaterThan(0);
  });

  it("would catch each of these, so a passing suite means something", () => {
    // The patterns, aimed at the mistakes they exist to stop. Without this the
    // whole file could be vacuously green — a typo in one regex, or a comment
    // stripper that blanked the sources, would look identical to compliance.
    const bad = `
      const a = svgElement("path", { fill: "red" });
      const b = svgElement("path", { "stop-color": c });
      element.setAttribute("stroke", ink);
      const d = "#be2517";
      const e = "rgb(190 37 23)";
    `;
    for (const pattern of Object.values(PATTERNS).flat()) {
      expect(withoutComments(bad)).toMatch(pattern);
    }
    // And the two forms §4.4 expressly allows must *not* match.
    expect(withoutComments(`group.style.setProperty("--pos-sail-ink", ink);`)).not.toMatch(
      ATTRIBUTE_KEY,
    );
    expect(withoutComments(`path.style.fill = ink;`)).not.toMatch(ATTRIBUTE_KEY);
  });

  it("finds the modules, so a broken glob can't pass silently", () => {
    expect(Object.keys(sources)).toContain("./render/palette.ts");
    expect(modulesUnderTest().length).toBeGreaterThan(0);
  });
});
