import { describe, expect, it } from "vitest";

/**
 * Sign errors in a sailing model are miserable to debug, so the angle
 * conventions of DESIGN.md §2 live in exactly one file. This test keeps them
 * there: raw trigonometry belongs in `model/units.ts`, and everything else
 * calls the named helpers.
 *
 * If a new module genuinely needs a trig function the helpers don't cover, add
 * the helper — that is the fix, not an exemption here.
 *
 * Sources are read through Vite's own glob rather than `node:fs`, which keeps
 * the test suite free of Node typings and resolves paths the same way the
 * bundler does.
 */

const sources = import.meta.glob("./**/*.ts", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/** The one module allowed to touch `Math`'s trig functions directly. */
const UNITS_MODULE = "./model/units.ts";

const RAW_TRIG = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2)\b/g;

function modulesUnderTest(): [path: string, source: string][] {
  return Object.entries(sources).filter(
    ([path]) => path !== UNITS_MODULE && !path.endsWith(".test.ts"),
  );
}

describe("angle conventions", () => {
  it("keeps raw trigonometry out of everything but units.ts", () => {
    const offenders = modulesUnderTest().flatMap(([path, source]) =>
      (source.match(RAW_TRIG) ?? []).map((call) => `${path}: ${call}`),
    );

    expect(offenders).toEqual([]);
  });

  it("finds units.ts, so a broken glob can't pass silently", () => {
    expect(Object.keys(sources)).toContain(UNITS_MODULE);
    expect(modulesUnderTest().length).toBeGreaterThan(0);
  });
});
