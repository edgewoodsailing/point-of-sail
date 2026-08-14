# Point of Sail — Model notes

Companion to [DESIGN.md](DESIGN.md). **DESIGN says what the boat must do and why
a student needs it; this document says how the physics is arranged and what
trades against what.** The dependency runs one way: this document treats DESIGN's
calibration targets as requirements, and DESIGN points here for mechanism rather
than repeating it.

Same editing rules as DESIGN — current state rather than history, unbuilt work in
the present tense with a `(planned: pos-…)` reference — and one more that governs
what may be written here at all.

**Do not restate a constant's own documentation.** Every tuning constant carries
its value, its measurements and its reasoning in `model/tuning.ts`, beside the
number, where it cannot drift from the code. Establishing this document turned up
how strong that rule has to be: a first draft of it reproduced the 32° blend
floor, the fold's detection method and three of the four depowering arguments,
all of which were already written better next to the thing they describe. **If a
paragraph here would fit in one docblock, it belongs in that docblock.** What is
left for this document is the map, and the couplings that span more than one
file — the things with nowhere else to live.

## Where the numbers live

| Concern | Constant | Documented in |
| --- | --- | --- |
| Lift ceiling on the attached limb, and its corner | `FOIL.maxLift`, `FOIL.saturationSharpness` | `model/tuning.ts` |
| Where the stall begins, and how wide the blend is | `FOIL.stallAngle`, `FOIL.stallBlendWidth` | `model/tuning.ts` |
| Flat-plate normal force — sets the speed of a run, alone | `FOIL.plateNormalForce` | `model/tuning.ts` |
| Parasitic drag, span efficiency | `FOIL.profileDrag`, `FOIL.spanEfficiency` | `model/tuning.ts` |
| When cloth starts to shake, and when it has wholly let go | `LUFF.drawingAbove`, `LUFF.collapsedBelow` | `model/tuning.ts` |
| Where the rig stops collecting force, and how sharply | `DEPOWERING.fullPowerWind`, `DEPOWERING.knee` | `model/tuning.ts` |
| Hull resistance, the wall, the keel's share | `RESISTANCE.*` | `model/tuning.ts` |
| Assembling the two limbs into one curve | — | `model/foil.ts` |
| Turning a trim into a force, and where depowering is applied | — | `model/sail.ts` |
| Whether the polar folds, and how that is detected | — | `model/fold.test.ts` |

## The sail force model

A sail is a thin cambered foil of finite span, and the curve is two limbs
blended into one:

- **Attached**, below the stall. Lift rises with incidence and saturates toward a
  ceiling; induced drag is charged against the lift the incidence *demands*, not
  the lift delivered, so incidence past the ceiling costs drag and pays nothing —
  which is what a stall is.
- **Flat plate**, past it. A normal force `k·sinα` resolved along and across the
  flow, so at α = 90° lift is zero and the boat is pushed rather than lifted.

The join is a smooth blend rather than a cliff, because a soft sail stalls
gradually — and because a cliff makes the boat bistable.

### What trades against what

**Lift ceiling ↔ blend width: a coupling that has been removed, and must stay
removed.** These were once one knob — with no ceiling on the attached limb, the
curve's peak fell wherever the blend happened to catch a ramp that was still
climbing, so peak lift could not be moved without moving the post-stall falloff
with it. `FOIL.maxLift` now sets the peak and `FOIL.stallBlendWidth` sets the
falloff, independently. The simplification to resist is *"the limb has a maximum,
so the blend is cosmetic"*; `FOIL.stallBlendWidth` records what happens when the
blend is narrowed back with the ceiling still in place, and it is not cosmetic.

**Blend width ↔ the fold ↔ the calibration table.** Widening the blend is the
cure for [the fold](#the-speed-fold), and the width cannot be chosen on that
ground alone: the polar still has to meet
[DESIGN §3.6](DESIGN.md#36-calibration-targets), and a softer stall also leaves
more lift either side of the optimum, which widens the close-hauled trim band and
makes the boat measurably more forgiving upwind. Three requirements, one number.

**Depowering ↔ the hull-speed wall.** Every force in the model is homogeneous of
degree two in speed, so before depowering the wall was the only source of
wind-dependence in the polar — and it is a function of *speed* where the problem
is a function of the *wind*. It therefore bites hardest where the boat is
fastest, clipping a reach harder than close hauled and sliding the upwind optimum
lower as the breeze fills in. A factor on the drive has no such problem: at any
one wind it multiplies every point of sail alike, which slows the boat without
bending the polar. That is why the shape is a factor on the whole rig force and
not a steeper wall.

**Peak lift is flat, and the trim-quality colour reads against it.** Saturating
the limb broadens the summit as well as lowering it — a real sail has a forgiving
best trim rather than a knife edge. The consequence for anything downstream:
"the optimal trim" is fuzzier than it looks, and the optimal-trim search's argmax
can move by a fraction of a degree on a rounding difference. Compare a trim to
*the* optimum with a tolerance, never an equality.

### Luffing and the two edge-on states

A sail lies along the flow at α = 0 and again at α = ±180°, and the collapse
thresholds are read against whichever is nearer. That fold buys **nothing in
newtons** — the foil curve already reports a sail making nothing at both — and it
was still the right call, for a reason worth keeping because it generalises: the
collapsed fraction drives the *flutter* as well as the force, so leaving it at
zero near ±180° would have the model assert *fully drawing* about a sail that is
flogging, and the drawing would then have to paper over one of the model's own
numbers. **A model whose renderer has to correct it has the number wrong.**

**LUFF's thresholds ↔ the mainsheet clamp.** These are set in different files and
neither knows about the other, but they meet at the same geometry: the sheet
clamp holds the boom on its stop until α reaches ±180°, and the fraction reaches
1 in the last couple of degrees before that. So the approach to a gybe is the
sail walking up the collapse band and letting go at the top of it — two rules a
student is taught separately, arriving from one angle. Widening `LUFF` or
changing the clamp moves the same event, and this is the only place that says so.

**Which trims reach the leech-first state, since it is not the obvious ones.**
α = AWA + trim, so *easing* on a reach moves α **away** from 180°, not toward it.
It takes the boom near the centreline with the wind nearly dead astern, or the
boom out on what has become the windward side. Both are ordinary: an
under-trimmed main on a run, and sailing by the lee.

`LUFF` documents the thresholds and the fold; `collapsedFraction` and
`collapseFrom` in `model/sail.ts` document why the fraction and the edge are two
values rather than one signed one, and what the fraction is doing at 175°.

### The speed fold

**The model's characteristic failure mode, and the thing to check any change to
the sail curve against.** A falling lift curve is a feedback loop on a boat:
slowing swings the apparent wind aft, which raises the angle of attack, which
past the peak cuts lift, which slows the boat further. Where the loop closes, the
boat has **two settled speeds at one trim** and takes whichever its history leads
it to.

What is worth knowing here rather than in any one file is where it does *not*
come from, because both alternatives are plausible and expensive to explore:

- **Neither limb folds alone.** A pure attached curve is monotone and has nothing
  to feed back on; a pure flat plate peaks gently. Only the *join* between them
  can be steep enough to close the loop — which is why the cure is a
  parameterisation rather than a change to either piece of physics.
- **The keel is not implicated.** Deleting its induced drag makes the fold
  *worse*, so `RESISTANCE.keelStall` is neither cause nor cure.

`fold.test.ts` owns detection, including why a sweep that finds nothing proves
nothing here. Read it before trusting a clean sweep.

## Depowering

The requirement — full sail to 13 kt of true wind, the force holding at what it
reached there — is in
[DESIGN §3.2](DESIGN.md#depowering-the-rig-stops-collecting-force-in-a-breeze).
Why 13, and why the knee is sharp, are in `DEPOWERING`'s own documentation. Why
it is keyed to the true wind when every aerodynamic coefficient comes from the
apparent, and why `simulation.ts` applies it rather than `sail.ts`, are in
`depoweringFactor`'s.

One argument spans both and lives here: **heel is the right cause, but its effect
has to be spread evenly to be any use.** Driving the factor from side force is
the honest reading of "the boat heels", since heeling moment is what runs a crew
out of righting moment. Measured, it puts a run as fast as a beam reach in a gale
and barely touches top speed at all, because the fastest angles make little side
force and escape the cap. The same is true of keying it to the apparent wind: a
run has the lowest apparent wind of any point of sail, so it would be depowered
least, and DESIGN §3.6's "a run is notably slower than a reach" breaks at exactly
the wind the simulator opens in. Both failures have the same shape — a cap that
sorts by point of sail is a cap that bends the polar.

## Where the model stops being valid

Every simplification has an edge, and the useful question is never whether one
exists but whether ordinary use reaches it. This section holds the cases that
have been *checked* rather than assumed, because each spans a simplification in
one place and a force in another, and neither file can see both.

**Backing, against the no-leeway exclusion.** [DESIGN §7](DESIGN.md#7-deliberately-out-of-scope)
excludes leeway, and the hull model records that below a knot or two the keel
cannot hold the side force the rig is making — so the exclusion stops being a
simplification down there. A backed sail is the obvious place to worry, since it
is deliberately a large force at no speed, and the mooring departure this model
is built around lives exactly there.

Measured, it holds. Backed to 45°–90°, anywhere from head to wind out to TWA 45°
in 10 kt, the boat settles at **2.1–2.8 kt of sternway** while the keel is
charging 0–22% of the side force against its 22% ceiling — at or under capacity
throughout, needing a `Cl` of 0.8 at worst where a foil has 1.5.

**The reason it holds is worth having, because it is not luck.** Backing makes
its force mostly as *drag*, straight down the boat's axis: at 90° of backed trim
the side force is a couple of newtons. So there is very little for the keel to
hold, the boat gets moving smartly, and by the time it is moving the question no
longer arises. A manoeuvre that looks like the worst case for the exclusion turns
out to be nearly the best.

## The hull and the integrator

Not yet split out. [DESIGN §3.5](DESIGN.md#35-hull-resistance-and-integration)
still carries it, and the coupling that belongs here when it moves is the wall
exponent's: it is the model's only wind-scale, so steepening it to buy back a
broad reach sends the pointing angle through the floor as the breeze fills in.
