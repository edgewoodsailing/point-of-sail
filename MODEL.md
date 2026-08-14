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
| Hull resistance, the wall, the keel's share and its stall | `RESISTANCE.*` | `model/tuning.ts` |
| How long the boat takes to get going, and the mass derived from it | `TERMINAL_FRACTION`, `EFFECTIVE_MASS` | `model/hull.ts` |
| Integrating speed, and the implicit step | — | `model/simulation.ts` |
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

**Depowering ↔ the hull-speed wall.** The two are alternatives for the same job
and only one is the right shape for it: the wall is a function of *speed* where
the problem is a function of the *wind*, so it bends the polar while a factor on
the drive does not. That is the whole argument for depowering's existence, and it
is worked through under [the wall](#the-wall-is-the-only-wind-scale), where the
measurement that settles it lives.

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

### The no-go zone's edge, where the exclusion does bite

The one place ordinary use reaches the limit, and the model's honest domain
boundary. At the edge of the no-go zone the water charges nothing and has no
slope, so a hairline of angles has two settled speeds
([DESIGN §3.5](DESIGN.md#quadratic-drag-has-no-slope-at-rest-and-that-gives-the-no-go-zone-an-edge)).
`fold.test.ts` bounds it, and owns the arithmetic showing what it is: the rig
makes some 450 N of side force against 6 N of drive, the keel would need a `Cl`
of 37 to 202 to hold that, and a foil of any kind tops out near 1.5.

**So the boat would sideslip and [§7](DESIGN.md#7-deliberately-out-of-scope) does
not let it.** The fold lives in the gap between the keel having stopped paying
for the side force and the hull still being pinned to its heading — which is to
say **the no-leeway exclusion stops being a simplification somewhere around a
knot or two**, and every equilibrium below that is an artefact of it rather than
a prediction. That is this model's domain limit, and it is why the branches being
a standstill is not merely tolerable but the only place the artefact can live: as
soon as the boat is fast enough for the keel to carry its load, the gap closes.

**Three ways out, all measured, all rejected** (`pos-rem` keeps the case open):

- **Widen the stall blend.** A real lever, and it runs the *opposite* way to the
  obvious one — widening pushes the band to a larger angle and shrinks it, and
  80° removes it outright, at a cost of under 0.02 kt on the polar. It is
  rejected because it is spent out of [§4.2](DESIGN.md#42-the-traffic-light)'s
  account instead: at 80° a boat sheeted flat in 10 kt makes 2.60 kt at TWA 60°
  where the shipped blend makes 1.20. Buying away *"sheeted flat is a mistake"*
  to remove a wobble at a standstill is the wrong trade.
- **Give the water a slope at rest.** A linear damping term needs to beat the
  drive's slope, which more than doubles the resistance at a knot, recalibrates
  the whole light-air end, and introduces a second absolute speed scale —
  falsifying [the wall being the only wind-scale](#the-wall-is-the-only-wind-scale).
- **Flatten the stalled sail.** `FOIL.plateNormalForce` does nothing here at all,
  at any value.

**And one middle option, found in the prior art rather than reasoned out.** *By
the Lee* computes residuary resistance from the Delft series, which is fitted
down to a Froude number of 0.1 and clamped below it — so under about 1.4 kt its
hull drag stops falling and sits at a constant. That is exactly the missing slope
at rest, arrived at by accident: an empirical formula held inside its range
rather than a decision about low-speed sailing. It is far cheaper than a linear
term because it stops mattering as soon as the boat moves — **5 N removes the
fold for about 1% of the polar at every point of sail**. It is not adopted
because a constant drag at rest is static friction, which water does not have,
and it would make the boat stop dead in finite time where the integrator says it
coasts like `1/t`. It is recorded because it is the only thing between doing
nothing and modelling leeway, and **a later pass that wants the boat to *stay*
stopped in irons should start here rather than rediscover it.**

## The hull and the integrator

### The wall is the only wind-scale

**Every force in this model except the hull-speed wall is homogeneous of degree
two in speed.** Scale the true wind and the boat together and each scales alike,
so the balance point is preserved and the shape of the polar does not move at
all. The keel's induced drag looks like the exception and is not — its `1/v²` is
cancelled by the load it carries, and `WALL_EXPONENT` writes that out. Only the
wall breaks it, because hull speed is an absolute speed.

The consequence is the single most useful fact about this model's behaviour:
**everything the polar does as the breeze fills in is the wall exponent's
doing.** Set the wall term to zero and re-solve the quadratic to hold a 10 kt
beam reach, and the polar becomes exactly scale-invariant at every wind from 4 to
30 kt.

**The trade, and why it only runs one way.** The wall bites hardest where the
boat is fastest, so it clips a reach harder than close hauled — and clipping the
fast angles is exactly what slides the upwind VMG optimum to a *smaller* angle.
So sharpening the wall buys a slower beam reach in a breeze at the price of a
boat that points ever higher in it, which is the opposite of what a keelboat
does. There is no exponent that holds a beam reach at hull speed in a gale *and*
holds the pointing angle: doing the first needs something like a 126th power,
which is a speed clamp rather than a wall, and the pointing is long gone before
that. **That measurement is why depowering exists** — the wall was being asked to
do a job it is the wrong shape for.

**Depowering does not make room to raise it again, and that was tried.** The
obvious hope is that once the cap holds the top of the wind range, the wall can
be sharpened to buy back the broad reach [§3.6](DESIGN.md#36-calibration-targets)
calls light. It cannot: at a sixth power with depowering on at every cap from 12
to 16 kt, the run/beam ratio at 14 kt and the VMG peak both fail. The reason is
structural rather than a matter of tuning — those two failures live at **14 kt**,
where the cap is only just beginning to bite, so no setting of it reaches back
far enough to help without breaking the 10 kt table on the way.

### The integrator

`simulation.ts` documents the implicit step, what it costs and what it buys. The
part that belongs here is why it stays now that nothing can reach the failure it
guards against: **what makes that failure unreachable is a tuning constant, not a
property of the physics.** Depowering caps the drive at its 13 kt value, so the
boat stops accelerating with the wind and the fourth power is never climbed far
enough to break the step. Raise `DEPOWERING.fullPowerWind` far enough, or take
the cap out to try something else, and the wall is waiting exactly where it
always was. The guard costs one extra term per frame and the trap is one line of
`tuning.ts` away, which is the wrong margin to run without one.
