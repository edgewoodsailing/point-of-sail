/**
 * Rhodes 19 reference figures and rig geometry (DESIGN.md §3, §4.1, §5).
 *
 * These are *measurements of a boat*, not tuning knobs: every fudge factor
 * lives in `tuning.ts` instead, so that a number's file says whether it is
 * physics or taste. The source figures are the imperial ones sailors quote —
 * they are the numbers you can check against a sail plan — and everything
 * exported is the SI conversion, since the model works in SI throughout.
 */

import type { Kilograms, Meters, MetersPerSecond, Radians, SquareMeters, Vec2 } from "./units.ts";
import {
  add,
  feetToMeters,
  knotsToMetersPerSecond,
  normalizeSigned,
  poundsToKilograms,
  squareFeetToSquareMeters,
  vectorFromAngle,
  ZERO_VECTOR,
} from "./units.ts";

// --- Source figures, imperial (DESIGN.md §3) -------------------------------

const LOA_FT = 19 + 2 / 12; // 19'2"
const LWL_FT = 17 + 9 / 12; // 17'9"
const BEAM_FT = 7;
const DRAFT_FT = 3 + 3 / 12; // 3'3", keel down
const DISPLACEMENT_LB = 1325;

/** Foretriangle height: forestay deck fitting to the jib halyard sheave. */
const I_FT = 15.0;
/** Foretriangle base: mast to the forestay deck fitting. */
const J_FT = 6.5;
/** Mainsail hoist, tack to head along the mast. */
const P_FT = 24.0;
/** Mainsail foot, i.e. the working length of the boom. */
const E_FT = 9.7;

/** Main area including roach, so a little more than P·E/2. */
const MAIN_AREA_SQ_FT = 118.6;
/** Jib area, essentially I·J/2 for this 100% jib. */
const JIB_AREA_SQ_FT = 48.8;

/** The classic displacement-hull coefficient in `v_hull = 1.34·√LWL_ft` knots. */
const HULL_SPEED_COEFFICIENT = 1.34;

// --- Longitudinal stations, feet aft of the bow ----------------------------
//
// §5 quotes the two figures a student's finger actually cares about: the main
// clew rides the boom end ~16.7 ft aft of the bow, and the jib clew sheets to
// the deck ~9 ft aft. Those are *consequences*, so only one of them is a
// constant here.
//
// The mast is fixed where the boat has it — 16.7 ft less the 9.7 ft boom — and
// the main clew then follows from the boom length, which is the honest
// direction of the dependency: refitting a longer boom moves the clew aft, it
// does not walk the mast forward. (boat.test.ts checks the clew still lands at
// 16.7 ft.) The forestay follows the mast by J, the foretriangle base, landing
// half a foot aft of the stem — which is why §4.1 can call it "the forestay at
// the bow".

const MAST_STATION_FT = 7.0;
const FORESTAY_STATION_FT = MAST_STATION_FT - J_FT;

/** Where the jib sheets to the deck; with the tack at the forestay, this sets the foot. */
const JIB_CLEW_STATION_FT = 9.0;

/** The jib's foot: tack at the forestay, clew on the deck 9 ft aft. */
const JIB_FOOT_FT = JIB_CLEW_STATION_FT - FORESTAY_STATION_FT;

// --- Hull ------------------------------------------------------------------

export const HULL: {
  readonly loa: Meters;
  readonly lwl: Meters;
  readonly beam: Meters;
  readonly draft: Meters;
  readonly displacement: Kilograms;
  readonly hullSpeed: MetersPerSecond;
} = {
  loa: feetToMeters(LOA_FT),
  lwl: feetToMeters(LWL_FT),
  beam: feetToMeters(BEAM_FT),
  draft: feetToMeters(DRAFT_FT),
  displacement: poundsToKilograms(DISPLACEMENT_LB),
  /**
   * ≈ 5.65 kt. The wall the resistance curve is shaped around (§3.5) — not the
   * mass the boat accelerates with, which is `m_effective` in `tuning.ts` and
   * includes crew and added mass.
   */
  hullSpeed: knotsToMetersPerSecond(HULL_SPEED_COEFFICIENT * Math.sqrt(LWL_FT)),
};

// --- Rig -------------------------------------------------------------------

/** The four rig dimensions off the sail plan, in metres. */
export const RIG: {
  readonly i: Meters;
  readonly j: Meters;
  readonly p: Meters;
  readonly e: Meters;
} = {
  i: feetToMeters(I_FT),
  j: feetToMeters(J_FT),
  p: feetToMeters(P_FT),
  e: feetToMeters(E_FT),
};

export interface Sail {
  readonly area: SquareMeters;
  /** Luff length — the leading edge, and the span in the aspect-ratio sense. */
  readonly luff: Meters;
  /** Foot length: also the radius the clew swings on about its tack. */
  readonly foot: Meters;
  /** `luff² / area`, the standard sail convention (§3.2). */
  readonly aspectRatio: number;
}

function sail(area: SquareMeters, luff: Meters, foot: Meters): Sail {
  return { area, luff, foot, aspectRatio: (luff * luff) / area };
}

/** Aspect ratio ≈ 4.86. The boom makes the foot length exact. */
export const MAIN: Sail = sail(
  squareFeetToSquareMeters(MAIN_AREA_SQ_FT),
  feetToMeters(P_FT),
  feetToMeters(E_FT),
);

/** Aspect ratio ≈ 5.48. The luff is the forestay itself, hence √(I² + J²). */
export const JIB: Sail = sail(
  squareFeetToSquareMeters(JIB_AREA_SQ_FT),
  feetToMeters(Math.hypot(I_FT, J_FT)),
  feetToMeters(JIB_FOOT_FT),
);

// --- Stations, in the boat frame -------------------------------------------

/**
 * Fixed points of the boat, as boat-frame vectors in metres: +x to starboard,
 * −y forward. **The origin is the mast**, because that is what the hull rotates
 * about (§5) and what the boom swings on, so the rig geometry needs no offset.
 */
export const STATIONS: {
  readonly mast: Vec2;
  readonly bow: Vec2;
  readonly stern: Vec2;
  /** Where the forestay meets the deck — the jib's tack, half a foot aft of the stem. */
  readonly forestay: Vec2;
} = {
  mast: ZERO_VECTOR,
  bow: { x: 0, y: -feetToMeters(MAST_STATION_FT) },
  stern: { x: 0, y: feetToMeters(LOA_FT - MAST_STATION_FT) },
  forestay: { x: 0, y: -feetToMeters(J_FT) },
};

// --- Rig geometry ----------------------------------------------------------

/**
 * The boat-frame bearing of a sail's chord, running tack → clew.
 *
 * Trim is stored as the chord angle off the centreline, positive with the clew
 * to starboard (§2). A sail sheeted flat lies dead aft, bearing π; easing the
 * clew to starboard swings the chord *toward* the starboard beam, so the
 * bearing counts down from π. Hence the subtraction — the one sign flip in the
 * rig geometry, kept here so nothing downstream has to remember it.
 */
export function sailChordBearing(sailAngle: Radians): Radians {
  return normalizeSigned(Math.PI - sailAngle);
}

/** Where the main's clew sits for a given trim: the boom end, swinging about the mast. */
export function mainClewPosition(mainAngle: Radians): Vec2 {
  return add(STATIONS.mast, vectorFromAngle(sailChordBearing(mainAngle), MAIN.foot));
}

/**
 * Where the jib's clew sits for a given trim. With no boom it swings about the
 * tack at the forestay, on a radius of the jib's foot.
 */
export function jibClewPosition(jibAngle: Radians): Vec2 {
  return add(STATIONS.forestay, vectorFromAngle(sailChordBearing(jibAngle), JIB.foot));
}
