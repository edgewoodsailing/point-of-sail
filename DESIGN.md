# Point of Sail — Design

Working design document. Expands on [OBJECTIVES.md](OBJECTIVES.md).

All open questions are resolved; [§9](#9-open-questions) records what was
settled. Ready to break into beads.

---

## 1. The core idea

A **test tank**, not a game. The boat never moves across the screen. The student
poses a situation — heading, wind direction, wind speed, sail trim — and the
simulator answers the question *"how fast would this boat go, and why?"*

Everything follows from that framing:

- No rudder, no navigation, no waypoints, no scrolling world.
- Every control is instantly reversible; there is no way to "lose".
- The only output is boat speed, and the only way to influence it is trim and
  angle. That narrowness is the point.

The intended interaction is play. A student pushes the boat around, sees the
sails go red, pulls them in, sees green, and forms the connection themselves. We
deliberately do not label, annotate, or instruct — see [§7](#7-deliberately-out-of-scope).

### The central abstraction happens to match Edgewood's boats

"Set the boat on a heading and it stays there" is the assumption the whole test
tank rests on. On most boats it's a convenient fiction — you hold a heading by
working against weather helm, and the helm is part of the feel of every point of
sail.

The school's boats carry RudderCraft rudders that are not class legal but are
computer-optimized for the hull, and weather helm is nearly eliminated: at
almost all points of sail you can release the tiller and the boat tracks
straight. So the simulator's central simplification isn't an abstraction these
students have to translate — it's close to a description of the boat they sail.
It also means a student at the helm has attention free to watch the sails, which
is the same narrowing of focus the simulator is built around.

Worth recording because it makes several later decisions cheaper: no rudder, no
weather helm, and a heading that simply holds are all more defensible here than
they would be at another school. The exceptions — overpowered, heavily heeled,
or unstable dead downwind — are cases we've scoped out for independent reasons.

### Why heading and wind are separate gestures

Physically, rotating the hull and rotating the wind are the same operation —
only the angle between them enters the model. We keep them as two distinct
gestures anyway, because they are two completely different experiences on the
water: *"I turned the boat"* versus *"the wind shifted and now my trim is
wrong."* Teaching that those feel different but mean the same thing is one of
the simulator's main jobs.

This has a rendering consequence: **the boat stays fixed in the frame and the
wind rotates around it.** When the student drags the hull, the hull rotates. When
they drag the wind, the wind arrow rotates. Both change the same underlying
number, but the animation makes them feel like different events.

---

## 2. State

The complete simulation state is small enough to fit on a napkin:

```ts
interface SimState {
  // Environment: direction the wind blows FROM, world frame, plus its speed
  wind: TrueWind;             // { from: Radians, speed: MetersPerSecond }

  // Boat: where the bow points, and the signed speed — negative is astern
  motion: BoatMotion;         // { heading: Radians, speed: MetersPerSecond }

  // Trim: sail chord angle relative to boat centerline, positive = clew to
  // starboard, zero = on the centerline. Plus whether the jib is set at all,
  // which defaults false — main alone (§3.7).
  trim: RigTrim;              // { mainAngle, jibAngle: Radians, jibSet: boolean }

  // Is the user physically forcing a sail against the wind right now?
  mainHeld: boolean;
  jibHeld: boolean;
}
```

The first three fields are **not** new types invented for the state. `TrueWind`
and `BoatMotion` come from `model/wind.ts` and `RigTrim` from `model/sail.ts`,
where they already exist as the argument types `apparentWind()` and `rigForce()`
take. Grouping the state the same way means it can be handed to the physics
without repacking at every call site, and there is one definition of "the wind"
rather than two that could drift apart. An earlier draft of this section listed
the same nine values flat; the grouping is the only difference.

That's it. No history, no session, no stored client state. A bare URL opens on a
fresh random problem, as the objectives require; a URL carrying parameters opens
on exactly what it describes — see
[§6.3](#63-url-parameters-as-the-configuration-surface).

### Conventions

| Concern | Decision |
| --- | --- |
| Angles | Radians internally, degrees only at the UI edge |
| Zero angle | Screen-up / north |
| Positive direction | Clockwise (compass convention, and matches SVG's y-down axis via `(sin θ, −cos θ)`) |
| Wind direction | Stored as the direction the wind blows **from**, the way sailors say it |
| Units | SI internally (m, m/s, N, kg); knots only for display |
| Speed sign | Positive forward, negative astern |

Fixing these early matters more than which one we pick. Sign errors in a
sailing model are miserable to debug, so the model layer will have a small set
of named helpers (`angleBetween`, `toBoatFrame`, `normalizeSigned`) and no raw
trigonometry scattered around.

### 2.1 Initial state: a random, solvable problem

The page opens on a **randomized situation with the sails visibly mistrimmed**,
so the student's first sight is a problem to either solve or ignore. This fits
the no-scaffolding position better than any label could: instead of telling a
student what to do, the simulator just presents something obviously wrong and
lets curiosity do the rest.

Randomization is bounded to keep every opening state non-degenerate:

| Quantity | Range | Why bounded |
| --- | --- | --- |
| True wind angle | 40°–160° off the bow, random tack | Excludes the no-go zone (nothing works, frustrating) and the dead run (trim barely matters, no problem to solve) |
| Wind speed | 6–14 kt | Enough to move, not a survival storm |
| Wind direction | Uniform 0–360° | The whole scene is arbitrarily oriented |
| Trim error | Random sign and magnitude, landing quality in ~0.3–0.8 | Visibly wrong, not absurd |
| Sails backed | Never | Backing is something the student discovers, not inherits |

Three details that matter more than they look:

**The trim error's sign is random**, so roughly half of opening states are
*over*trimmed. If the boat always opened undertrimmed, students would learn
exactly one rule — "pull it in when it flaps" — and never encounter the silent
failure. An overtrimmed opening state presents a boat whose sails look perfectly
fine and which is nonetheless slow. That's the harder lesson and it deserves
equal billing.

**By default there's only one sail to get wrong.** Main-only is the default rig
([§3.7](#37-sailing-under-main-alone)), so the opening problem is a single
mistrimmed main — one variable, one fix, which is the right first problem. With
the jib set, often only one of the two is wrong, chosen at random: it teaches
that they're trimmed independently, and makes the asymmetry felt, since a
mistrimmed main costs far more than a mistrimmed jib at 70% of the sail area.

**The boat starts at the steady speed for its bad trim, not at zero.** Otherwise
everything ramps from zero at once on load and the initial reading is muddy —
the student can't tell whether the arrow is short because trim is bad or because
the boat hasn't got going yet. Starting settled means the arrow is already
saying something, and fixing trim visibly improves it.

Randomizing the world orientation rather than always putting the wind at the top
is deliberate: it reinforces that only the *relative* angle matters, and the
perimeter wind arrow keeps it legible however it lands.

A nice classroom side effect: three iPads on a table means three different
problems. Students can't copy each other, but they can compare — which is a
better conversation anyway.

All of this applies to the **bare** URL. A URL carrying state parameters restores
that state instead of randomizing — see
[§6.3](#63-url-parameters-as-the-configuration-surface).

---

## 3. The physics model

Target fidelity: **qualitatively right**. Every lesson the simulator teaches
must be a true lesson. The numbers should be plausible for a Rhodes 19 but we
will not defend them to three digits.

Rhodes 19 reference figures:

| Dimension | Value |
| --- | --- |
| LOA / LWL / beam | 19'2" / 17'9" / 7'0" |
| Displacement | 1,325 lb (601 kg) |
| Draft (keel) | 3'3" |
| Rig | I=15.0, J=6.5, P=24.0, E=9.7 |
| Main area | ≈ 118.6 sq ft (11.0 m²) |
| Jib (class rules RB 21.02.04) | luff 17'0", leech 15'1", foot 7'6" |
| Jib area | ≈ 56.5 sq ft (5.3 m²) straight-edge; the oft-quoted 48.8 is just I·J/2 |
| Hull speed | 1.34·√17.75 ≈ **5.65 kt** |

The roughly two-thirds/one-third main:jib area split matters — it sets how much
of the feedback comes from each sail, and it means a badly trimmed main is much
more punishing than a badly trimmed jib. That asymmetry is worth preserving.

### 3.1 Apparent wind

Modeled always; **displayed only behind a toggle** (default off).

```text
V_apparent = V_trueWind − V_boat
```

with `V_boat` along the heading (no leeway — see [§7](#7-deliberately-out-of-scope)).
From this we get apparent wind speed and **apparent wind angle (AWA)**, measured
off the bow: 0 = head to wind, ±180 = dead downwind, sign giving the tack.

All **aerodynamic** sail forces are computed from apparent wind, never true
wind. This is what makes the model teach the right thing: it's why close-hauled
trim is tighter than students expect, and why the apparent wind moves forward as
you speed up.

**One true-wind quantity sits in the force path, and it is named here rather
than left to be discovered.** It is
[§3.2](#depowering-the-rig-stops-collecting-force-in-a-breeze)'s depowering
factor, and it is not a coefficient — it is a statement of how much sail is up.
Every *coefficient* in the model still comes from the apparent wind: the angle
of attack each sail sees, the lift and drag it makes at that angle, and the
direction those act in. What the true wind decides is only how much of the rig
the crew are still carrying, which is a decision made for the wind of the day
and not for the flow over the cloth at this instant. So the rule above is intact
in the part that teaches: a student who bears away and feels the sails need
easing is being taught by the apparent wind, at every wind speed, exactly as
before.

The exception is stated in the rule rather than left implicit in the code. It
would have been possible to leave this sentence untouched — `simulation.ts`
applies the factor outside the force assembly, so "sail forces" narrowly
construed never touch the true wind — but an exception that survives only
because of *where* a factor happens to be applied is the kind of thing that
quietly stops being true. §3.2 records why that seam was chosen; this paragraph
records that the seam is not what makes the claim honest.

When the toggle is on we draw both vectors from a common origin with the
connecting boat-speed vector, so the triangle itself is visible — that triangle
*is* the lesson.

### 3.2 Sail forces

Each sail is treated as a thin cambered foil of finite span.

**Aspect ratio** from `luff² / area`, the standard sail convention:

- Main: `24² / 118.6` ≈ **4.9**
- Jib: `17² / 56.5` ≈ **5.1**

**Lift-curve slope**, corrected for finite span:

```text
a = 2π·AR / (AR + 2)        // main: ≈ 4.45 /rad  (0.078 /deg)
```

**Attached flow** (|α| below stall, α_stall ≈ 18°):

```text
Cl = a · α, turning over at Cl_max      // the saturation below
Cd = Cd0 + (a · α)² / (π · AR · e)      // Cd0 ≈ 0.02, e ≈ 0.9
```

giving `Cl ≈ 1.4` at the stall — a realistic figure for a soft sail. The curve
does not *peak* there: it tops out at ≈ **1.63 near 24°**, which is where the
optimal-trim search actually sits at every point of sail in
[§3.6](#36-calibration-targets).

#### The attached limb has a maximum of its own

`Cl = a·α` is a straight line, and a straight line has no maximum. For a long
time nothing in the model supplied one — `Cl` reached 4.66 at α = 60°, against
the 1.2–1.6 a real cambered sail can hold — and the only thing that ever brought
the curve down was the crossfade into the flat plate. **So peak lift was not a
quantity this model held. It was an artefact of where the blend happened to
catch a ramp that was still climbing**, and it could not be moved without moving
the post-stall falloff, because they were the same knob.

That cost more than tidiness. The descent from that accidental peak was
*steeper than the attached limb's own rise* — 0.102 per degree down against
0.078 up — and a falling lift curve on a boat is a feedback loop: slowing swings
the apparent wind aft, which raises α, which past the peak cuts lift, which
slows the boat further. Where the loop closed, the boat had **two** settled
speeds at one trim and picked whichever its history led it to. `pos-i4o` found
it 2.90 kt wide, about 4° from the optimal trim, which is ordinary trimming.

So the attached limb saturates, using the same rounded-corner `min` as
[§3.2's depowering](#depowering-the-rig-stops-collecting-force-in-a-breeze):

```text
Cl_attached = a·α / (1 + |a·α / Cl_max|^p)^(1/p)      // Cl_max = 1.7, p = 16
```

Exact for small incidence, asymptotic to `Cl_max`, smooth in between. `Cl_max`
is an asymptote rather than the peak: the realised maximum is ≈ 1.63, because
the blend starts pulling the curve down before it has finished approaching. The
sharpness matters as much as the ceiling — at `p = 6` the softening reaches 4.4%
down at the stall angle, which is thin-aerofoil theory quietly ceasing to be
thin-aerofoil theory; at 16 it is 0.27% and only the top bends.

**Drag is charged against `a·α`, not against the lift actually delivered**, and
that asymmetry is doing real work rather than being an oversight left over from
before the ceiling existed. Below the maximum the two are the same number and
this is ordinary induced drag. Past it, the incidence the sail cannot turn into
lift goes into separated flow — it costs drag and pays nothing, which is what a
stall *is*. Charge the delivered lift instead and the fold comes back (measured:
0.70 kt at 3 kt of wind, 1.00 kt at 6), because the sail stops being penalised
for being oversheeted just as its lift stops answering.

**The blend is not made redundant by this**, which was worth checking, since a
limb that turns over physically might have left the crossfade with nothing to
do. It has not: with the ceiling in place and the blend left at its old 20°, the
fold returns at 2.40 kt. The stall is still the crossfade's doing. What changed
is that the two constants now govern different things — `Cl_max` the peak, the
width the falloff — where before one number did both badly. *"We gave it a
maximum, so the blend is cosmetic now" is the simplification to resist, and that
figure is why.*

**The peak is flatter than it was, and §4.2 leans on it.** Saturating the limb
does not just lower the summit, it broadens it: `Cl` is within 0.4% of its
maximum from 22.7° to 24.9°, where the old curve turned over more definitely.
That is the more physical shape — a real sail has a forgiving best trim rather
than a knife edge — but it means "the optimal trim" is a fuzzier idea than it
was, and the optimal-trim search's argmax can move by a fraction of a degree on
a rounding difference. Anything comparing a trim to *the* optimum wants a
tolerance rather than an equality.

**One lesson from finding this, which is about method rather than sails.** The
fold was hunted with a sweep over trims and winds, and a sweep can only fail to
find a counterexample — it cannot establish there is none. Three passes at this
bug reported settings as fold-free that a finer grid showed folding by 1.4 kt.
The trap has a second door that is easy to miss after you have shut the first:
sampling the *speed* axis bounds what can be seen too, and not merely how
precisely. Detecting a fold means resolving the stretch where the net force is
positive, between the unstable root and the upper stable one — not the gap
between the two stable branches, which is much wider and is the natural thing to
reason about. At a saddle-node the branches are born coalescent, so that stretch
shrinks to nothing as a fold appears: **no step size removes the band where a
fold is real and invisible; it only moves it.** `fold.test.ts` states its
resolution, shows it against a grid ten times finer, and proves it can catch the
narrowest fold this model makes rather than only an obvious one.

**Past stall**, blend over ~50° into the flat-plate model — a normal force
`Cn = k·sinα` resolved along and across the flow:

```text
Cl = k · sin α · cos α
Cd = Cd0 + k · sin²α          // k ≈ 1.1
```

The flat-plate limb is not a detail — it is what makes downwind sailing work at
all. On a dead run the sail is square to the wind at α = 90°, where lift is zero
and `Cd = k`. The boat is being pushed, not lifted, and the model should say so.

Two numbers there were settled by calibration and are worth flagging, because a
first reading of the physics gives different ones.

`k` is **1.1, not the textbook 2.0**. Two is a flat plate of *infinite* span; at
a sail's aspect ratio the flow spills round the ends and the figure is nearer
1.2, and a soft sail — twisted, its head falling off, its jib in the main's wind
shadow — comes in under that. This single constant sets the speed of a run and
nothing else in the model can substitute for it, so getting it wrong is
expensive: at 2.0 the run came out a full knot fast.

The blend is **~50°, not ~10°**, and that width is not cosmetic. A sharper stall
makes the model *bistable* on a reach — the same boat at the same trim in the
same wind settling at 3.7 kt or 5.1 kt depending on whether it started from rest
— because a sail eased for the apparent wind at speed is stalled at the apparent
wind at rest, and with a cliff at the stall it cannot climb back out.

It went 10° → 20° in `pos-fo1.4` and 20° → 50° in `pos-i4o`, and the second move
is the one that says what this constant can and cannot do. 20° was enough at the
trim the optimal-trim search finds and nowhere else; widening *inside the old
parameterisation* could not fix the rest, because it **relocated** the fold into
lighter air rather than removing it — a gentler fall closes the same loop at a
lower speed — and no width was clean at every wind while the polar still met
[§3.6](#36-calibration-targets). What made 50° work is that the attached limb
now has its own maximum, so the width governs the falloff alone. Swept at every
wind from 2 to 10 kt, 31° still folds — by 0.9 kt at 4 kt — and **32° is the
narrowest width that is clean everywhere**; 50° sits half again past that, where
the old 20° sat 1.43× past its own 14°.

**Where the search for this fix did *not* lead is worth recording**, because
both directions look plausible and cost a week each. The keel's induced drag is
not implicated: delete it and the fold gets *worse* (3.52 kt against 2.87 at
10 kt), so [§3.5](#35-hull-resistance-and-integration)'s `keelStall` — which has
no headroom anyway — is neither the cause nor the cure. And neither limb folds
on its own: a pure attached curve is monotone with nothing to feed back on, and
a pure flat plate peaks gently at 0.55. **Only the join between them has a
segment steep enough to close the loop**, which is what pointed at the
parameterisation rather than at either piece of physics.

**Force assembly.** Lift acts perpendicular to the apparent wind, drag along it.
Sum both sails, rotate into the boat frame, and take the component along the
heading as **driving force**. The lateral component is *not* discarded — see
[§3.5](#35-hull-resistance-and-integration), where the keel is charged for it.

#### Depowering: the rig stops collecting force in a breeze

Everything above scales with the square of the wind, and a rig that did only
that would sail a Rhodes 19 at nine knots in a gale. A real one stops
collecting force well before that. It heels, so the sail plan leans out of the
horizontal and presents less of itself square to the wind; the sail twists off
at the head; and the crew ease, feather, flatten and reef. So the whole rig
force is multiplied by

```text
k(W) = (1 + r^16)^(−1/16)        r = (W_true / 13 kt)²
```

which is `min(1, q_full/q)` with the corner rounded off: full sail up to 13 kt,
and above it `k` falls as `1/q`, so **the force stops growing and holds at what
it reached there**. [§7](#7-deliberately-out-of-scope) excludes heel from the
*drawing* — top-down can only hint at it — and says in the same breath that it
is paid for without being shown. This is one of the two ways it is paid for: the
force heel costs the rig, charged without an angle ever being computed, exactly
as [§3.5](#35-hull-resistance-and-integration)'s `sideForce` is four times a
bare keel's induced drag because it carries the *drag* heel produces, along with
leeway and rudder angle. Nothing here forbids computing a heel angle; what the
subsection below establishes is that doing so would make a worse boat.

**Why a term of this shape was the only one that could work.** Every force in
the model is homogeneous of degree two in speed, so
[§3.5](#the-wall-exponent-is-the-models-only-wind-scale)'s wall was the sole
source of wind-dependence in the polar — and it is a function of *speed* when
the problem is a function of the *wind*. It therefore bites hardest where the
boat is fastest, clipping a reach harder than close hauled and sliding the
upwind optimum lower as the breeze fills in. A factor on the drive has no such
problem: at any one wind it multiplies every point of sail by the same number,
which is precisely what slows the boat without bending the polar.

**It is keyed to the true wind, and that is a decision rather than a
convenience.** [§3.1](#31-apparent-wind) says sail forces come from the
apparent wind and never from the true wind, and this does not break that rule:
`k` is not an aerodynamic coefficient but *how much sail is being carried*,
which a crew choose for the wind of the day rather than for the flow over the
cloth at this instant. The alternative was measured and is worse. Keyed to the
apparent wind, a run — which has the lowest apparent wind of any point of sail
— is depowered *least*, so the run/beam ratio at 14 kt runs from 0.74 to
between 0.75 and 0.79, breaking [§3.6](#36-calibration-targets)'s "a run is
notably slower than a reach" at exactly the wind
[§2.1](#21-initial-state-a-random-solvable-problem) opens in, and the fastest
point of sail slides from TWA 95° to 110–115°.

The mechanism this stands in for was measured too, and it is also worse.
Driving `k` from the side force — the honest reading of "it heels", since
heeling moment is what runs a crew out of righting moment — puts run/beam at
30 kt between 0.97 and 1.09, a run as fast as a beam reach, and barely touches
the top speed at all: 8.82–8.86 kt against 8.91 undepowered, because the
fastest angles make little side force and escape the cap. **Heel is the right
cause; its effect has to be spread evenly to be any use.**

**The knee is sharp because the calibration table is tight.** The 10 kt broad
reach sits at 4.78 kt against a 4.68 floor — about a fifth of the 10% tolerance
[§3.6](#36-calibration-targets) quotes — so a knee soft enough to reach back
into 10 kt breaks the table outright. At an exponent of 4 it does; at 16 the
whole 4–10 kt range is unchanged to four decimal places and only 12 kt onward
moves at all. The sharpness buys the separation between the range that is
calibrated and the range this term is for.

**Where it is applied matters, and it is not inside the force assembly.**
`sail.ts` computes `k` and `simulation.ts` applies it, so `rigForce` reports the
rig at full power and nothing in [§4.2](#42-the-traffic-light)'s trim-quality
ratio ever sees it. That is deliberate. The colour divides this trim's drive by
the best trim's, and a factor common to both cancels — except against the
*floored* denominator `max(best, 0.05·q·A)`, which carries no such factor.
Scaling the forces upstream would leave that floor binding further out as the
breeze filled in: measured, the apparent wind angle below which it binds would
run from 8.2° at 10 kt to 11.5° at 20, 17.3° at 30 and 30.3° at 45, creeping the
near-no-go fade across a third of the upwind quarter in a gale. Applied at the
integrator's seam, §4.2 is left exactly as it was designed. The price is that
`rigForce` returns a force that is not the one accelerating the boat, which the
naming in `sail.ts` carries.

### 3.3 Luffing

Luffing is a *separate concept from trim quality* and must not be conflated with
it (see [§4.2](#42-the-traffic-light)).

A cambered sail needs some incidence to hold its shape. As the sail comes into
line with the flow the cloth breaks and the collapse propagates across it. Write
`d` for how far the sail is from lying along the flow:

```text
d ≥ α_full  (≈ 7°)      → sail fully drawing, no flutter
α_luff < d < α_full     → partial collapse, breaking from an edge inward
d ≤ α_luff  (≈ 2°)      → fully collapsed, no drive
```

**The thresholds are magnitudes, not signed angles**, because
[§3.2](#32-sail-forces)'s `Cl` is odd in α: the sign of α says which *face* the
flow strikes, not whether the trim is any good. A well-trimmed sail sits at
α ≈ +15° on starboard tack and α ≈ −15° on port. Signed thresholds would luff
the whole port tack exactly where starboard draws, and would take the force off
a backed sail — which is large *negative* α and must draw fully in reverse, or
[§3.4](#34-backing-a-sail)'s mooring departure stops working.

What folding about zero gives up is camber asymmetry: a real cambered sail keeps
drawing a little past nominal zero incidence, on one side only. Representing that
honestly needs memory of which side the camber has popped to, which the model
does not carry and should not grow.

**The distance `d` is measured from the nearer of the two edge-on states, not
from zero.** A sail lies along the flow twice: at α = 0, where the wind arrives
at the luff, and at α = ±180°, where it arrives at the *leech* instead — a boom
eased right out on a run, with the wind coming over the back of the sail. So

```text
d = min(|α|, 180° − |α|)
```

which is even about 90° as well as about zero.

*This was decided rather than assumed, and it could have gone the other way.*
Against it: [§3.2](#32-sail-forces) already handles α ≈ 180° correctly and
without help, giving `Cl = 0` and `Cd = Cd0` there, so nothing about the *boat*
was ever wrong and the change buys nothing measurable in newtons — it zeroes a
force that was already negligible. For it, and decisive: the collapsed fraction
is the one number that drives the flutter as well as the force, so a fraction of
zero at α = 180° is the model asserting *fully drawing* about a sail that is
flogging. The drawing would then show a sail collapsed and dead still at the
same moment, which is exactly the undertrimmed-looks-like-overtrimmed confusion
[§4.2](#42-the-traffic-light) exists to prevent. A model that needs the renderer
to paper over one of its numbers has the number wrong.

**Which trims actually get there**, since the answer is not the obvious one.
α = AWA + trim, so *easing* on a reach moves α **away** from 180°, not toward it
— on a broad reach at AWA 140° a boom right out on the shrouds sits at α = 50°.
The leech-first state needs the boom near the centreline with the wind nearly
dead astern, or the boom out on the windward side. Both are ordinary:

- **A main sheeted flat on a run.** Under-trimmed, not over-eased.
- **Sailing by the lee** — bearing away past dead downwind until the wind
  crosses behind the sail, with the boom still out on what has now become the
  windward side. At AWA −85° with the boom eased to port, α = −175°.

The second is the one that earns the change. Sailing by the lee is what precedes
an accidental gybe, and a sail that goes on looking full and drawing through it
is teaching precisely the wrong thing.

The fold costs almost nothing elsewhere. It reaches only `|α| > 173°`; the rest
of the polar is untouched by construction, and backing survives it — a backed
sail head to wind sits at α = 90°, which folds to 90° either way. The corner
`min` puts at α = 90° is not a crease in the result: 90° is more than ten times
`α_full`, so the smoothstep is saturated with zero slope on both sides of it and
the fraction is flat at zero straight through.

We compute a **collapsed fraction** ∈ [0,1] — how much of the sail has let go —
and, beside it, the **edge the collapse propagates from**: the luff or the
leech. The fraction drives both the flutter animation and the force reduction,
so what the student sees and what the boat does can never disagree. It scales
the whole force, lift and drag alike: the collapsed portion is simply not
working. *Which* portion it is does not enter the force at all — a third of the
cloth carries a third of the load whichever third it is — so the edge is a
number the drawing spends and the physics ignores.

The edge falls straight out of the fold. The two limbs of `min(|α|, 180° − |α|)`
*are* the two edge-on states: below 90° the flow is arriving at the luff and the
collapse runs aft, above it the flow is arriving at the leech and the collapse
runs forward. Reporting the fraction alone would not do, and the error it would
leave is not a sliver — the fraction is 0.35 at α = 175° and does not reach 1
until 178°, so through the first half of that band a drawing measured from the
luff would shake the forward third of a sail whose *after* end is the one
letting go. Keeping [§4.1](#41-whats-drawn)'s deformation hook honest is the
whole reason the second field exists.

The two are reported separately rather than folded into one signed fraction.
A sign would have to flip at α = 90°, which is exactly where the fraction is
zero and there is no collapse to attribute to an edge, and every consumer would
then spend a line recovering a magnitude before it could use one. As it stands,
between the bands the fraction is 0 and the edge merely names the one a collapse
*would* arrive at; the tie at exactly |α| = 90° is broken toward the luff and is
unobservable, because nothing reads the edge without also reading a fraction of
zero.

### 3.4 Backing a sail

Edgewood teaches getting under way from a mooring by physically pushing the boom
forward, so this is a first-class mechanic rather than an edge case.

Normally the wind holds the boom to leeward and the sheet stops it coming in.
A sail on the *windward* side is not a trim state — it's a state a hand is
holding. So:

- The user may drag a sail past its natural side.
- While the pointer is down, the sail stays where it's put (`mainHeld` /
  `jibHeld`), the flow attacks the other face, and the force reverses.
- Driving force goes negative, `speed` integrates negative, and the speed arrow
  flips to the stern — exactly as the objectives describe.
- **On release the sail swings across**, animated.

Holding your finger down to hold the boom out is an unusually direct mapping
between the gesture and the real physical act.

**Where it swings to.** The sail returns to the *mirror* of the angle it was at
before being pushed across — same trim, other side. This is what the sheet does
on the real boat: its length hasn't changed, so it stops the boom at the same
angle it would have on the other tack. The full mooring departure then plays out
in one continuous gesture: push the boom across, boat gathers sternway, release,
boom swings over, sail fills, boat sails off on the trim it already had.

The swing takes ~0.4 s, and **the model keeps running normally throughout** —
the sail angle is simply animating. Backward drive dies, forward drive builds,
and the speed arrow shrinks, flips, and grows again on its own. Nothing needs
special-casing, and the student sees the whole reversal as one continuous
physical event.

The jib backs by the same mechanism, which is the other classic way off a
mooring.

### 3.5 Hull resistance and integration

Resistance rises steeply approaching hull speed:

```text
R(v) = A·v² + B·v²·(v / v_hull)⁴        v_hull = 2.91 m/s (5.65 kt)
```

The fourth-power term is a shape, not a theory — it produces the wall a
displacement hull hits, the one that makes the last half knot cost far more
than the one before it. What it does *not* do on its own is keep a Rhodes 19
off nine knots in a gale; that promise was made here for a long time and is
actually kept by [§3.2](#depowering-the-rig-stops-collecting-force-in-a-breeze),
for reasons the subsection below works through. It was a sixth power until
`pos-lcz`;
[the wall exponent](#the-wall-exponent-is-the-models-only-wind-scale) below is
the decision that moved it, and it is the one place in this section where a
number was chosen against something other than the 10 kt polar.
Going astern, multiply by ≈ 2.5: transom-first with a stalled keel and rudder is
genuinely much draggier, and students should feel that backing up is slow.

**The keel is charged for the rig's side force, and that is what makes a no-go
zone.** [§3.2](#32-sail-forces)'s lateral component is not free: the keel has to
generate it, and a foil making lift makes induced drag doing so. The drag of it
goes as the square of the load over the dynamic pressure —

```text
D = k · F_side² / v²
```

— which is almost nothing off the wind and enormous close hauled, where the side
force is more than twice the drive and the boat is slowest. Without it the model
had no charge at all for sailing at a large angle to the wind: it ran 29% fast
close hauled and still made 3 kt at TWA 15°, and no resistance coefficient could
fix that, since scaling `R(v)` slows every point of sail at once while the
problem was one end of the polar.

`F²/v²` runs away at rest, and that runaway is not physics: a keel asked for
more than it can carry stalls, and the boat sideslips rather than growing an
unbounded drag. Worse, in a model with no leeway an unbounded drag would push a
sheeted-in boat *backwards* and then reverse as soon as it did. So the keel is
given a stall — the drag is scaled by how much lift the keel can hold relative
to how hard it is being asked to pull, a ratio that grows with `v²` because that
is what a foil's capacity does. That recovers `k·F²/v²` where there is capacity
to spare and a flat plate's `v²` where there is not, going to zero at rest as
any water drag must.

Both constants are honestly fudges and live in `tuning.ts` accordingly. The
scale is about four times what a 3'3" keel's own induced drag comes to, because
it is also standing in for the heel that side force produces, the leeway the
hull makes, and the rudder angle needed to hold the course — all of which
[§7](#7-deliberately-out-of-scope) declines to model separately and all of which
scale the same way. The stall ceiling turns out to be the constant that sets
where the no-go zone ends, since the whole upwind quarter runs at or just under
it.

#### The wall exponent is the model's only wind-scale

Everything else in this model is *homogeneous of degree two* in speed. Scale the
true wind and the boat's speed together by λ, and each force scales by λ²:

- **Sail force** is dynamic pressure times coefficients that depend only on
  angles. The apparent wind vector scales by λ while its angle stays put, so the
  coefficients don't move and the force goes as λ².
- **`A·v²`** is quadratic by construction.
- **The keel's induced drag** looks like the exception and isn't — worth writing
  out, because `k·F²/v²` reads like a term that breaks the scaling. Put
  `F → λ²F` and `v → λv` into `D = k·F²·v²/(v⁴ + S²)`. The saturation
  `S = k·F/(2·k_stall)` scales as λ², so the numerator gains λ⁴ from `F²` and λ²
  from `v²` — λ⁶ — while the denominator gains λ⁴ from `v⁴` and from `S²` alike.
  The ratio is λ². The `1/v²` is real, and it is cancelled by the load it
  carries.

So the balance `F_drive = R(v)` is preserved under λ, and the *shape* of the
polar does not move at all.

The wall term is the exception, because `v_hull` is an absolute speed:
`B·v^(n+2)/v_hull^n` scales by the (n+2)th power instead. That is not a detail.
Set `B` to zero and re-solve `A` to hold the 10 kt beam reach, and the polar
becomes exactly scale-invariant — a 45° upwind VMG peak, a run at 0.58 of a beam
reach, and a beam reach of 0.555 kt per knot of true wind, at *every* wind from
4 to 30 kt. **So the wall is the sole source of wind-dependence in this model,
and everything the polar does as the breeze fills in is the exponent's doing.**

Which is why the exponent is a design decision and not a knob, and why `pos-lcz`
moved it from 6 to 4 rather than the other way. The wall bites hardest where the
boat is fastest, so it clips a reach harder than it clips close hauled — and
clipping the fast angles is precisely what slides the upwind VMG optimum to a
*smaller* angle. Sharpening the wall therefore buys a slower beam reach in a
breeze at the cost of a boat that points ever higher in it, which is the
opposite of what a keelboat does. Measured, holding the 10 kt beam reach at
5.55 kt by re-solving `B` each time:

| exponent | 10 kt polar (45/90/135/180) | VMG peak, 6→14 kt | run/beam at 14 kt | beam at 20 kt | beam at 30 kt |
| --- | --- | --- | --- | --- | --- |
| 4 | 4.18 5.55 4.73 3.71 | 49° → 40° | 0.74 | 7.59 | 8.88 |
| 6 | 4.29 5.55 4.83 3.79 | 49° → 39° | 0.78 | 7.07 | 7.95 |
| 10 | 4.42 5.55 4.96 3.85 | 49° → 38° | 0.83 | 6.54 | 7.07 |
| 20 | 4.53 5.55 5.13 3.87 | 49° → 37° | 0.88 | 6.08 | 6.34 |

There is no row that keeps a beam reach at hull speed in a breeze *and* holds
the pointing angle, because within this term there is only the one knob — which
is the measurement that sent the problem to
[§3.2](#depowering-the-rig-stops-collecting-force-in-a-breeze). Holding a beam
reach at
or under hull speed at 30 kt while [§3.6](#36-calibration-targets)'s table
survives needs an exponent of about 126 — a speed clamp, not a wall — and the
pointing is long gone well before that. Pulling the 10 kt beam reach down to
make room instead fails a different way: the run sits at ≈ 3.85 kt in every
configuration, being far enough below the wall to be untouched by it, so a
slower beam reach simply breaks "a run is notably slower than a reach".

Four is that trade taken deliberately toward the range the simulator opens in.
It costs the broad reach two more points of the shortfall
[§3.6](#36-calibration-targets) already calls structural. What it buys is that
the three lessons the model exists to teach hold their shape across the 6–14 kt
[§2.1](#21-initial-state-a-random-solvable-problem) actually opens on.

The honest reading is that the wall was being asked to do a job it is the wrong
shape for, and for a while it was left doing it badly: a beam reach reached
7.59 kt in 20 kt of wind and 8.88 kt in 30, against a 5.65 kt hull speed, and a
Rhodes 19 does neither. `calibration.test.ts` pinned that as an accepted cost
rather than a target, so that it could not drift quietly in either direction
while the term that could fix it was still a bead.

That term is now
[§3.2's depowering](#depowering-the-rig-stops-collecting-force-in-a-breeze),
and it settles the question this whole subsection is about. What holds a real
Rhodes 19 down in a breeze is not extra water drag but the rig giving up: it
heels, the sail twists off, and the crew eases and feathers. That caps the
*drive* rather than clipping the *speed*, and because it acts on every point of
sail together it is the only kind of term that can slow the boat in a gale
without bending the polar. With it in place a beam reach settles at 6.37 kt in
20 kt of wind and 6.40 in 30 — and the exponent above is free to go on being
chosen for what it is actually good at, which is the shape of the polar in the
wind the simulator opens in.

**Read that table as a study of the wall by itself, because that is what it
is.** Every figure in it was measured with §3.2's depowering off, which is the
only way to see what the exponent alone does, and its two right-hand columns are
no longer what the model delivers: at exponent 4 the boat now reaches 6.37 kt
and 6.40 kt in 20 and 30 kt of wind, not 7.59 and 8.88. The comparison the table
exists to make — that sharpening the wall buys a slower reach at the price of
the pointing angle — is unaffected, since every row moves together.

**Depowering does not make room to take the exponent back up, and that was
tried.** The obvious hope is that once the cap holds the top of the wind range,
the wall is free to be sharpened again to buy back the broad reach
[§3.6](#36-calibration-targets) calls 9% light. It is not. Measured at a sixth
power with `B` re-solved to 22.5, and with depowering on at every cap from 12 to
16 kt, the run/beam ratio at 14 kt lands at 0.765–0.780 against a bound of 0.75
and the VMG peak falls to 39°. The reason is structural: those two failures live
at **14 kt**, which is where the cap is only just beginning to bite, so no
setting of it can reach back far enough to help without breaking the 10 kt table
on the way. Four stays.

**Speed is integrated, not solved.** Each frame:

```text
a = (F_drive − R(v)) / m_effective
v += a · dt
```

with `m_effective` — boat + two crew + ~15% added mass ≈ 880 kg, which is a
sanity check on the figure rather than its source; see the lag knob below.
Three reasons to integrate rather than solve for equilibrium:

1. Apparent wind depends on speed and speed depends on apparent wind. Integration
   resolves that feedback loop for free; a fixed-point solve has to iterate.
2. Negative speeds fall out naturally, which matters for [§3.4](#34-backing-a-sail).
3. Snapping instantly to a new speed looks wrong. A keelboat takes ~10 s to
   accelerate to hull speed, and that lag is itself a lesson — trim changes don't
   pay off instantly.

The boat still doesn't *translate*; only the speed number evolves.

**One numerical wrinkle: the resistance is taken implicitly.** Written exactly as
above, each step charges the resistance the boat felt at the *start* of the
interval, and against a fourth power on top of a square that error compounds
badly. Trimmed for the wind it was in, the boat used to stop settling at around
80 kt — a tenth-of-a-second step alternating between two speeds forever — and by
120 kt it diverged to `NaN`, permanently, since every later step adds to it.
(Those thresholds were 55 kt and 85 kt while the wall was a sixth power; a
gentler curve is a gentler thing to linearize.)

**Since [§3.2](#depowering-the-rig-stops-collecting-force-in-a-breeze)'s
depowering, no wind reaches that failure at all**, and it would be dishonest to
leave the paragraph above reading as a live threat. The drive is capped at its
13 kt value, so the boat stops accelerating with the wind — re-trimmed for the
gale it is in, it settles at 6.38–6.40 kt whether it is given 55 kt of wind or a
thousand, and carrying a trim found in 10 kt it settles at 4.40–4.50 kt. At
either, the naive step and the implicit one agree to six decimal places with no
overshoot between them. The step stays
implicit anyway, for two reasons that have nothing to do with which winds are
reachable today: it costs a single extra term, and what makes the failure
unreachable is now a *tuning constant* — raise `DEPOWERING.fullPowerWind` far
enough, or take the cap out to try something else, and the fourth power is
waiting exactly where it was. The guard is cheap and the trap is one line of
`tuning.ts` away, which is the wrong margin to run without one.

So the step linearizes the resistance about the current speed:

```text
v += (F_drive − R(v)) · dt / (m_effective + R′(v) · dt)
```

Same equation to first order — at 60 Hz the correction is about a percent and
the trajectory matches the naive form to three figures — but the faster the
water would answer, the smaller the step it takes, so the speed can't run away
from a curve climbing faster than the step can see. The fixed point is still
exactly `F_drive = R(v)` and doesn't depend on `dt`.

It does *not* make overshoot impossible: the step follows a tangent to a convex
curve, so it aims slightly beyond the balance point. What makes that harmless is
that resistance grows faster than linearly, so a speed past the balance point
meets a restoring step larger than the one that took it there, and overshoots
decay instead of feeding themselves. This clause used to end "and in a gale not
slightly at all", which was true of the boat that could reach 12 m/s in a gale
and is not true of one whose drive is capped: from rest in 200 kt the first step
is now 0.06 m/s against a balance of 3.29, and the approach is monotone.

**`settle()` runs real frames, and that is not an oversight.** Long steps look
free — where resistance dominates, the update becomes a Newton step and lands in
ten iterations rather than three hundred — but the *drive* is not in the
linearization, and it can fall with speed faster than resistance rises. Then a
long step isn't a step toward anything: at five seconds, a sloop in 10 kt at
TWA 105 with the sails eased to 80° alternates between 1.667 and 1.834 m/s
forever, 46 N out of balance. Frame-length steps have an argument rather than a
survey behind them — the underlying equation is a one-dimensional flow, so speed
moves to the nearest balance point and stops, because there is nowhere else to
go — and the tests assert the balance itself, not just that the number stopped
moving. The cost is iterations, which are cheap.

**The lag is the tuning knob; the mass is derived from it.** What
[`tuning.ts`](#6-architecture) exposes is the thing anyone can judge by watching
— *time to reach ~63% of terminal speed from rest*, starting at **10 s**, about
right for a keelboat. `hull.ts` inverts the closed form `v(t) = v_t·tanh(t·A·v_t/m)`
to get `m_effective` from it, so that calibrating the resistance can't move the
lag out from under us. The anchor holds at the reference speed and stretches away
from it: the lag works out as `10 s · v_hull / v_terminal`, so a calibration pass
that leaves the boat settling slower will also leave it a little slower off the
mark. If it reads as sluggish when comparing two trim settings back to back, we
shorten the time; it's a feel decision to be made against the running thing.

Before calibration this landed at ≈ 877 kg, agreeing with the 880 kg estimate
above to within 1% — two routes to one number, and the reason that estimate is
quoted as a sanity check rather than used as an input. Calibration raised the
resistance by a quarter and carried the derived mass to ≈ **1092 kg** with it, so
the two now differ by 24%. That is the anchor stretching rather than breaking,
and the ten seconds was kept rather than shortened to hold the mass down: the lag
is the thing anyone can judge by watching and the mass is the thing nobody can,
and a pass fitting a polar has no business deciding how the boat should feel.
Read the gap as the boat feeling slightly heavier off the mark than its
displacement argues for, or as the resistance sitting at the top of its plausible
range; the evidence doesn't distinguish them. `hull.test.ts` holds the derived
mass to 600–1200 kg, so a pass that needs more room has to say so out loud.

#### Quadratic drag has no slope at rest, and that gives the no-go zone an edge

Both charges above vanish at least as fast as `v²` — the hull's quadratic term
and the wall on top of it, and the keel's induced drag, which goes as `v²` at
low speed where the stall term dominates the denominator. So at rest they are
not merely small: they are zero, and so is their *slope*. That has a consequence
at exactly one place in the polar, and it is worth writing down because it looks
like a bug and is not.

At the true wind angle where the drive from rest passes through zero — the edge
of the no-go zone — rest is a balance point. Whether it is a *stable* one is
decided by the drive's own slope, unopposed, since the water contributes none.
That slope is positive: the moment the boat has way on, the apparent wind hauls
forward, the angle of attack comes down off the stall, and the sail makes more.
Measured at that boundary it runs 3.5 to 15.4 N/(m/s) across 4–30 kt on both
rigs. So rest there is **unstable**, and the boat runs away from it — astern if
it started astern, ahead if it started ahead — until the quadratic drag catches
up a couple of tenths of a knot out.

Which is to say the model reproduces the reason a boat has to be pushed off a
mooring: below some speed it cannot generate the drive to get going, and above it
it can. [§3.4](#34-backing-a-sail)'s whole mechanic is that fact. Having it also
mean that one hairline of angles has two answers is the same fact seen from the
other side.

**It is bounded and it is small.** The band is half a degree of TWA wide at trim
0 and needs the sheet almost exactly flat: it survives a quarter of a degree of
ease, at a slightly wider angle and a smaller split, and half a degree is clean.
Swept across §5's whole wind slider at a tenth of a knot, both rigs and every
trim the sheet can hold, the widest split is 0.699 kt and the fastest either
branch ever reaches is 0.482 kt, both on the sloop sheeted flat at TWA 64.88° in
12.8 kt — the peak sits at [§3.2](#depowering-the-rig-stops-collecting-force-in-a-breeze)'s
13 kt knee, where the drive stops growing with the wind and the water's scale
does not.
The boat is stopped on both branches, so nothing that is sailing has two answers.
`fold.test.ts` locates the boundary by bisection rather than by sweeping for it
and holds those two figures.

**Three ways out, all rejected, and the measurements are the point.**

- *Move the stall blend.* It is a real lever, in the opposite direction from the
  obvious one: narrowing drops the band to a smaller angle and widens the split
  (20° → TWA 36°, 1.59 kt), widening pushes it up and shrinks it (70° → TWA 87°,
  0.265 kt) and 80° removes it. It costs nothing against
  [§3.6](#36-calibration-targets) — the polar at optimal trim moves under 0.02 kt
  out to 80°. It is spent entirely out of
  [§4.2](#42-the-traffic-light)'s account, exactly as `tuning.ts` warns. Sheeted
  flat in 10 kt, settled from rest: at the shipped 50° the boat makes 1.20 kt at
  TWA 60°, drifts astern at 75° and sits still at 90°; at 80° it makes 2.60,
  2.01 and 1.22 kt. Buying away "sheeted flat is a mistake" to remove a 0.699 kt
  wobble at a standstill is the wrong trade.
- *Give the water a slope at rest.* A linear damping term would do it, and needs
  `C > 15.4 N/(m/s)` to beat the drive. At 1 kt that term alone is 8.2 N against
  the hull's 7.4 — it more than doubles the resistance at a knot, recalibrates
  the whole light-air end, and introduces a second absolute speed scale, which
  falsifies [the wall exponent](#the-wall-exponent-is-the-models-only-wind-scale)
  being the model's only source of wind-dependence.
- *Flatten the stalled sail.* `FOIL.plateNormalForce` does nothing here at all —
  identical band at every value from 0.7 to 1.6.

So it stays, recorded rather than fixed (`pos-rem`). It is also not new: on the
pre-`pos-i4o` curve the same band sat at TWA 36.3°–37.5° and split 2.934 kt with
a 2.498 kt fast branch — a boat genuinely sailing on one of them. Giving the
attached limb a maximum shrank it more than fourfold and moved it to where both
branches are a standstill, which is the most any of these constants can do.

### 3.6 Calibration targets

Constants get tuned until the polar hits roughly these marks in 10 kt true:

| Point of sail | TWA | Sloop | Main only | **Model (sloop)** |
| --- | --- | --- | --- | --- |
| Head to wind | 0° | 0 (in irons) | 0 (in irons) | **0** |
| Close hauled | 45° | ≈ 4.2 kt | ≈ 3.2 kt | **4.19 kt** |
| Beam reach | 90° | ≈ 5.4 kt | ≈ 4.6 kt | **5.58 kt** |
| Broad reach | 135° | ≈ 5.2 kt | ≈ 4.4 kt | **4.78 kt** |
| Run | 180° | ≈ 3.5 kt | ≈ 3.0 kt | **3.71 kt** |
| **Closest useful angle** | — | **≈ 45°** | **≈ 55°** | **44°** |

Beam reach fastest, run notably slower, and a no-go zone that simply *is* rather
than being drawn on. These are the model layer's unit tests, in
`calibration.test.ts`.

The right-hand column is where `pos-fo1.4` left the sloop and `pos-lcz` last
moved it; every figure is inside the ~10% the targets are quoted to. Two of them
are worth reading rather than just checking.

The **broad reach is 8% light, and structurally so.** The table puts a beam reach
and a broad reach 0.2 kt apart while the driving force at 135° is barely half
what it is at 90° — that needs resistance going as `v¹⁰`, and this section's
curve is a square under a fourth power, which tops out at `v⁶`. No further tuning
closes that gap.

It used to read that "a different resistance curve would", and that was too
generous to the resistance. A steeper wall does close some of it — at a sixth
power this figure was 7% light and at a twentieth it is 1% — but
[§3.5](#the-wall-exponent-is-the-models-only-wind-scale) shows what that costs:
the wall is the model's only wind-scale, so steepening it to buy the broad reach
sends the pointing angle through the floor as the breeze fills in. `pos-lcz`
went the other way and spent two points of this figure to hold the pointing,
leaving about one point of margin against the tolerance.

It then used to read that what was wanted was a term acting on the *drive*, and
that `pos-d7u` would be it. That has landed, and it did **not** buy this figure
back — which is worth recording rather than quietly deleting, because it was a
reasonable guess and it was wrong.
[§3.2's depowering](#depowering-the-rig-stops-collecting-force-in-a-breeze) is
exactly such a term and it cannot help here, for the same reason it is useful
everywhere else: it is a single factor multiplying the whole rig, so at any one
wind it scales a broad reach and a beam reach by precisely the same amount and
their *ratio* does not move at all. It also sits at 1.000 in 10 kt by
construction, so it is not even present in this table. Closing this gap needs
something that changes the *shape* of the force curve rather than its scale —
the sails' own coefficients, or a resistance curve steeper than §3.5 can
afford — and until something does, 8% light is where the broad reach stays.

`pos-i4o` bought a point of it back, and by exactly the route this paragraph
predicts rather than by tuning harder: giving the attached limb a maximum of its
own ([§3.2](#the-attached-limb-has-a-maximum-of-its-own)) changes the *shape* of
the lift curve rather than its scale, which is the one kind of change that can
move a broad reach relative to a beam reach. It was not done for this figure —
it was done to stop the boat having two settled speeds at one trim — and a point
is all it is worth. The gap remains structural.

The **closest useful angle is read as the peak of upwind VMG**, which is what a
sailor means by it and what a test can check. It came out at 30–35° before
calibration — a boat that points like nothing afloat — and the constant that
moved it is the keel's stall ceiling in [§3.5](#35-hull-resistance-and-integration).

The **main-only column is not yet met** and is not this section's to meet: it
belongs to [§3.7](#37-sailing-under-main-alone)'s upwind bonus, which changes
the sloop numbers too and so has to recalibrate against this table.

**This table is one wind speed, and the model knows it.**
[§2.1](#21-initial-state-a-random-solvable-problem) opens anywhere in 6–14 kt and
[§5](#5-direct-manipulation) gives the wind a slider without saying where it
stops — today's scaffolding offers 0–30 kt — so the three qualitative lessons
have to survive a range the table says nothing about. `pos-lcz` narrowed the
drift to where the same bounds hold across the whole opening range, and
`pos-d7u`'s depowering then stopped the *pointing angle* drifting above it:

```text
wind      4     6     8    10    12    14    16    20    30    45
angle    50°   48°   46°   44°   42°   41°   41°   41°   41°   41°
run/beam 0.53  0.57  0.62  0.67  0.71  0.74  0.76  0.79  0.83  0.86
beam kt  2.93  4.08  4.93  5.58  6.10  6.34  6.36  6.37  6.40  6.41
k        1.00  1.00  1.00  1.00  0.995 0.857 0.660 0.422 0.188 0.083
```

The bottom row is [§3.2](#depowering-the-rig-stops-collecting-force-in-a-breeze)'s
depowering factor, and the shape of the table is its doing. Through 10 kt it is
0.99999 and every figure is the undepowered one to four decimals; at 12 kt it
has taken a tenth of a percent; from 14 kt the rig stops collecting force and
the boat stops accelerating. The closest useful angle stays inside 40–50° at
every wind from 4 kt to 45 — the same band the 10 kt test pins — where before
`pos-lcz` it ran to 39° by 14 kt and before `pos-d7u` it went on to 33° by 30 kt.

**Why the angle row went flat is worth spelling out, because "the boat is
slower so the wall bites less" is the obvious explanation and it is not the
one.** [§3.5](#35-hull-resistance-and-integration) says the keel's stall ceiling
is what sets where the no-go zone ends, and that ceiling is a *ratio* — the
largest fraction of the side force the keel can charge as drag, 0.22. A ratio is
invariant under scaling the side force, so depowering cannot move it: measured
close hauled, the keel charges 0.2170 of the side force in 10 kt, 0.2139 in 12,
0.2143 in 14, 0.2170 in 16, 0.2197 in 20 and 0.2190 in 30 — **97–100% of the
ceiling at every wind**, where before it sat there only at the wind it was
calibrated in. Hold
the boat's speed still and scale the force, and the upwind end of the polar
stops moving because the constant that governs it has nothing left to respond
to. That is the mechanism behind the 41–42° row above, and it is the reason
depowering fixed the *pointing angle* rather than merely capping the speed.

**The run/beam row still drifts, and it is worth being clear that depowering was
never going to stop it.** A uniform factor scales a run and a beam reach by the
same number, so it cannot move their ratio at any one wind; what moves the ratio
across winds is that the boat's speed is now pinned while the wind keeps
rising, so the apparent wind draws further aft at any given point of sail and
the run gains on the reach. 0.87 at 45 kt is a real boat in a real gale, and the
lesson the tests pin — a run under 75% of a beam reach — holds across the whole
opening range, which is where §2.1 puts the student.

**The 14 kt knife edge is gone, and it is the clearest thing depowering
bought.** This section used to warn that the figure landed on 40° against a
bound of 40° with no margin, and that buying a degree back by nudging the keel's
stall ceiling had been considered and declined because it would move the boat to
make a test comfortable. The peak is a discrete argmax over a very flat maximum
— the winning degree beats its runner-up by between 0.01% and 0.09% across the
opening range — so at 14 kt a rounding difference could flip the answer to 39°
and turn the suite red with nothing having changed. It is now 41°, winning from
40°, so both are inside the bound, as they already were at every other wind.
The flatness is unchanged; what moved is where the pair sits.

**The beam reach in a lot of wind is fixed, and that was `pos-d7u`'s whole
point.** It reads 6.37 kt at 20 kt of wind and 6.40 at 30, against a 5.65 kt
hull speed — 12% and 13% over, where before it was 34% and 57%, and where before
`pos-lcz` it was 25% and 41%. Not *at* hull speed, and deliberately not: a beam
reach is the one point of sail a displacement boat holds a little past it, and
this section's own 10 kt figure is already 5.55 kt against a 5.65 kt hull speed,
so there was never room to cap much harder without taking this table with it.
The honest cost is on the last row of the table above — above about 13 kt the
wind slider stops making the boat faster, because that is what a capped rig
means.

The last row matters as much as the speeds. Main-only falls off *hardest close
hauled* — roughly 24% down at 45° versus 15% at a beam reach — and it also can't
point as high at all. Both are the job of [§3.7](#37-sailing-under-main-alone),
and the pointing figure is the one a student actually sees.

### 3.7 Sailing under main alone

Edgewood's Level 1 class teaches its first six lessons with **no jib**, so that
the student on the helm has complete control of the boat and their feedback
isn't confounded by someone else's trimming. The simulator must be able to match
that boat. `jibSet: false` strikes the jib entirely: not drawn, not draggable,
contributing no force.

**Main-only is the default.** It's the boat six of the first lessons actually
sail, and it opens on the simplest possible problem: one sail, one variable, one
fix. The discoverability worry — that a student might never find the jib toggle
— answers itself, because the students who want a jib are exactly the ones with
enough experience to notice it's missing and go looking for it. The control
doesn't have to advertise itself to beginners who wouldn't know what to do with
it; it only has to be findable by someone already asking the question. That's a
much weaker requirement, and it means the toggle can stay as quiet as the rest
of the UI.

This is not a rendering toggle. Three things change, and one of them requires
reopening a decision.

**Area.** Main-only drops the rig from ~167 to ~118.6 sq ft, about 71%. Since
resistance goes as v², speed scales roughly as √0.71 ≈ 0.84 — the boat is
noticeably but not dramatically slower. That much falls out of the model for
free.

**Pointing — and this is where the model as designed would lie.** A real sloop
under main alone cannot point as high. Ask any student who has sailed the first
six lessons and then had a jib added: the boat suddenly goes upwind
*better*, not just faster. But in the model as specified, striking the jib
removes area uniformly and the no-go zone doesn't widen at all, because the
angle at which drive goes to zero is set by the foil's lift-to-drag ratio, not
by how much sail you have. Main and jib have nearly the same aspect ratio here
(4.9 and 5.1), so removing one barely shifts the average efficiency. The
simulator would show main-only as *slower everywhere and no worse upwind*, which
is precisely the wrong lesson for the class this feature exists to serve.

The reason a real boat behaves otherwise is the **slot effect** — the jib's
leading edge sits in undisturbed air and the flow through the slot keeps the
main attached — which [§7](#7-deliberately-out-of-scope) rules out in general.
That ruling is reversed here, in minimal form:

> A single scalar bonus on the main's lift when the jib is set and drawing,
> largest close hauled and tapering to nothing by a broad reach.

Perhaps ten lines. It is unashamedly a fudge — no flow is being modeled — but
it's a fudge in service of the fidelity target, which is that every lesson the
simulator teaches must be a true lesson.

**Why this constant must never be tuned to zero.** Students ask, in so many
words, *why bother with the jib if I can sail perfectly well without it?* This
bonus is the entire answer. Without it the simulator not only fails to answer
the question, it actively corroborates the wrong conclusion — jib and no jib
would differ by a bit of speed and nothing else, and a student comparing the two
would come away confirmed in the belief the feature exists to correct.

So it should be tuned to be **plainly visible, not subtle**: on the numbers in
[§3.6](#36-calibration-targets), setting the jib is worth ~24% upwind speed and
about 10° of pointing. A student who toggles it should not have to squint.

**Weather helm we don't show — and at Edgewood, largely don't need to.**
Striking the jib moves the center of effort aft, and a stock Rhodes 19 responds
by rounding up into the wind. Our boat has no rudder and its heading is whatever
the student sets, so there is nowhere for that force to go.

On most boats that would be a real gap between the simulator and the water. It
mostly isn't here: the school's RudderCraft rudders — not class legal, but
heavily optimized for the hull — have nearly eliminated weather helm, and at
almost all points of sail the boat tracks straight with the tiller released.
The balance shift from striking the jib is largely absorbed. A student who
sails main-only at Edgewood does not experience it as *harder to steer*, which
is exactly what the simulator will show them.

This doesn't touch **[Q7]**: losing the jib's pointing ability is aerodynamic,
not a question of helm balance, and it still needs modeling.

**A pleasing coherence.** Backing the boom to get off a mooring
([§3.4](#34-backing-a-sail)) is taught in Level 1 — on a main-only boat. The two
features land in the same lesson, and the sim can now show that lesson exactly
as it's taught.

---

## 4. Visual design

Top-down 2-D line drawing, SVG, abstract but proportioned like a Rhodes 19.

### 4.1 What's drawn

- **Hull** — a simple outline, beam-to-length ≈ 7:19. Deliberately abstract.
- **Mast** — a dot at the hull's mast station.
- **Main** — the boom drawn as a straight line from mast to clew (the chord),
  with the sail bulging leeward of it as a Bézier arc.
- **Jib** — no boom, so just a curve from its tack to the clew. Absent entirely
  when `jibSet` is false.
- **Standing rigging** — **not drawn.** See below.
- **Wind ring** — outside the boat, at the perimeter (see [§5](#5-direct-manipulation)):
  a thin full circle marking the whole draggable track, an arrow at the wind
  bearing with its tail on the ring and its head flying inward the way the wind
  blows, and seven short graduations every 45°.
- **Speed arrow** — a little clear of the bow, or of the stern when speed is
  negative. Length grows with speed; colored per [§4.3](#43-the-speed-arrow).
- **Apparent wind overlay** — only when toggled on.

Camber depth is a function of trim and apparent wind pressure. When the collapsed
fraction is non-zero, a traveling sine wave is superimposed on the collapsed
portion — amplitude scaling with how deeply it's luffing, and the fluttering
region spreading across the sail **from the edge the flow arrives at**
([§3.3](#33-luffing)): aft from the luff in the ordinary case, forward from the
leech when the wind is coming over the back of the sail. A sail that is *just*
starting to break shows a small ripple at that edge only, which is exactly what a
student should learn to spot.

The ripple is three waves across the chord at 3 Hz, scaled to 4% of the chord —
a quarter of full camber, so a shaking sail can never be read as a drawing one.
Measured on the binding case, the jib on a 320 px phone, a wholly collapsed sail
shivers 4.4 px peak to peak against a 2.2 px stroke; a sail 35% gone shivers 1.6
px. **The largest ripple is not the flogging one**: the amplitude envelope tops
out 5% higher, reaching 0.945 at the cross-fade midpoint described below,
`collapsedFraction = 0.95`, and a tenth of the way aft, where the end taper stops
biting — so the biggest thing the drawing shows is 4.61 px on that jib and
5.96 px on the main. That is the value at the taper's corner rather than the
supremum, which sits `2.2 × 10⁻⁶` higher and a hair inside the taper, because
`smoothstep`'s slope is zero *at* saturation and not near it. Nothing physical
turns on 2.2 × 10⁻⁶ — about 10⁻⁵ px — but the figure is derived rather than
sampled, and a derived figure is worth quoting accurately.
It **travels with the flow** at one chord a second, so the ripples run aft
when the wind arrives at the luff and forward when it arrives at the leech, and
the jib's clock is offset from the main's so two flogging sails do not read as
one mechanism. Both ends of the drawn chord are attachments — the mast or the
jib tack, and the clew — so the amplitude tapers into each over a tenth of the
chord: the flutter grows out of its fixings rather than spiking off them.

**Under `prefers-reduced-motion: reduce` the ripple is held at a fixed phase
rather than removed.** The flutter is a *reading*, not an ornament — it is what
keeps [§4.2](#42-the-traffic-light)'s two red states apart, since undertrimmed is
red and fluttering while overtrimmed is red and dead still — so a still crinkle
still says "this sail has let go" with nothing on the page moving.

#### How the camber is drawn

The offset from the chord runs along `perpendicular(chordDirection)` — 90°
clockwise of tack→clew — scaled by a signed depth:

```text
depth = chord · MAX_DRAFT · (1 − collapsedFraction) · pressureFactor(q) · sin α
```

**Signing it with `sin α` is what makes "bulges to leeward" a fact rather than a
check.** Since `flowBearing = chordBearing + α`,

```text
dot(perpendicular(chordUnit), flowUnit) = cos(90° − α) = sin α
```

so the offset's dot product with the direction the wind blows *toward* is
`|depth|·|sin α|` — non-negative at every trim, on either tack, by construction.
`render/sail.test.ts` asserts it over a grid instead of at spot checks.

Note what that says about a phrase it is easy to get backwards: **crossing the
centreline does not flip the bulge — crossing the wind does.** A boom swept from
port to starboard under a beam wind keeps its belly to leeward the whole way.

The invariant is against the *flow*, not against lift. The two agree wherever the
flow is attached, but the flat-plate limb of [§3.2](#32-sail-forces) makes
`Cl = 2 sinα cosα`, which reverses at |α| = 90° where the belly does not.

Using `sin α` whole rather than only for its sign is a *depth* decision rather
than a knife-edge one. That is a correction to what this section used to say, and
the thing that changed was [§3.3](#33-luffing) rather than the drawing: this
passage was written when the fraction folded about zero alone, and pos-aa2 folded
it about 90° as well. Both knife edges are now carried by the fraction:

- **α → 0** — edge-on and luffing. `(1 − collapsedFraction)` is *identically* 0
  across |α| ≤ 2°, so the side flip at the luff happens in the middle of a band
  of exactly flat sail.
- **α → ±180°** — the flow arrives at the leech instead, a flogging sail making
  nothing. §3.3 collapses the sail here too, so the term is identically 0 across
  |α| ≥ 178° and this flip is equally invisible. It was not always: before
  pos-aa2 the fraction was blind to this state and called such a sail fully
  drawing, and `sin α` was the only thing standing between the drawing and a
  maximum-amplitude pop in a state a student reaches by easing on a run.

So `sin α` is no longer load-bearing at either edge, and it stays for what it
does *between* them — setting the depth by incidence. Measured on the main at
saturated pressure, the drawn camber is 0.058 m at α = 7°, 0.122 m at 15° and
0.473 m at 90°; with only the sign it would be 0.473 m at all three, which is
full camber on a sail 7° off luffing and close hauled indistinguishable from a
beam reach. `render/sail.ts`'s module docblock carries the measurement.

That visible consequence is chosen deliberately: a close-hauled sail reads
distinctly flatter than a reaching one, which is true on the water. The pressure
term is a *floor near calm*, not a growth law — a real sail in 15 kt is flatter
than the same sail in 5 kt, because you flatten it — so it saturates by 8 kt and
only bites in a drifter.

The curve is a genuine cubic Bézier with its handles at exactly 1/3 and 2/3
*along the chord*, which makes the chordwise coordinate `u(t) ≡ t` identically:
the curve parameter **is** the chord fraction. That is what lets the renderer
emit the bare Bézier when nothing is deforming the sail and a sampled polyline
when something is, with the samples lying exactly on the same curve rather than
near it.

**The deformation seam.** `sailPathData` takes an optional per-point hook, which
is what [§4.2](#42-the-traffic-light)'s companion — the flutter animation — hangs
on. Three properties of it are load-bearing and should not be traded away:

- Its chord fraction `s` runs 0 at the luff to 1 at the clew, and is a position
  on the **drawn chord** rather than on the collapse's own axis — a travelling
  wave's phase depends on that map staying monotone. **Do not read the
  fluttering region as `s < collapsedFraction`.** [§3.3](#33-luffing)'s fraction
  runs in from whichever edge the flow arrives at, so that form shakes the
  forward end of a sail whose *leech* is the end letting go, every time the wind
  is over the back of the sail. The region is `collapseAt(shape, s) > 0`, where
  `render/sail.ts`'s `collapseAt` reports how deep into the collapse a chord
  fraction lies: 0 outside it, 1 at the breaking edge, the same in either band.
- It returns a **replacement, not an addend**, so the flutter can flatten the
  collapsed portion *and* ripple it —
  `offset · (1 − collapseAt(shape, s)) + ripple(s)` — which is what "the
  fluttering region spreads from the breaking edge" requires.
- It is **never called at the endpoints**. The tack and clew are physical
  attachments, and the clew is a grab point ([§5](#5-direct-manipulation)), so no
  animation can walk a touch target off the drawn sail.

**Detached, then unsupported.** `collapseAt` is an *aerodynamic* ramp: it
measures depth into the **detached** region, which is where a partly collapsed
sail really does shake — the flow has left the cloth at the breaking edge and is
still attached further along. At **full** collapse there is no pressure gradient
left to measure, and the ramp goes on peaking at the edge the collapse arrived
from, which for a luff-first collapse is the end pinned to the mast. A sail
flogging head to wind moves most at its **unsupported** edge, the leech, because
nothing is holding it. Both are real behaviour in different regimes, so the
flutter uses each where it is true: pos-dmg.2 cross-fades the amplitude ramp from
`collapseAt` to a plain chord fraction — 0 at the luff, 1 at the leech — over
`collapsedFraction ∈ [0.9, 1]`. This section left that decision to the animation
and the animation made it; what follows is what it costs.

**Two things stop 0.9 being a magic number, and they are what make the
cross-fade cheap enough to be worth it.** Below the onset the weight is
*exactly* 0, because `smoothstep` clamps — so every partial collapse, which is
the whole of what this section is about, is left byte for byte where `collapseAt`
puts it, with no ripple outside the collapsed region at all. And on the
leech-first limb the cross-fade is the **identity**, not a mirror: at full
collapse from the leech, `collapseAt(shape, s)` already *is* `s` — 0.25 reads
0.250, 0.90 reads 0.900. The onset itself is |α| = 2.98°. So the entire effect of
this constant is one case: a sail head to wind, on the luff limb, where
`collapseAt` is `1 − s` and would otherwise shake the sail hardest against its
own mast.

Two consequences are worth writing down rather than discovering.

- **The mixture has to be normalised.** On the luff-first limb the two ramps
  point at opposite ends, so mixing them cancels: halfway across, the raw
  mixture is nearly flat at half height, and the ripple would shrink by a third
  and swell again as a boat came head to wind. Dividing by the mixture's own
  peak — which is available in closed form, since it is piecewise linear in `s`
  and its only interior breakpoint is the collapse boundary — holds the
  amplitude while letting the shape slide, and leaves a residual dip of 5.3%.
  What that draws is a progression rather than a swap: the sail breaks at the
  luff, the shake spreads over the whole cloth, and once the chord is wholly
  gone it concentrates at the leech. `render/sail.ts` exposes that normalised
  ramp separately from the envelope, because it is the only form in which the
  closed form can be *checked*: the envelope multiplies it by the collapsed
  fraction and by the end taper, and both bite hardest exactly where the ramp
  peaks, so sweeping the envelope tops out around 0.945 and would wave through a
  normaliser understated by 5%. Swept on the ramp itself it reaches exactly 1.
- **A little ripple overhangs the boundary.** The chord-fraction term is not
  gated on the collapsed region, so above the onset it reaches onto cloth §3.3
  still calls drawing. At the points actually drawn the worst case is 0.217 of
  peak — 2.2 px of amplitude on a 1024 px iPad, on the single sample at
  `s = 0.969`, at α = 2.55°, where 96.6% of the sail has gone and the drawn
  camber is 0.65 mm. Gating it would trade that smear for a discontinuity in the
  drawn shape at the boundary, which is worse. `render/sail.test.ts` measures the
  overhang rather than arguing it away.

**What the flutter costs per frame, and what that does not establish.** The
animation lives in the sail layer's own `requestAnimationFrame` loop rather than
in `Layer.update`, because `update` is called when the *state* changes and a
travelling wave has to move when nothing changes. The split is where the cost is:
`update` caches the frame's `rigDrawing` — 55 µs for the rig, nearly all of it
[§4.2](#42-the-traffic-light)'s optimal-trim search — and the loop only re-emits
the two path strings, measured at 27 µs for both cloths against 2 µs for two
sails drawing. **And no frame is scheduled at all unless something is
collapsed**, so the ordinary case costs nothing rather than a little. Those are
node measurements of JavaScript; they say nothing about SVG parsing, layout or
rasterisation on a tablet, which is the half no test in this repo can reach.

**Weight and colour.** The sailcloth is the heaviest line in the drawing —
heavier than the hull, and heavier than the boom, which is only a spar. That is
not emphasis for its own sake: [§4.2](#42-the-traffic-light) paints this stroke
with the trim-quality ramp, and a hull-weight line cannot carry a five-stop ramp
on a tablet seen at an angle. Filling the lens between boom and curve would carry
it better still and is disqualified, because the lens has zero area exactly when
the sail is fully luffing — exactly when the light is red. The ramp reaches the
stroke through a `--pos-sail-ink` custom property set on each sail's group, so
the colour runs through the CSS parser rather than a presentation attribute
(§4.4), with plain ink as the fallback.

A struck jib is hidden by class rather than by a `display` presentation
attribute. This is the *inverse* of §4.5's belt-and-braces argument for
`vector-effect`, and deliberately: `display: none` is universally supported, so
there is no missing-support failure to guard against, while a presentation
attribute loses to any CSS rule that later touches the same property. `display:
none` is also genuinely absent from painting, hit-testing and the accessibility
tree, which is what "absent entirely" has to mean.

#### Why no standing rigging

An earlier version of this section drew the headstay, on the argument that it
kept the boat reading as a sloop with its jib struck rather than as a different
boat. That argument doesn't survive contact with the drawing.

The boat has **six stays**, and drawing exactly one of them misrepresents the
rig. Worse, it asks the viewer to care about a stay's *horizontal span*, which
is not a thing anyone thinks about while sailing — this is a roughly deck-level
drawing, at least for the parts that don't move, and a stay is very nearly
vertical. The headstay in particular then lands on a genuinely confusing
detail: it meets the deck at the stemhead, an inch from the tip of the bow,
while `J` measures to the jib's *tack*, which rides about a foot up a stay that
rakes aft as it climbs and so sits half a foot abaft the stem. Drawing to the
tack leaves a gap that looks like a bug; drawing to the stem invites "why is
that one line here and not the others?"

So the stays come out, and the sloop-reads-as-a-sloop worry goes with them: a
hull with a mast well forward and a boom is not going to be mistaken for
anything else.

If they come back it should be as **deck attachment points for all six** — dots,
not spans, which is what a deck-level drawing can honestly show. The *lowers*
are the ones that would earn their place, because they are what the boom fetches
up on and therefore what sets `SWING_LIMIT` ([§5](#5-direct-manipulation));
showing where they land would make the boom's travel limit visible rather than
merely enforced. That's a real design question and it deserves its own decision
rather than being smuggled in as a line on a hull.

The tack/stemhead distinction still matters to the *model* even with nothing
drawn, because the jib's clew swings about the tack. It lives in
`model/boat.ts` as `STATIONS.jibTack`, named so nothing conflates the two again.

It matters to the drawing too, now that the jib is drawn: the curve starts at the
tack, half a foot abaft the stem, and not at the bow. Drawing it from the bow
would put the curve on the wrong radius and leave a gap at the wrong end — the
same half foot that would have looked like a bug on a forestay looks like one on
a sail.

#### The coordinate story

**The SVG user unit is the metre.** The world→user transform is a rigid motion
with no scaling, so any `Vec2` the model produces — `STATIONS.bow`,
`mainClewPosition()`, a force vector for the apparent-wind overlay — is already
in drawing units. No renderer does unit arithmetic.

**The boat frame's origin is the mast; the world frame's is the pivot.** These
answer different questions and it is worth keeping them apart. The mast is where
the *rig* is measured from — the boom swings there, so the rig geometry needs no
offset — while the pivot is where the boat *turns*, which for a keelboat is its
centre of lateral resistance, well aft of the mast. Conflating them makes the
stern swing an arc no boat ever swings, and wastes scene doing it.

`STATIONS.pivot` is taken as the midpoint of LOA, 9.58 ft aft of the stem. That
approximates the CLR closely enough for a drawing this abstract, and being
equidistant from bow and stern it makes the fore-and-aft budget symmetric. The
drawn hull's *area* centroid was the other candidate and is worse: it sits at
55% of LOA, which pushes the swept radius back above the mast's and leaves more
room astern than ahead — backwards for a boat that mostly goes forwards.

The two frames therefore differ by a rotation and a fixed translation, which one
group carries: `transform="rotate(heading) translate(−pivot)"`. The boat still
never translates, so the pivot sits on the scene origin for the life of the page.

The viewBox tracks the drawing surface's real aspect ratio, and the scale is
pinned to the **shorter** axis: `SHORT_SPAN` metres always exactly span it, so
the boat reads the same size on a phone in portrait as on a desktop in
landscape. The longer axis simply shows more world. That extra space is the
point rather than waste — it is what lets the wind ring sit out near the real
edge of a tall phone instead of being inscribed in the narrow dimension and
stealing from the boat.

Inside that, four concentric bands, as radii from the pivot:

| Band | Radius | What it is |
| --- | --- | --- |
| `boatRadius` | ≈ 3.59 m | The disc the boat sweeps at any heading and any legal trim |
| `contentRadius` | 5.2 m | How far the speed indicator reaches clear of the ring |
| `windRingRadius` | 5.65 m | Centreline of the drawn wind ring |
| `shortRadius` | 6.0 m | Half the span across the shorter axis |

`boatRadius` is *measured* rather than declared, and the measurement is not the
obvious one: the binding point is the **jib clew at full ease**, which swings
out abeam near the bow, further from the pivot than the transom corners.
Refairing the hull or changing the rig moves it, and deriving it means the scene
follows along instead of quietly letting the boat grow into the wind ring. The
bands nest strictly, and a test says so.

`contentRadius` leaves 2.28 m clear of the bow and, because the pivot is the
midpoint of LOA, exactly the same astern — so sternway is no longer the cramped
case it was when the boat turned about the mast.

It is a **reservation, not a clamp**, and the speed arrow takes it up on exactly
that. The arrow is calibrated so that its tip lands on `contentRadius` at hull
speed, and above hull speed it keeps growing and crosses the ring rather than
pretending 5.6 kt and 8 kt are the same length
([§4.3](#43-the-speed-arrow)).

Two consequences follow, and they are different in kind. The wind ring is
painted **above** the boat group so the overrunning arrow passes behind it
rather than through it — that is the visible half, and it costs nothing, since a
ring at 5.65 m cannot overlap a boat that sweeps 3.59 m. The load-bearing half
is that `.pos-speed` carries `pointer-events: none`: the speed indicator is a
readout and never a control, so making it transparent to the pointer is what
actually guarantees the overlap can never intercept a drag meant for the ring
([§5](#5-direct-manipulation)). Paint order is not a substitute for that.

### 4.2 The traffic light

Green means **optimal**, and deteriorates through amber to red in *both*
directions — undertrimmed and overtrimmed alike. An overtrimmed sail is smooth,
quiet, and slow; without this, it would look identical to a well-trimmed one.

The scale is driven by **driving-force ratio, not angular error**:

```text
quality = F_drive(current angle) / max(F_drive(best angle at this apparent wind), 0.05 · q · A)
```

Best angle is found by sampling the sail's range each frame — a few dozen
evaluations, negligible cost.

Read the denominator as `F_drive(best)` everywhere a student can sail: the
second term is a floor that binds only inside the no-go zone, below an apparent
wind angle of about 8°, where the best trim available is itself worth nothing.
It is what stops the ratio being 0/0 in irons, and
[below](#where-the-best-trim-is-itself-worth-nothing) is the whole of why it is
written as a dimensionless coefficient rather than as a force.

This choice matters pedagogically. Keyed to *angle*, a fixed 10° error would
look equally bad everywhere. Keyed to *force*, the color falloff is
automatically sharp where the physics is sharp — close hauled, where trim is
critical — and forgiving where the physics is forgiving. On a run, a wide range
of sail angles really is fine, and the sail really should stay green across all
of it. The colors inherit the truth of the model instead of restating a rule.

And it comes out that way. Measured on the main in 10 kt of apparent wind, the
trims reading 0.8 or better span 7.0% of the sail's legal range close hauled
against 29.8% dead downwind; at 0.5 or better, 13.6% against 50.6%. About four
times more forgiving downwind, and nothing anywhere says so.

Those figures were 6.2/30.0 and 11.5/50.8 — "getting on for five times" — before
`pos-i4o` widened [§3.2](#the-attached-limb-has-a-maximum-of-its-own)'s stall
blend. A softer stall leaves more lift either side of the optimum, which widens
the close-hauled band; the run band is drag-driven, never goes near the blend,
and did not move. The lesson is unchanged in kind and slightly weaker in degree,
which is the honest way round: it is the *model* that says how forgiving a run
is, and the model's stall got softer.

Note the two failure modes stay distinguishable even though both are red:
undertrimmed is red **and fluttering**; overtrimmed is red **and dead still**.
Since pos-dmg.2 that is drawn rather than promised ([§4.1](#41-whats-drawn)), and
it is why a viewer who has asked for less motion gets the ripple *held* at a
fixed phase rather than removed: taking it away would collapse the two red states
back into one.

One qualification, and it comes from the physics rather than from the ramp:
**you cannot badly oversheet close hauled.** The best trim there is already
nearly on the centreline — half a degree off it at an apparent wind angle of
20° — so the boom hauled all the way in is a small error, and reads amber.
Sheeted to the centreline, the quality reaches red at **55°** of apparent wind.
That boundary was 35° before `pos-i4o`, and it moved for the same reason the
bands above did: a sail at large incidence keeps more of its lift, so hauling
flat on a close reach is now amber where it used to be red. It is arguably the
better answer — at 40° the best trim is only some 16° of ease away, so a boom on
the centreline there is mildly overtrimmed rather than ruinous — but it is a
real narrowing of what the colour calls a mistake, and the reach between 35° and
55° now teaches "not ideal" where it taught "wrong".

Past the centreline is not oversheeting at all but *backing*
the sail ([§3.4](#34-backing-a-sail)), which is red for a different reason: it
drives the boat astern. So overtrimming is a reaching and running mistake,
which is where it is a mistake on the water too, and the error available close
hauled is easing too far — which luffs, and reads red the other way.

#### Where the best trim is itself worth nothing

The denominator needs a floor, because in the no-go zone it goes to zero. The
optimal-trim search reports the honest in-irons answer — a non-positive best
force, and *exactly* zero below an apparent wind angle of 4.3°: the main is
still at zero *at* 4.3° and first drives at 4.4°, with 0.06 N, reaching 0.22 N
at 4.5°, while the jib crosses a tenth of a degree sooner. Not because
everything luffs there — a boom right out at 4° off the wind is fully attached,
and pulling 200 N *astern*. Every trim that holds its shape drives backwards,
so the maximum lands on a luffing trim at exactly zero.

The bare ratio there is 0/0. Worse than undefined: a sail sitting on the
optimum at 5° off the wind would read fully green while making 1 N and going
nowhere, then snap to red as the best force crossed zero.

So the denominator is `max(F_drive(best), 0.05 · q · A)`. The floor is a drive
*coefficient*, not a force, which is what keeps it from becoming a statement
about the strength of the wind: `F_drive` scales with dynamic pressure, so a
floor in newtons would refuse to let a perfectly trimmed sail go green in light
air. Divided out, 0.05 means the same thing at 2 kt as at 25 kt.

It binds only where the answer is "bear away". The main's peak drive
coefficient is 0.006 at 5° off the wind, 0.047 at 8°, 0.21 at 15°, 0.59 close
hauled and 1.57 on a beam reach, first reaching the floor itself at 8.2° — so
every point of sail a student can actually sail divides by the same number it
always did, and inside the no-go zone the best trim fades from red rather than
sitting green: 0.13 of the ramp at 5°, 0.36 at 6°, 0.95 at 8°, full green at
8.2°. The fade is continuous *through* the boundary, which is the point of
doing it this way rather than with a threshold.

A flat calm is the one case with no answer at all — every trim ties at zero
force — and it paints red.

### 4.3 The speed arrow

Length encodes absolute speed. Color compares current speed against what this
boat would be doing, on this heading in this wind, if both sails were trimmed
perfectly.

The length law is linear:

```text
length = SPEED_REACH · |speed| / HULL.hullSpeed
```

`SPEED_REACH` is derived rather than declared — it is what is left of
`contentRadius` once the bow and the gap below are accounted for, ≈ 2.08 m, and
the same figure astern because the pivot is amidships. So a full-length arrow
means *hull speed*, which is a thing worth recognising, rather than merely
meaning "the biggest arrow". Above hull speed the arrow overruns and crosses the
wind ring; see [§4.1](#41-whats-drawn) for why that is allowed and what makes it
safe.

#### The one place it is not linear

The law above governs every speed out to the wind ring, which the tip reaches at
6.87 kt. Past the ring it bends, easing asymptotically onto a limit 0.1 m inside
`shortRadius`:

```text
linear  = SPEED_REACH · |speed| / HULL.hullSpeed
overrun = linear − SPEED_KNEE                 (SPEED_KNEE reaches windRingRadius)

length  = linear                                        when linear ≤ SPEED_KNEE
        = SPEED_KNEE + H · (1 − e^(−overrun/H))          when linear > SPEED_KNEE
          where H = SPEED_LIMIT − SPEED_KNEE, ≈ 0.25 m
```

The guard is not decoration. Below the knee `overrun` is negative, the
exponent turns positive, and the second line runs away — at 0 kt it evaluates
to about −6000 m. The bend applies to the overrun and to nothing else.

The reason is not taste, it is that the drawing is finite and the linear law was
not. `sceneExtent` maps `shortRadius` onto the *shorter* side of any surface, so
a tip past 6 m is off the screen — not overrunning a reservation, which
[§4.1](#41-whats-drawn) allows, but leaving the viewBox, which nothing here ever
contemplated. The linear law crossed 6 m at 7.82 kt, and
[§3.5](#35-hull-resistance-and-integration)'s softened wall raised what the
model can reach to 8.9 kt, putting 0.4 m of arrow outside the box on any
square-or-portrait viewport.

Three choices were on the table — clamp, compress, or accept the clip — and the
bend is placed **at the ring rather than at hull speed** deliberately, which is
what makes it invisible: every speed out to 6.87 kt draws exactly what it drew
before. What compresses is only the band between the ring and the edge, the one
part of the drawing nothing else uses — the ring's graduations are drawn
*inward* from it for the same reason this stops short of the edge, that a mark
clipped by the viewport reads as a rendering fault. Bending at hull speed
instead would have shortened the arrow across 5.6–8 kt, where the boat actually
sails, and pushed the ring crossing out to 7.6 kt — moving the one landmark a
student can see the arrow cross, since `contentRadius` is a budget rather than a
drawn circle.

One consequence to record before someone finds this and thinks it is dead
weight. Depowering the rig in a breeze (pos-d7u) drops the fastest reachable
speed to about 6.4 kt, which is *below* the 6.87 kt ring crossing — so in normal
use the knee never engages and the arrow is linear across the whole range the
boat can reach. It stays anyway, for the same reason it was not tuned to a measured
top speed to begin with: nothing guarantees a future model, a retuned constant
or a raised wind control stays under the ring. The drawing declines to depend on
the model's range at all. Measure the invariant, not the reachable speeds.

What the bend guarantees, and why it is a curve rather than a clamp: the length
is **bounded** at every speed there is, including ones no boat reaches, so no
future top speed can be a surprise — the wind slider's 30 kt ceiling is
throwaway scaffolding rather than anything this document commits to, so "nobody
can get there" is not something to build on. It is **monotone**, so the arrow
never stops answering the question. And it leaves the linear law
**tangentially**, at slope 1, so there is no corner where it crosses the ring.
The honest cost is that above
about 10 kt successive speeds differ by fractions of a pixel: up there it is a
clamp in all but name, which is the right place to give up, since no law can
keep resolving speed inside a finite box forever.

The arrow starts **0.2 m clear of the bow**, not at it. Anchored to the stem it
reads as a bowsprit — part of the boat rather than a thing said about it — and
at the stern, where the layer paints below the hull, it would appear to slide
out from under the transom. That clear water comes out of the *arrow's* budget
rather than being added on top of the band: the gap is a drawing decision and
`contentRadius` is a reservation, so taking it from the reach is what keeps the
tip landing exactly on the band at hull speed.

The head is a constant size in metres down to about 2.2 kt, below which it
shrinks with the shaft, so **length** stays the thing that encodes speed rather
than the whole shape scaling together. Below about 0.14 kt there is no arrow at
all: the boat is not under way, and a round-capped stub off the stem that never
went away would stop reading as motion.

That reference comes from a **ghost simulation** — a second, invisible
integrator running the same model with optimal trim, in parallel. It's cheap and
it keeps a single source of truth.

Two references are in play and that's intentional:

- **Sail color** — instantaneous, local. Responds the moment you move a sail.
- **Speed arrow color** — the whole-boat verdict, and it lags, because speed
  lags. Trim in properly and watch the arrow slowly go green.

### 4.4 Color

Colors are authored in **OKLCH**. Beyond being pleasant to work with, it's the
tool that makes the accessibility requirement tractable: perceptual lightness is
an independent axis, so we can move hue and lightness deliberately instead of
discovering after the fact that our amber is washed out.

#### The validated ramp

Sail color carries meaning, and roughly 8% of boys have some red-green
deficiency, so the ramp was designed and then checked under simulation rather
than assumed. Five anchor stops from worst to best:

| Quality | OKLCH | sRGB (reference only) |
| --- | --- | --- |
| 0.00 | `oklch(52% 0.19 30deg)` | `#be2517` |
| 0.25 | `oklch(62% 0.16 52deg)` | `#ce6400` |
| 0.50 | `oklch(72% 0.13 75deg)` | `#d49838` |
| 0.75 | `oklch(80% 0.14 110deg)` | `#c3c54f` |
| 1.00 | `oklch(86% 0.16 145deg)` | `#89ec8d` |

These are anchors, not the palette. Quality is continuous, so the runtime
interpolates between them **in OKLCH** — which is the point of authoring there.
Interpolating the same endpoints through sRGB would put a muddy desaturated
sag in the middle of the ramp, exactly where "getting warmer" needs to read
clearly. The palette module clamps chroma to gamut on the way out.

The sRGB column is documentation for this file only; the code emits OKLCH.

**On matching the rest of the site:** these hues happen to land on the same
anchors the registrar app's palette uses (red 30, amber 75, green 145), which
came out of testing rather than out of deference — the earlier candidate ended
on a mint green at hue 170, and swapping it for a conventional green at 145
*improved* the ramp, spacing the perceptual steps more evenly. So it's a free
alignment, not a constraint. The simulator is a drawing of a boat, not a page of
the site, and it should look like whatever serves the drawing. Where the two
diverge, the drawing wins.

**What carries this ramp is lightness.** The five anchors run OKLCH `L` 52 → 62
→ 72 → 80 → 86, and that rise survives simulation. Under protanopia,
deuteranopia *and* tritanopia the simulated relative luminance climbs from one
end to the other without a reversal — measured over 200 samples of the
interpolated ramp, not merely at the five anchors, and with one caveat about
emitted precision recorded below:

| Deficiency | Simulated relative luminance across the five stops |
| --- | --- |
| Protanopia | 0.07 → 0.17 → 0.32 → 0.51 → 0.71 |
| Deuteranopia | 0.16 → 0.26 → 0.39 → 0.53 → 0.64 |
| Tritanopia | 0.14 → 0.22 → 0.36 → 0.51 → 0.66 |

Machado, Oliveira & Fernandes (2009) at severity 1.0. Viénot, Brettel & Mollon
(1999) agrees on the two red-green cases, which are the ones it models —
tritanopia needs the two-plane construction of Brettel, Viénot & Mollon (1997).
Neither is implemented here, so treat those as corroboration rather than as
something this repository can re-derive for you; Machado is the one the tests
run.

The smallest quarter-rise is 0.082, so the ramp reads along its whole length
instead of doing all its work at one end. `render/palette.test.ts` re-runs both
checks on every commit — but note it floors the quarters at 0.05, deliberately
loose enough to let an anchor move without letting a quarter flatten. That 0.082
is a measurement, not the guarded threshold; if the two ever have to agree,
tighten the test rather than trusting this sentence.

A colorblind student can't name these colors the way their classmate does, but
the ramp still reads to them as steadily brightening, which is the only thing it
is for. That is one mechanism rather than two, and a stronger guarantee than a
hue-based one would be, because it covers all three deficiency types rather than
only the two red-green ones.

**One caveat on "no reversal", since this section is now in the business of
claiming only what it can show.** It holds of the ideal unquantized ramp at
every resolution measured, out to 100 000 samples, and of the emitted ramp at
the 200 samples the test measures. It does not hold of the emitted ramp sampled
arbitrarily finely: `clampToGamut` floors chroma to the 1e-4 step the module
prints at, and near an anchor — where `smoothstep` flattens the lightness rise
to almost nothing — a single quantization step down in chroma can just outweigh
the gain. Sample 25× finer and tritanopia dips by 6e-5, about one part in ten
thousand of the ramp's range. That is a rounding artifact of emitting a finite
decimal rather than anything an eye could find, but the honest claim is
"monotonic to within the emitted precision".

**What the ramp does *not* rest on is the blue–yellow axis.** That is worth
stating, because it's the obvious argument for a red-to-green ramp —
blue–yellow is precisely the axis red-green deficiency preserves — and here it
doesn't work. The quality-¼ anchor is authored a little *outside* sRGB — its
linear blue is −5.7e-4, so it shows as 0 once clamped and displayed — while the
red anchor at quality 0 has 23. Every dichromat model preserves the S-cone
signal, so no honest simulation can make that amber bluer than that red.
Simulated blue runs 10 → 0 → 59 → 86 → 147 under deuteranopia and
18 → 0 → 43 → 65 → 134 under protanopia: ordered across the top three quarters,
reversed across the first. Only tritanopia — the case a blue–yellow argument
doesn't cover — is monotonic in blue, at 36 → 85 → 132 → 172 → 213.

**Retuning the amber to make the blue claim true isn't worth attempting**, and
this is the record of why, because desaturating that anchor is the fix that
suggests itself and it does not work. Anchor-only monotonicity in both red-green
cases needs the chroma at 52° inside a narrow window of roughly 0.131–0.146; the
value that first looks right, around 0.12, makes protanopia *worse* (18 → 54 →
43 → 65 → 134). Measured on the interpolated ramp rather than at the five
anchors, no chroma works at all: the best case anywhere, near 0.1305, still dips
4.4/255 under protanopia, and it falls just outside the window above, so nothing
satisfies both criteria at once. The amber can't be fixed on its own — the red
anchor would have to move too, and the rest of the ramp with it — and the prize
would be the weaker of the two guarantees.

**An earlier version of this section claimed the reverse** — that the ramp "does
not survive on lightness", and that a first attempt holding a monotonically
rising `L` inverted under deuteranopia, the amber going brightest and the
saturated green end darkest, because a chromatic green collapses toward gray when
the M-cone response is remapped. That mechanism is not general. It appears in no
ramp reconstructible from what was written down here: the shipped anchors, a
mint-green end at 170°, the green pushed to chroma 0.30, and a shallower `L` rise
all keep deuteranopian luminance monotonic with the green end brightest. The
anchors of the ramp that failed were never recorded, so it can't be ruled out
that one did invert — but whatever happened there, the shipped ramp holds exactly
the rising `L` described as failing, and that is what carries it.

An earlier candidate ended on a mint green at hue 170, on the assumption that
buying CVD separation meant giving up traffic-light green. Testing said
otherwise: the conventional green at 145 spaces the five steps more evenly.
Perceptual distance between consecutive anchors — OKLab ΔE, ×1000 — runs
124/119/114/110 for the shipped ramp against 124/119/114/162 for the mint
version, whose last step is half again as long as the ones before it. The
ordinary choice was simply the better one. It buys nothing on blue, though: the
mint ramp's simulated deuteranopia blue is 10 → 0 → 59 → 86 → 196, reversed in
the same place and for the same reason.

The bad blue table and the bad spacing figures were probably one mistake. That
version glossed the mint candidate's spacing as "lopsided 24/44/75/38" — which
is not a spacing at all, but the successive differences of the deuteranopia blue
series it had quoted a few paragraphs above (34, 58, 102, 177, 215). One set of
four numbers was doing duty as two unrelated quantities, which is about as clear
a sign as one gets that a single simulation was run once and its output then
read twice, into two claims it didn't support. Its partner figure, 30/40/31/47,
matches nothing measurable about either ramp — not hue, not OKLab ΔE, not
lightness, not any simulated channel series — so it is best treated as
unattributable rather than as a spacing that came out wrong. For reference, the
shipped ramp's hue gaps are 22/23/35/35 and its ΔE spacing is the 124/119/114/110
above.

#### OKLCH in SVG: one real constraint

`oklch()` in an SVG **presentation attribute** — `fill="oklch(...)"` — is only
reliably supported in Safari. Chrome and Firefox don't parse it there, even
though both support `oklch()` in CSS proper. Since a school iPad is Safari, this
would have worked in testing and broken on someone's Android phone.

So: **never set color via presentation attribute.** Colors go through CSS —
either a custom property on the element or `element.style.fill` — both of which
run the CSS parser and work everywhere. We're generating the SVG from TypeScript
anyway, so this costs nothing as long as it's a rule from day one. The palette
module exposes computed colors only as CSS custom properties, which makes the
rule structural rather than something to remember.

The rule has a boundary worth stating, so nobody over-applies it: it bans
*colour* presentation attributes. Geometry attributes — `d`, `transform`, `r`,
`vector-effect` — are unaffected, and two of them are actively *preferable* to
their CSS equivalents. CSS `transform` on an SVG group defaults to rotating
about the reference box's centre rather than the user-space origin, which for a
boat that rotates about its mast is simply the wrong point.

Support floor is Safari 15.4 / Chrome 111 / Firefox 113, ~93–95% globally. The
registrar app already ships OKLCH-only in production — its stylelint config bans
hex and `rgb()`/`hsl()` outright — so that floor is one the school has already
accepted in practice, and we can inherit the decision rather than relitigate it.

### 4.5 Rendering constraints

Line weights need to survive both a phone in someone's hand and an iPad flat on
a table viewed by three students at an angle. Weights scale with viewport rather
than being fixed.

Concretely: **a dimension *of the boat* is in metres** and scales with the
drawing — the mast dot, a sail's camber. **A *line weight* is in CSS pixels**
and scales with the viewport. What lets the two coexist inside a metre-valued
viewBox is `vector-effect: non-scaling-stroke`, which takes stroke width out of
user space. Set it as an *attribute*, not only in CSS: if support for the
property were ever missing, `1.4px` would be read as 1.4 *metres*, which is a
loud enough failure to be worth the belt as well as the braces.

The weights themselves are `clamp()` on `vmin`, e.g. `clamp(1.4px, 0.4vmin, 4px)`
for the hull. `vmin` is the viewport rather than the drawing surface, but §6.2
gives the simulator the whole viewport, so the two differ only by the control
strip — across real layouts that expression holds at ~0.88% of the drawn boat's
length from a 320 px phone to a 1440 px desktop. (`cqmin` would make it exact,
but it starts at Safari 16, above our floor.)

Worth recording *why* the clamp rather than plain proportional scaling, since
proportional is the free behaviour of a scaled viewBox and the two agree within
about 10% across mainstream devices: the clamp earns its keep at exactly the two
ends this section names — the floor, so a phone never goes hairline, and the
ceiling, so a classroom TV or projector doesn't turn the boat into a cartoon.

---

## 5. Direct manipulation

An iPad flat on a table, in a small group, plus phones. That means: **no hover
state exists**, touch targets must be large, and targets will overlap.

### Gestures

| Element | Gesture | Notes |
| --- | --- | --- |
| Hull | Drag to rotate | Rotates about `STATIONS.pivot`, near the keel — [§4.1](#41-whats-drawn) |
| Wind direction | Drag anywhere on the perimeter ring | Large target, never overlaps the boat |
| Wind speed | Slider | Separate control; easier than dragging arrow length on a phone |
| Main | Drag the clew | Past natural side = backing ([§3.4](#34-backing-a-sail)) |
| Jib | Drag the clew | Same; absent when the jib is struck |

Two settings sit outside the drawing, in a minimal control strip: **apparent
wind** ([§3.1](#31-apparent-wind)) and **jib on/off**
([§3.7](#37-sailing-under-main-alone)). Both are switches rather than
manipulations, both are things a student sets once and forgets, and neither
belongs on the boat. Striking the jib by dragging it overboard would be
charming and undiscoverable.

Striking the jib also *helps* the hardest interaction problem below — with one
sail there is nothing to disambiguate close hauled — which means the Level 1
configuration is also the most forgiving one on a phone.

Putting the **wind arrow on the perimeter** — a ring around the whole scene
rather than a vector near the boat — solves the worst of the overlap problem by
construction. It gives the wind an enormous, always-reachable target that can
never collide with the sails, and it reinforces the idea that the wind belongs
to the world while trim belongs to the boat. The circle is drawn in full rather
than only under the arrow, because the whole circle is what you may drag: a
track you can see is the difference between an affordance and a secret.

The ring is **graduated with the points of sail**. Seven short marks every 45°,
anchored to the wind's own bearing rather than to the compass, so they turn with
the wind instead of with the boat: the arrow's bearing is head to wind, ±45° is
close-hauled, ±90° a beam reach, ±135° a broad reach, and 180° a run. Read where
the bow falls against them and you have named the point of sail — which is a
thing a student has to learn to do anyway, and this is the cheapest place to
practise it. The eighth mark is not drawn, because the arrow already stands on
it.

That the graduations move with the wind and not with the boat is the whole
lesson §1 is after, drawn rather than said: turn the boat and the marks hold
still while the bow sweeps across them; shift the wind and the marks sweep while
the bow holds still. Same number changing, two different events.

### Grab points: the clews

**Sails are dragged by their clews**, and nothing else on the sail is draggable.

This dissolves the overlap problem at any normal trim, because the clews are
attached to different parts of the boat: the main clew rides the end of the
boom, roughly 16.7 ft aft of the bow, while the jib clew sheets to the deck
around 8 ft aft. Sheeted flat that's **~45% of the boat's length between them —
about 230 px on a 500 px boat** — and with both sails inside ±60° the gap never
closes below ~35% of the boat's length. Across the trim a student spends nearly
all their time in, there is no finger-width ambiguity to arbitrate.

The geometry is worth stating plainly rather than assuming: the main clew
swings on a 9.7 ft radius about the mast, the jib clew on a 7.5 ft radius about
the jib's tack 6.5 ft ahead of it, and those two arcs do intersect — but only
with the main eased to ~129°, well past the ~90° where the boom fetches up on
the shrouds. **The swing limit is therefore what keeps the grab points apart:**
with trim clamped to the boom's physical range, the closest the clews ever come
is ~22% of the boat's length (~109 px on a 500 px boat), comfortably clear of
two 44 px touch discs. The limit and the clamp live in `model/boat.ts` as
`SWING_LIMIT` and `clampTrim`; every site that sets a sail angle routes through
the clamp — including backing ([§3.4](#34-backing-a-sail)), which holds the sail
on the *wrong side of the wind* but never past the shrouds. The measurements are
pinned as tests in that module's suite.

It's also the physically honest choice: the clew is where the sheet attaches, so
it is quite literally the point through which a sailor's control acts. The
earlier plan — fat hit paths along the whole boom, arbitrated by nearest grab
point — would actually have been *worse* than useless here, since the midpoint of
the main boom sits closer to the jib clew than to its own, and touching the main
would sometimes have grabbed the jib.

What remains:

1. **Generous invisible discs.** ~44 CSS px centered on each clew, independent of
   the visible handle size.
2. **Pointer capture.** A drag owns its pointer until release, so hit-testing
   only happens at touchdown.
3. **Everything else on the hull rotates the hull.** With only two small discs
   reserved, the entire silhouette is available — the conflict between hull and
   sail grabs is gone too.
4. **Swing limits instead of arbitration.** The boom physically cannot pass the
   shrouds (~90° of ease), and with trim clamped to that range the clews can
   never coincide — the ~22% of LOA minimum above. Touchdown still tie-breaks on
   the nearer clew, and a sail already captured by another pointer isn't a
   candidate.

**A correction to the pixel figures above.** They were written against a
hypothetical 500 px boat, which the scene ([§4.1](#41-whats-drawn)) has since
turned into a real number: at `shortRadius` = 6 m the boat is 48.7% of the
scene's short axis, so it is ~190 px on a 390 px phone, ~406 px on an iPad and
~438 px on a desktop. A 500 px boat needs a 1027 px scene — a large display, not
the typical one.

The proportions are unaffected — 45% of LOA at normal trim, 22% at the worst
legal trim — but the pixels are not. On a phone that worst case is ~42 px, which
is *narrower* than two 44 px discs side by side, so **the nearer-clew tie-break
is load-bearing on small screens, not the cheap defensive rule this section
called it.** Disc radius should be `min(22px, gap / 2)` rather than a flat 22 px.
`scene.pixelsToMeters()` exists so the input layer can compute that at runtime
instead of assuming a scale. At normal trim there is no ambiguity anywhere: 45%
of a 190 px boat is still ~85 px.

**Discoverability.** With no labels, the grab points have to announce themselves.
A small circle drawn at each clew reads as boat hardware — a shackle, a fitting —
rather than as UI chrome, so it signals the affordance without violating the
no-scaffolding position. That rule was about not handing students the answer, not
about hiding the controls. The opening state helps too: the mistrimmed sail is
usually luffing, and the motion draws the eye straight to the thing worth
touching.

One consequence for [§3.4](#34-backing-a-sail): backing the main means dragging
the clew forward rather than shoving the boom amidships as you would on the
water. The geometry is identical — the boom rotates about the mast either way —
so the loss is a small one in physical metaphor only.

### Multi-touch

Two students, one on the main and one on the jib, at the same time. Pointer
events support this and the model is stateless enough not to care. For a tool
explicitly designed for small groups around a table, this is worth getting right
rather than treating as a bonus.

---

## 6. Architecture

```text
src/
  model/
    units.ts          angle/speed helpers, conversions, sign conventions
    wind.ts           true → apparent wind
    foil.ts           Cl/Cd curves, stall blend
    sail.ts           per-sail force, collapse fraction and edge, optimal trim
    hull.ts           resistance curve
    boat.ts           Rhodes 19 constants
    simulation.ts     state + step(dt), including the ghost boat
    initialState.ts   bounded randomizer (§2.1)
    tuning.ts         every fudge factor, in one file
  render/
    svg.ts            namespace-correct element factory, attribute formatting
    scene.ts          SVG root, viewBox, responsive layout, screen↔world
    scene.css         ink and line weights (§4.4, §4.5)
    hull.ts           hull outline and mast
    sail.ts           Bézier camber + luff flutter
    wind.ts           perimeter arrow, apparent-wind overlay
    speed.ts
    palette.ts        traffic-light interpolation, colorblind-safe ramp
  input/
    pointer.ts        capture, multi-touch, hit arbitration
    gestures.ts       rotate hull / rotate wind / trim sail / back sail
  main.ts
```

One rule holds the whole thing together:

- **`model/` has no DOM.** Pure functions and plain data. Fully unit-testable,
  which is what lets us assert the calibration table in [§3.6](#36-calibration-targets)
  as tests instead of eyeballing it.
- **`render/` reads state, never writes it.**
- **`input/` writes state, never renders.**

**Everything tunable lives in `tuning.ts`.** Resistance constants, the
acceleration time constant ([§3.5](#35-hull-resistance-and-integration)), stall
and luff thresholds, the swing-back duration, the upwind jib bonus (§3.7),
and the color ramp anchors are all feel decisions that will be adjusted against
the running simulator. Collecting them in one file keeps them out of the physics,
makes the calibration phase a matter of turning knobs rather than hunting
constants, and — since a fudge factor in a named tuning file is visibly a fudge
factor — keeps us honest about which numbers are physics and which are taste.

That file's remit is the *model*, though. Drawing decisions — the Bézier
fractions that fair the hull, the scene's band radii — stay beside the code that
draws with them. A render module reaching into model tuning for a curve handle
would blur the very line `tuning.ts` exists to draw.

TypeScript + Vite, building to static files.

### 6.1 Deployment: static assets in the registrar app

**This repo is the development and testing harness.** When the simulator reaches
a deployable state, its build output is added to the `registrar` app
(`/Volumes/Campfire/Sites/registrar`, Swift 6 / Hummingbird 2) as static assets
with a small router entry. Nothing else serves it **in production**.

There is one development-time exception, and it is deliberately not a second
production target: a **GitHub Pages preview** of `main`
(`.github/workflows/pages.yml`, pos-770), so instructors can try the simulator
and give feedback while it is being built. It is temporary and should be retired
when the registrar deploy lands. It does not weaken anything below — the
registrar remains the only thing that serves this to students.

Worth noting because it is the same trap twice with different answers: a Pages
project site is served from `https://<org>.github.io/point-of-sail/`, so it needs
`base: '/point-of-sail/'`, which is neither the default nor what the registrar
wants. The preview therefore passes `--base` on Vite's command line
(`npm run build:pages`) rather than setting it in `vite.config.ts`. The config
keeps its default, and the base-vs-route decision below stays open for whoever
takes pos-740.5.

Although the ESS site is mid-migration from Drupal 6, that never becomes this
project's problem: both live behind the same domain, with Nginx ingress routing
by path to separate K8s containers, and the simulator is served exclusively by
the registrar side. It's a native page there, not an embedded widget.

Two things about the existing setup are worth pinning down, because both are
easy to get wrong:

**The static URL prefix is `/registrar/public/`, not `/registrar/`.**
`FileMiddleware` is mounted at `urlBasePath: "/registrar"` over
`getStaticFilesPath()`, which resolves to the bundled `Static` directory — so
`Static/public/css/styles.css` is served at `/registrar/public/css/styles.css`,
as the existing `PageLayout.swift` and `page.mustache` both confirm. Build
output landing in `Static/public/point-of-sail/` is therefore served at
`/registrar/public/point-of-sail/` by the existing middleware, with no route
needed for the assets themselves. `Package.swift` already declares
`.copy("Static")`, so adding a subdirectory needs no manifest change either.

**Vite's `base` has to agree with wherever `index.html` is served from.** This
is the trap: the natural router entry gives the page a clean URL like
`/registrar/point-of-sail`, while its assets sit under
`/registrar/public/point-of-sail/`. Vite's default `base: '/'` emits
`/assets/index-abc123.js` and 404s immediately. The obvious fix, `base: './'`,
*also* fails in that arrangement — relative URLs resolve against the clean page
URL, not the asset directory. Either set `base` to the explicit absolute asset
path, or have the route serve `index.html` from the same prefix as the assets.
Worth deciding when the route is written rather than debugging later.

A deploy script should also clear the target directory before copying, since
hashed filenames otherwise accumulate stale bundles on every deploy.

### 6.2 A bare page, owning the whole viewport

The page is **not** wrapped in the site's `PageLayout`. Navigation back to the
lesson is what the browser's back button is for, and giving up the template buys
something the simulator genuinely needs: complete control of positioning and
scrolling. That's the difference between feeling solid and feeling fiddly, and on
a touch device it's not a matter of taste.

A drag on an SVG inside an ordinary scrolling page fights the scroller. On an
iPad, pulling a boom toward the top of the screen can rubber-band the page,
trigger pull-to-refresh, or start a momentum scroll that hijacks the gesture
halfway through — and three students pawing at one screen will find every one of
those failure modes in the first minute. Concretely:

- `height: 100dvh` with the page itself never scrolling
- `overscroll-behavior: none` to kill rubber-banding and pull-to-refresh
- `touch-action: none` on the drawing surface, so the browser hands us every
  pointer event instead of speculatively treating it as a scroll or a zoom
- no double-tap-to-zoom delay to work around, since `touch-action` disposes of it

Serving bare also disposes of the CSS-isolation problem from
[§6.1](#61-deployment-static-assets-in-the-registrar-app) — there's no global
`styles.css` in the document to leak in. Scoping the simulator's styles under a
single root class stays worthwhile anyway, since it costs nothing and keeps the
door open to embedding later.

The trade is that pinch-zoom goes away on the drawing surface. For a
direct-manipulation diagram whose entire content is always on screen by
construction, that's the right call — there is nothing to zoom *to*. Worth
revisiting only if the line weights turn out to be too fine on a phone, which is
a rendering problem to fix at the source rather than by making students pinch.

### 6.3 URL parameters as the configuration surface

The objectives forbid persistence — reload resets everything — which creates a
problem the jib toggle exposes. If an instructor sets up a main-only boat for a
Level 1 group and a student reloads, they're back to a sloop.

The answer is to let **the embedding page carry the configuration**, not the
session:

```text
?jib=on              set the jib (§3.7 — main-only is the default)
?apparent=on         show the apparent wind triangle (§3.1)
?wind=12&twa=60&…    a fully specified situation
```

A Level 1 lesson links to the bare URL and gets a main-only boat; a later lesson
links to `?jib=on`. Same build, same route, different lesson. Reload is safe,
because the configuration lives in the link rather than in state we're not
allowed to keep.

**Serialize the whole state, not a random seed.** The original proposal was a
`?seed=` parameter reproducing a random opening problem, which turns out to
answer a question nobody asks: an instructor wanting a specific situation
doesn't hunt for a random one that happens to match, they *build* it and then
bookmark or share it. So the URL carries the actual state — wind, heading, trim,
rig — and the page updates it via `history.replaceState` at the end of each drag.
No affordance, no button, nothing to teach: the address bar just always describes
what's on screen, so bookmarking and sharing work the way they do everywhere
else. Debounced to drag-end so the URL doesn't churn mid-gesture, and
`replaceState` rather than `pushState` so the back button still leaves the page.

This reads as a conflict with the objectives' *"page resets to default settings
whenever it is reloaded"* and isn't one. The rule exists to keep hidden state out
of the app; a URL is not hidden state — it's visible, portable, and the user's to
edit or discard. The bare URL still resets to a fresh random problem, which is
what the lesson pages link to. A URL carrying parameters restores exactly what it
says. Reloading after ten minutes of work now returns your boat instead of
destroying it, which is what a reload should do anyway.

---

## 7. Deliberately out of scope

Named here so we can decline them consistently rather than re-litigating each
one. Several are worth revisiting *after* v1 works.

**Out for now, plausible later (as toggles):**

- Leeway — the crab angle between heading and track. The *cost* of making side
  force is charged ([§3.5](#35-hull-resistance-and-integration)); what is out is
  the boat visibly crabbing, and any separate accounting of where that cost goes
- **Sail telltales** — yarn at the luff, showing whether the flow is attached.
  Weaker than it first looks: [§4.2](#42-the-traffic-light) already reports trim
  quality, and it reports it from the *driving force* rather than from a proxy
  for the driving force. A luff telltale would restate the traffic light, less
  accurately, in a second visual language. Revisit only if the colour ramp turns
  out to want corroborating.
- Heel, which top-down can only hint at symbolically — and which, like leeway,
  is paid for without being shown. **What is out is drawing it, not modelling
  it**, and the distinction is worth spelling out because this bullet has
  already been read the stronger way once. Heel is paid for *twice*:
  `RESISTANCE.sideForce` carries the drag it produces, and
  [§3.2](#depowering-the-rig-stops-collecting-force-in-a-breeze)'s depowering is
  the force it costs the rig, which is much the larger effect and the one that
  decides how fast the boat goes in a breeze. Both are its consequences, charged
  without an angle ever being computed — which is an outcome of measurement
  rather than of this section: §3.2 records that driving the depowering from an
  actual heeling moment was tried and makes a worse boat, and had it been the
  better boat nothing here would have forbidden it

**Telltales in the rigging are a different instrument, and are planned rather
than declined** (pos-32n). An earlier draft of this section listed "telltales"
flat, which collapsed two things that have almost nothing to do with each other.
Yarn on the port and starboard uppers and on the backstay — which is what the
school's own boats carry — shows the apparent wind's *direction*, and nothing
in the drawing shows that today: the wind ring shows the **true** wind, and a
student reading only that will misjudge every sail on the boat
([§3.1](#31-apparent-wind)).

It is also the rare addition that costs no scaffolding. There is no label and no
toggle — it is a physical object on the boat that happens to be an instrument,
and a student who learns to read it here reads the real one without translation.
Only the telltale furthest into the wind is drawn, the others hidden, because
that is the one with clean air and therefore the one to use; showing all three
would both clutter the drawing and bury the rule. See pos-32n, which is gated on
pos-aax for the chainplate stations — and which gives that decision an argument
it did not have, since the uppers and the backstay would then be earning their
place as anchors rather than as spans.

**Out, by design:**

- Rudder and steering — the boat doesn't navigate
- Labels naming the point of sail
- Shaded no-go zone
- Polar plots or any chart
- Preset scenarios or challenges
- Ghost overlay showing where optimal trim would be

The last group is the objectives' "encourage play" position. Scaffolding tells
the student the answer; the traffic light lets them find it.

**Out, physics we're not modeling:**

- Main blanketing the jib downwind, as a mechanism. It is real, and it is part
  of why a run is slower than a two-independent-sails model says; `pos-fo1.4`
  folded it into the stalled sail's normal force
  ([§3.2](#32-sail-forces)) rather than modelling the shadow, which fits the
  sloop but leaves main-only carrying a penalty it should not have. Worth
  reopening if [§3.7](#37-sailing-under-main-alone) cannot calibrate around it
- Slot effect between main and jib, *except* for the single scalar upwind bonus
  that makes main-only point worse — see [§3.7](#37-sailing-under-main-alone)
- Weather helm. Unreachable without a rudder, and largely absent from the
  school's own boats anyway ([§1](#1-the-core-idea), [§3.7](#37-sailing-under-main-alone))
- Sail twist, draft position, halyard/outhaul/cunningham controls
- Spinnaker
- Crew weight and movement
- Waves, current, gusts, wind shear

---

## 8. Build order

Each phase leaves something demonstrable, which is what makes this bead-able.
Each is an epic in the tracker; its children are branch-sized.

| Epic | Phase | What it delivers |
| --- | --- | --- |
| `pos-t9w` | **Foundations** | Vite/TypeScript/Vitest toolchain, the bare full-viewport page shell ([§6.2](#62-a-bare-page-owning-the-whole-viewport)), and the geometry/unit conventions ([§2](#2-state)) |
| `pos-qmk` | **The drawing** | SVG hull, mast, sails, perimeter wind ring, speed arrow, OKLCH palette — all from a state object. No physics, no interaction |
| `pos-bwd` | **Direct manipulation** | Clew grabs, hull rotation, wind ring, wind speed. Multi-touch throughout. Still no forces |
| `pos-fo1` | **Force model** | Apparent wind, foil curves, hull resistance, integration, and the calibration table ([§3.6](#36-calibration-targets)) locked in as tests. Where the simulator becomes true |
| `pos-dmg` | **Feedback** | Trim-quality color, flutter animation, ghost boat, speed-arrow color |
| `pos-bql` | **Backing** | Held sails, reversed drive, sailing astern, swing-back |
| `pos-bh6` | **Main-only rig** | `jibSet` through model, render, and input; the upwind bonus; main-only calibration |
| `pos-740` | **Ship it** | Opening state, URL serialization, control strip, hardware tuning, deployment |

Foundations wasn't in the first draft of this list — it's the thing the list
assumed. It's the only true bottleneck: everything funnels through it, and after
it the graph opens up.

**The drawing and the force model are independent.** One is pure UI, the other
pure model with no DOM, and neither imports the other. They can be built in
either order or in parallel, and they only meet at Feedback.

Main-only is placed late because it's cheap once the model is calibrated, but it
delivers the configuration Level 1 actually uses. If the class needs something
before the full sloop is polished, Foundations through Feedback plus Main-only
is a complete and honest Level 1 tool on its own — one sail, correct trim
feedback, correct speeds — and Backing adds the mooring-departure lesson. That's
a defensible early release.

---

## 9. Open questions

None outstanding. The design is ready to break into beads.

### Settled

- Apparent wind is modeled always, shown behind a toggle (default off)
- Trim quality is keyed to driving-force loss, deteriorating in both directions
- Speed is integrated over time; the boat still never translates
- Backing a sail = holding the pointer down; release swings it to the mirrored
  trim angle over ~0.4 s, with the model running throughout
- Acceleration lag is a tuning knob, starting at 10 s
- Sails are grabbed by their clews, which are ~45% of LOA apart — no
  arbitration needed
- All fudge factors collected in `tuning.ts`
- This repo is the dev/test harness; deployment copies the build into the
  registrar app as static assets plus a small router entry. Served only by
  registrar, never by Drupal
- Trim ramp ends on a conventional green (hue 145); it need not match the rest
  of the site, and where the drawing and the site's look diverge, the drawing
  wins
- **Main-only is the default rig.** The jib is opt-in, discoverable by the
  students experienced enough to miss it
- The slot-effect upwind bonus is in, and must stay plainly visible — it is the
  answer to "why bother with the jib?"
- Served bare, without `PageLayout`, so the simulator owns positioning,
  scrolling, and every touch gesture
- The URL carries the full state rather than a random seed; bookmarking and
  sharing work with no affordance at all
- Colors authored in OKLCH, applied via CSS only, never as SVG presentation
  attributes
- Opening state is randomized and mistrimmed, within bounds
