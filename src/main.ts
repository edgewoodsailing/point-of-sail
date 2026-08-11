import "./shell.css";

// Shell bootstrap only. Later beads mount the layers here:
//   render/scene.ts onto .surface, input/pointer.ts onto the same element,
//   and the settings controls onto .controls. (DESIGN.md §6)
const surface = document.querySelector<HTMLElement>(".pos-sim .surface");
if (surface === null) {
  throw new Error("Page shell is missing the drawing surface (.pos-sim .surface)");
}
