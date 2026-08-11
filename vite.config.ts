/// <reference types="vitest/config" />
import { defineConfig } from "vite";

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
  },
});
