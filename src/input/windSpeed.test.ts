import { describe, expect, it } from "vitest";

import { DEPOWERING } from "../model/tuning.ts";
import { knotsToMetersPerSecond, metersPerSecondToKnots } from "../model/units.ts";
import { knotsFromWindSpeed, WIND_SPEED_KT, windSpeedFromKnots } from "./windSpeed.ts";

/**
 * §5's wind speed control, minus its element.
 *
 * The module is deliberately only the arithmetic — the range, and the two
 * conversions either side of it — so that the part worth asserting can be
 * asserted in the `node` environment the rest of the suite runs in. What is left
 * in `main.ts` is element construction: three attributes set from
 * {@link WIND_SPEED_KT}, one listener, and a follower that writes a string.
 *
 * **What this file cannot cover**, and does not pretend to: that the element
 * really carries these bounds, that a thumb dragged on a phone fires `input` and
 * not just `change`, and that the follower does not fight a thumb being dragged.
 * Those are hand-checked in Chrome and reported with the bead.
 */
describe("the wind speed range", () => {
  /**
   * The decision this bead exists to make, and the referent several comments
   * across the model have been waiting for (pos-g7p). Pinned as a number rather
   * than left to the element's attributes, because "section 5 does not say where
   * the wind slider stops" was true for four beads and cost a stale comment in
   * six files.
   */
  it("runs 0 to 20 knots in whole-knot steps", () => {
    expect(WIND_SPEED_KT.min).toBe(0);
    expect(WIND_SPEED_KT.max).toBe(20);
    expect(WIND_SPEED_KT.step).toBe(1);
  });

  /**
   * The top of the range sits above §3.2's depowering knee, which is what makes
   * it a range worth having rather than a range that merely stops somewhere.
   *
   * `DEPOWERING.fullPowerWind` is 13 kt, so the top third of the slider is
   * inside the regime where the rig stops collecting force — run it up and the
   * boat visibly stops gaining speed. A ceiling at or below 13 would have cut
   * that off entirely, and this is the assertion that would notice.
   */
  it("reaches past the wind the rig is fully powered up in", () => {
    const knee = metersPerSecondToKnots(DEPOWERING.fullPowerWind);
    expect(knee).toBeCloseTo(13, 9);
    expect(WIND_SPEED_KT.max).toBeGreaterThan(knee);
    // A third of the range above it, which is the part worth playing with.
    expect((WIND_SPEED_KT.max - knee) / (WIND_SPEED_KT.max - WIND_SPEED_KT.min)).toBeCloseTo(
      0.35,
      2,
    );
  });

  /**
   * The range is stated in knots and the model works in metres per second, so
   * the interesting failure is not an off-by-one at either end — it is a value
   * that never went through a conversion at all. 20 kt is 10.29 m/s; a slider
   * whose reading was passed straight through would set 20 m/s, which is 38.9 kt
   * and a storm.
   */
  it("hands the model metres per second, not knots", () => {
    expect(windSpeedFromKnots(20)).toBeCloseTo(10.2889, 4);
    expect(windSpeedFromKnots(20)).toBeCloseTo(knotsToMetersPerSecond(20), 12);
    // The mistake this rules out, stated so it cannot be read back in.
    expect(windSpeedFromKnots(20)).not.toBeCloseTo(20, 1);
  });

  it("reaches a dead calm, which is the end a student needs", () => {
    expect(windSpeedFromKnots(0)).toBe(0);
    expect(knotsFromWindSpeed(0)).toBe(0);
  });

  /**
   * Both directions of the clamp. A guard checked only where it passes says
   * nothing about its own resolution, so each end is checked from inside the
   * range and from outside it.
   */
  it("clamps a reading outside the range, at both ends", () => {
    expect(metersPerSecondToKnots(windSpeedFromKnots(-5))).toBeCloseTo(0, 9);
    expect(metersPerSecondToKnots(windSpeedFromKnots(40))).toBeCloseTo(20, 9);
    // …and leaves everything between alone.
    expect(metersPerSecondToKnots(windSpeedFromKnots(0))).toBeCloseTo(0, 9);
    expect(metersPerSecondToKnots(windSpeedFromKnots(13))).toBeCloseTo(13, 9);
    expect(metersPerSecondToKnots(windSpeedFromKnots(20))).toBeCloseTo(20, 9);
  });
});

describe("what the slider shows", () => {
  /**
   * The round trip a thumb makes on every `input` event: reading → state →
   * reading. If it did not close, the follower would write a different number
   * back to the element than the one the student just set, and the thumb would
   * crawl while it was being dragged.
   */
  it("closes the loop for every reading the slider can produce", () => {
    for (let knots = WIND_SPEED_KT.min; knots <= WIND_SPEED_KT.max; knots += WIND_SPEED_KT.step) {
      expect(knotsFromWindSpeed(windSpeedFromKnots(knots))).toBe(knots);
    }
  });

  /**
   * A wind the slider did not set — from the console handle in `main.ts`, or
   * from §2.1's randomised opening state, whose 6–14 kt band is not on whole
   * knots — is shown at the nearest step rather than truncated.
   */
  it("rounds a wind the slider did not set to the nearest step", () => {
    expect(knotsFromWindSpeed(knotsToMetersPerSecond(9.4))).toBe(9);
    expect(knotsFromWindSpeed(knotsToMetersPerSecond(9.6))).toBe(10);
    // Truncation would give 9 for both, so the second reading is what separates
    // rounding from flooring.
    expect(knotsFromWindSpeed(knotsToMetersPerSecond(9.5))).toBe(10);
  });

  /**
   * A state outside the range reports at the end it exceeds. It is the only
   * honest answer a control that cannot express the value can give, and the
   * alternative — leaving the thumb wherever it was — is the stale reading the
   * follower exists to prevent.
   */
  it("reports an out-of-range wind at the end it exceeds", () => {
    expect(knotsFromWindSpeed(knotsToMetersPerSecond(40))).toBe(20);
    expect(knotsFromWindSpeed(knotsToMetersPerSecond(-3))).toBe(0);
  });

  /**
   * The top of the range is reachable by rounding *up* to it, not only by
   * clamping down to it. Worth its own case because the two arrive at 20 by
   * different routes and only one of them is exercised by the clamp test above.
   *
   * It says nothing about the order of the round and the clamp, and cannot: both
   * ends sit on the step lattice, so the two operations commute and no reading
   * can tell them apart. The docblock on `knotsFromWindSpeed` says so rather
   * than claiming a distinction this suite would then be unable to detect.
   */
  it("rounds up to the top of the range rather than stopping short of it", () => {
    expect(knotsFromWindSpeed(knotsToMetersPerSecond(19.6))).toBe(20);
    expect(knotsFromWindSpeed(knotsToMetersPerSecond(19.4))).toBe(19);
  });
});
