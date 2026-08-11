/**
 * The complete simulation state (DESIGN.md §2).
 *
 * Only the type, for now. `step(dt)` and the ghost boat arrive with the
 * integration bead; this file exists already because `render/` needs something
 * to read, and §6 puts the state here.
 */

import type { RigTrim } from "./sail.ts";
import type { BoatMotion, TrueWind } from "./wind.ts";

/**
 * Everything the simulator knows, which is not much — no history, no session,
 * no stored client state.
 *
 * Grouped rather than flat. §2 lists the same nine fields side by side, but the
 * model had already factored three of those groups into `TrueWind`,
 * `BoatMotion` and `RigTrim`, and they are exactly the argument types
 * `apparentWind()` and `rigForce()` take. Composing from them means the state
 * can be handed to the physics unrepacked, and there is one definition of "the
 * wind" rather than two that could drift.
 */
export interface SimState {
  /** Direction the wind blows *from*, and its speed, in the world frame. */
  readonly wind: TrueWind;
  /** Where the bow points, and the signed speed — negative is sternway. */
  readonly motion: BoatMotion;
  /** Both sail angles, and whether the jib is set at all (§3.7). */
  readonly trim: RigTrim;
  /** Is the user physically forcing the main against the wind right now? (§3.4) */
  readonly mainHeld: boolean;
  /** Likewise for the jib. */
  readonly jibHeld: boolean;
}
