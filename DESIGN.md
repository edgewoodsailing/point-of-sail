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

All sail forces are computed from apparent wind, never true wind. This is what
makes the model teach the right thing: it's why close-hauled trim is tighter
than students expect, and why the apparent wind moves forward as you speed up.

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
Cl = a · α
Cd = Cd0 + Cl² / (π · AR · e)      // Cd0 ≈ 0.02, e ≈ 0.9
```

giving `Cl ≈ 1.4` at the stall — a realistic figure for a soft sail. The curve
does not *peak* there: the blend below leaves the stall angle with zero slope, so
the attached limb keeps climbing into it and lift tops out at ≈ **1.57 near
22°**, which is where the optimal-trim search actually sits at every point of
sail in [§3.6](#36-calibration-targets).

**Past stall**, blend over ~20° into the flat-plate model — a normal force
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

The blend is **~20°, not ~10°**, and that width is not cosmetic. A sharper stall
makes the model *bistable* on a reach — the same boat at the same trim in the
same wind settling at 3.7 kt or 5.1 kt depending on whether it started from rest
— because a sail eased for the apparent wind at speed is stalled at the apparent
wind at rest, and with a cliff at the stall it cannot climb back out. Widening
the blend is what removes that, at the cost of the higher peak lift above.

**Force assembly.** Lift acts perpendicular to the apparent wind, drag along it.
Sum both sails, rotate into the boat frame, and take the component along the
heading as **driving force**. The lateral component is *not* discarded — see
[§3.5](#35-hull-resistance-and-integration), where the keel is charged for it.

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
force that was already negligible. For it, and decisive: the luff fraction is
the one number that drives the flutter as well as the force, so a fraction of
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

We compute a **luff fraction** ∈ [0,1] — how much of the sail, measured from
the luff aft, has collapsed. That single number drives both the flutter
animation and the force reduction, so what the student sees and what the boat
does can never disagree. It scales the whole force, lift and drag alike: the
collapsed portion is simply not working.

One simplification remains, deliberately, and it is worth stating without
flattering it. The fraction is still measured **from the luff aft** in both
bands, though in the leech-first band the cloth breaks at the *leech* and the
collapse runs forward. The band is only 7° wide, but the fraction does not
saturate across it: it is 0.35 at α = 175° and does not reach 1 until 178°. So
through the first half of the band the drawing will shake the forward third of a
sail whose *leech* is the end actually breaking. What the simplification buys is
a single axis for [§4.1](#41-whats-drawn)'s deformation hook, and that — not any
claim that the error is negligible — is why it stands for now. Doing it properly,
including a name that admits the fraction is no longer about the luff, is its own
piece of work.

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
displacement hull hits, so no amount of sail area gets a Rhodes 19 to 9 knots
in the wind it is actually sailed in. It was a sixth power until `pos-lcz`;
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

Everything else in this model is *homogeneous of degree two* in speed. Sail
force is dynamic pressure times coefficients that depend only on angles; the
keel's induced drag is `k·F²/v²` with `F` itself going as `v²`; the keel's stall
ratio is capacity over load, which is unchanged when both scale together; and
`A·v²` is quadratic by construction. Scale the true wind and the boat's speed by
the same factor and every one of those scales by that factor squared — so the
balance `F_drive = R(v)` is preserved, and the *shape* of the polar does not
move at all.

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
the pointing angle, because there is only the one knob. Holding a beam reach at
or under hull speed at 30 kt while [§3.6](#36-calibration-targets)'s table
survives needs an exponent of about 126 — a speed clamp, not a wall — and the
pointing is long gone well before that. Pulling the 10 kt beam reach down to
make room instead fails a different way: the run sits at ≈ 3.85 kt in every
configuration, being far enough below the wall to be untouched by it, so a
slower beam reach simply breaks "a run is notably slower than a reach".

Four is that trade taken deliberately toward the range the simulator opens in.
It costs speed discipline at the top of the wind range — a beam reach reaches
7.59 kt in 20 kt of wind and 8.88 kt in 30, against a 5.65 kt hull speed, and
a Rhodes 19 does neither — and it costs the broad reach two more points of the
shortfall [§3.6](#36-calibration-targets) already calls structural. What it buys
is that the three lessons the model exists to teach hold their shape across the
6–14 kt [§2.1](#21-initial-state-a-random-solvable-problem) actually opens on.
`calibration.test.ts` asserts both halves, the gain and the cost.

The honest reading is that the wall is being asked to do a job it is the wrong
shape for. What holds a real Rhodes 19 down in a breeze is not extra water drag
but the rig giving up: it heels, the sail twists off, and the crew eases and
feathers. That caps the *drive* rather than clipping the *speed*, and because it
acts on every point of sail together it is the only kind of term that can slow
the boat in a gale without bending the polar. `pos-d7u` is the bead for it.

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
badly. Trimmed for the wind it's in, the boat stops settling at around 80 kt — a
tenth-of-a-second step alternates between two speeds forever — and by 120 kt it
diverges to `NaN`, permanently, since every later step adds to it. Nobody sails a
Rhodes 19 in 120 kt, but the wind slider ([§5](#5-direct-manipulation)) is
scaffolding rather than a limit, and a model that quietly dies past some speed is
a trap for whoever raises it. (Those thresholds were 55 kt and 85 kt while the
wall was a sixth power; a gentler curve is a gentler thing to linearize.) So the
step linearizes the resistance about the current speed:

```text
v += (F_drive − R(v)) · dt / (m_effective + R′(v) · dt)
```

Same equation to first order — at 60 Hz the correction is about a percent and
the trajectory matches the naive form to three figures — but the faster the
water would answer, the smaller the step it takes, so the speed can't run away
from a curve climbing faster than the step can see. The fixed point is still
exactly `F_drive = R(v)` and doesn't depend on `dt`.

It does *not* make overshoot impossible: the step follows a tangent to a convex
curve, so it aims slightly beyond the balance point, and in a gale not slightly
at all. What makes that harmless is that resistance grows faster than linearly,
so a speed past the balance point meets a restoring step larger than the one
that took it there, and overshoots decay instead of feeding themselves.

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

### 3.6 Calibration targets

Constants get tuned until the polar hits roughly these marks in 10 kt true:

| Point of sail | TWA | Sloop | Main only | **Model (sloop)** |
| --- | --- | --- | --- | --- |
| Head to wind | 0° | 0 (in irons) | 0 (in irons) | **0** |
| Close hauled | 45° | ≈ 4.2 kt | ≈ 3.2 kt | **4.18 kt** |
| Beam reach | 90° | ≈ 5.4 kt | ≈ 4.6 kt | **5.55 kt** |
| Broad reach | 135° | ≈ 5.2 kt | ≈ 4.4 kt | **4.73 kt** |
| Run | 180° | ≈ 3.5 kt | ≈ 3.0 kt | **3.71 kt** |
| **Closest useful angle** | — | **≈ 45°** | **≈ 55°** | **44°** |

Beam reach fastest, run notably slower, and a no-go zone that simply *is* rather
than being drawn on. These are the model layer's unit tests, in
`calibration.test.ts`.

The right-hand column is where `pos-fo1.4` left the sloop and `pos-lcz` last
moved it; every figure is inside the ~10% the targets are quoted to. Two of them
are worth reading rather than just checking.

The **broad reach is 9% light, and structurally so.** The table puts a beam reach
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
leaving about one point of margin against the tolerance. What is actually wanted
is not a different resistance curve but a term acting on the *drive* — see
`pos-d7u`.

The **closest useful angle is read as the peak of upwind VMG**, which is what a
sailor means by it and what a test can check. It came out at 30–35° before
calibration — a boat that points like nothing afloat — and the constant that
moved it is the keel's stall ceiling in [§3.5](#35-hull-resistance-and-integration).

The **main-only column is not yet met** and is not this section's to meet: it
belongs to [§3.7](#37-sailing-under-main-alone)'s upwind bonus, which changes
the sloop numbers too and so has to recalibrate against this table.

**This table is one wind speed, and the model knows it.**
[§2.1](#21-initial-state-a-random-solvable-problem) opens anywhere in 6–14 kt and
[§5](#5-direct-manipulation)'s slider runs to 30, so the three qualitative
lessons have to survive a range the table says nothing about. They still weaken
as the breeze fills in, but `pos-lcz` narrowed it to where the same bounds hold
across the whole opening range:

```text
wind      4     6     8    10    12    14    16    20    30
angle    51°   49°   47°   44°   41°   40°   38°   36°   33°
run/beam 0.53  0.57  0.62  0.67  0.71  0.74  0.77  0.80  0.85
beam kt  2.91  4.05  4.90  5.55  6.08  6.53  6.92  7.59  8.88
```

The closest useful angle now stays inside 40–50° for every wind in 6–14 kt — the
same band the 10 kt test pins — where before it ran to 39° by 14 kt, and the run
stays under 75% of a beam reach across the range rather than reaching 78%.
`calibration.test.ts` asserts exactly that, at the real bound: the 14 kt figure
lands on 40° with *no margin*, and buying a degree back by nudging the keel's
stall ceiling was available, considered, and declined, because it would move the
boat to make a test comfortable while the drift underneath stayed put.

**What this does not fix is the beam reach in a lot of wind**, and that is now a
recorded limit rather than an open question. At 20 kt it is 7.59 kt and at 30 kt
8.88 kt, against a 5.65 kt hull speed — 34% and 57% over, where before `pos-lcz`
it was 25% and 41%. That got *worse*, deliberately:
[§3.5](#the-wall-exponent-is-the-models-only-wind-scale) shows the two are the
same knob pulling opposite ways, and the pointing angle across the range anyone
actually sails in was judged the more valuable of the two. No setting of the wall
exponent satisfies both, and the term that could is `pos-d7u`.

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

Camber depth is a function of trim and apparent wind pressure. When the luff
fraction is non-zero, a traveling sine wave is superimposed on the collapsed
portion — amplitude scaling with how deeply it's luffing, and the fluttering
region extending aft as the collapse spreads. A sail that is *just* starting to
break shows a small ripple at the luff only, which is exactly what a student
should learn to spot.

#### How the camber is drawn

The offset from the chord runs along `perpendicular(chordDirection)` — 90°
clockwise of tack→clew — scaled by a signed depth:

```text
depth = chord · MAX_DRAFT · (1 − luffFraction) · pressureFactor(q) · sin α
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

Using `sin α` whole rather than only for its sign also buys both knife edges:

- **α → 0** — edge-on and luffing. Depth → 0, so the side flip at the luff
  happens through a flat sail and is invisible.
- **α → ±180°** — the flow arrives at the leech instead, a flogging sail making
  nothing. Depth → 0 again. This one is easy to miss, because **the luff fraction
  is blind to it**: [§3.3](#33-luffing) folds the thresholds about zero, so an
  edge-on-at-the-leech sail reports as fully drawing. `(1 − luffFraction)` alone
  would draw full camber there, on an arbitrary side, and flip it as α crossed
  180° — a maximum-amplitude pop in a state a student reaches by easing on a run.

The visible consequence, chosen deliberately: a close-hauled sail reads
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

- Its chord fraction is measured **from the luff aft**, the same axis the luff
  fraction is defined on, so the fluttering region is literally
  `s < luffFraction`.
- It returns a **replacement, not an addend**, so the flutter can flatten the
  collapsed portion *and* ripple it — `offset · collapse(s) + ripple(s)` — which
  is what "the fluttering region extends aft as the collapse spreads" requires.
- It is **never called at the endpoints**. The tack and clew are physical
  attachments, and the clew is a grab point ([§5](#5-direct-manipulation)), so no
  animation can walk a touch target off the drawn sail.

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
quality = F_drive(current angle) / F_drive(best angle at this apparent wind)
```

Best angle is found by sampling the sail's range each frame — a few dozen
evaluations, negligible cost.

This choice matters pedagogically. Keyed to *angle*, a fixed 10° error would
look equally bad everywhere. Keyed to *force*, the color falloff is
automatically sharp where the physics is sharp — close hauled, where trim is
critical — and forgiving where the physics is forgiving. On a run, a wide range
of sail angles really is fine, and the sail really should stay green across all
of it. The colors inherit the truth of the model instead of restating a rule.

Note the two failure modes stay distinguishable even though both are red:
undertrimmed is red **and fluttering**; overtrimmed is red **and dead still**.

### 4.3 The speed arrow

Length encodes absolute speed. Color compares current speed against what this
boat would be doing, on this heading in this wind, if both sails were trimmed
perfectly.

The length law is linear and unclamped:

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

**This ramp does not survive on lightness, and the first attempt that tried to
failed.** An earlier version held a monotonically rising OKLCH `L` from red to
green. Under deuteranopia simulation it inverted: the amber midpoint became the
*brightest* stop and the saturated green end the *darkest*, because a chromatic
green collapses toward gray when the M-cone response is remapped, losing apparent
brightness. Lightness peaked in the middle of a ramp whose whole job is to be
monotonic.

What actually carries it is the **blue–yellow axis**, which is precisely the
axis red-green deficiency preserves. Simulated blue channel across the five
stops:

- Deuteranopia: 34 → 58 → 102 → 177 → 215
- Protanopia: 34 → 53 → 94 → 173 → 213

Strictly monotonic in both. A red-green colorblind student sees the ramp run
olive → khaki → gray → lavender: continuous, ordered, unambiguous. They can't
name the colors the same way, but they can tell exactly how close to optimal
they are, which is the only thing the ramp is for.

The scheme is robust across deficiency types by two different mechanisms, which
is a nice property to have fallen into: protanopes and deuteranopes read it on
blue–yellow, while tritanopes — for whom blue–yellow is the failing axis — read
it on the red-green hue sweep that's still there for them.

An earlier candidate ended on a mint green at hue 170, on the assumption that
buying CVD separation meant giving up traffic-light green. Testing said
otherwise: the conventional green at 145 keeps the blue axis monotonic *and*
spaces the five steps more evenly (gaps of 30/40/31/47, against the mint
version's lopsided 24/44/75/38). The ordinary choice was simply the better one.

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
    sail.ts           per-sail force, luff fraction, optimal-trim search
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
with a small router entry. Nothing else serves it.

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
  is paid for without being shown

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
