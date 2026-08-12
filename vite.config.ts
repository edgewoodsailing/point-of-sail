/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

export default defineConfig({
  // `base` stays at the default "/" — the deploy bead (pos-740.5) owns the
  // base-vs-route decision, since the page URL and the asset URL differ in the
  // registrar app (DESIGN.md §6.1).
  build: {
    // DESIGN.md §4.4 support floor. Vite 7's default baseline is Safari 16,
    // which would silently raise the floor — pin it explicitly.
    target: ["safari15.4", "chrome111", "firefox113"],
  },
  test: {
    // Default `node` environment: model code is DOM-free by design (§6).

    // Agent worktrees live under `.claude/worktrees/`, each a full checkout of
    // this repo on some other branch. Without this, `npm test` globs into them
    // and runs a second, *different* copy of the suite — reporting 28 files
    // where 14 exist, and going green or red on code that is not the code in
    // front of you.
    //
    // It fixes the direction that matters and only that one: running the suite
    // from here. A worktree run from inside itself is its own root, where this
    // path does not exist, so it still tests exactly its own branch — which is
    // what a worktree is for. Spread rather than replace: bare `exclude` drops
    // vitest's own defaults, `node_modules` and `dist` among them.
    exclude: [...configDefaults.exclude, "**/.claude/**"],

    // Vitest replaces CSS imports with empty strings by default, and does so by
    // extension — `?raw` does not opt out, so `import css from "./scene.css?raw"`
    // silently yields "" rather than failing. `speed.test.ts` reads
    // `--pos-rule-speed` out of the stylesheet so the speed arrow's edge margin
    // cannot drift from the stroke width it is sized against (pos-7nt), and an
    // empty string would have made that check vacuous rather than red.
    //
    // The only other CSS in the suite's path is `scene.ts`'s side-effect import
    // of the same file, which now costs a transform it did not before. That is
    // the whole blast radius; the `node` environment means nothing is injected
    // into a document either way.
    css: true,
  },
});
