# Point of Sail — Design

Working design document. Expands on [OBJECTIVES.md](OBJECTIVES.md). This is a
living document — we edit it together until we're both happy, then break it into
beads for implementation.

Open questions are collected at the end and marked **[Q]** inline.

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
  // Environment
  trueWindFrom: Radians;      // direction wind blows FROM, world frame
  trueWindSpeed: MetersPerSecond;

  // Boat
  heading: Radians;           // direction the bow points, world frame
  speed: MetersPerSecond;     // signed — negative means sailing backwards

  // Trim: sail chord angle relative to boat centerline.
  // Positive = clew to starboard. Zero = on the centerline.
  mainAngle: Radians;
  jibAngle: Radians;

  // Is the user physically forcing a sail against the wind right now?
  mainHeld: boolean;
  jibHeld: boolean;
}
```

That's it. No history, no session, no persistence — reload resets to defaults, as
the objectives require.

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

**Often only one sail is wrong**, chosen at random. It teaches that the two are
trimmed independently, and it makes the main-versus-jib asymmetry felt: a
mistrimmed main costs far more than a mistrimmed jib, because it's 70% of the
sail area.

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

**[Q6]** An optional `?seed=` URL parameter would let an instructor put a whole
room on the same problem. It's a few lines and adds no UI, but it edges toward
the presets we ruled out. Worth having?

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
| Jib area | ≈ 48.8 sq ft (4.5 m²) |
| Hull speed | 1.34·√17.75 ≈ **5.65 kt** |

The 70/30 main:jib area split matters — it sets how much of the feedback comes
from each sail, and it means a badly trimmed main is much more punishing than a
badly trimmed jib. That asymmetry is worth preserving.

### 3.1 Apparent wind

Modeled always; **displayed only behind a toggle** (default off).

```
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
- Jib: `√(15² + 6.5²)² / 48.8` ≈ **5.5**

**Lift-curve slope**, corrected for finite span:

```
a = 2π·AR / (AR + 2)        // main: ≈ 4.45 /rad  (0.078 /deg)
```

**Attached flow** (|α| below stall, α_stall ≈ 18°):

```
Cl = a · α
Cd = Cd0 + Cl² / (π · AR · e)      // Cd0 ≈ 0.02, e ≈ 0.9
```

giving `Cl_max ≈ 1.4` at the stall — a realistic figure for a soft sail.

**Past stall**, blend over ~10° into the flat-plate model:

```
Cl = 2 · sin α · cos α
Cd = Cd0 + 2 · sin²α
```

The flat-plate limb is not a detail — it is what makes downwind sailing work at
all. On a dead run the sail is square to the wind at α = 90°, where lift is zero
and `Cd ≈ 2.0`. The boat is being pushed, not lifted, and the model should say
so.

**Force assembly.** Lift acts perpendicular to the apparent wind, drag along it.
Sum both sails, rotate into the boat frame, and take the component along the
heading as **driving force**. The lateral component is discarded (no leeway, no
heel), with induced drag already accounted for in `Cd`.

### 3.3 Luffing

Luffing is a *separate concept from trim quality* and must not be conflated with
it (see [§4.2](#42-the-traffic-light)).

A cambered sail needs some positive incidence to hold its shape. As α drops, the
luff breaks first and the collapse propagates aft:

```
α ≥ α_full  (≈ +2°)   → sail fully drawing, no flutter
α_luff < α < α_full   → partial luff, breaking from the luff aft
α ≤ α_luff  (≈ −5°)   → fully luffing, no drive
```

We compute a **luff fraction** ∈ [0,1] — how much of the sail, measured from
the luff aft, has collapsed. That single number drives both the flutter
animation and the force reduction, so what the student sees and what the boat
does can never disagree.

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
- **On release the sail swings back**, animated, to where the wind puts it.

Holding your finger down to hold the boom out is an unusually direct mapping
between the gesture and the real physical act. **[Q1]** Should release really
swing it back, or should a backed sail stay put until dragged back? Swinging
back is more honest, but it means the boat can't be left sitting in the
backwards state for discussion, which may matter for group use around a table.

The jib backs by the same mechanism, which is the other classic way off a
mooring.

### 3.5 Hull resistance and integration

Resistance rises steeply approaching hull speed:

```
R(v) = A·v² + B·v²·(v / v_hull)⁶        v_hull = 2.91 m/s (5.65 kt)
```

The sixth-power term is a shape, not a theory — it produces the wall a
displacement hull hits, so no amount of sail area gets a Rhodes 19 to 9 knots.
Going astern, multiply by ≈ 2.5: transom-first with a stalled keel and rudder is
genuinely much draggier, and students should feel that backing up is slow.

**Speed is integrated, not solved.** Each frame:

```
a = (F_drive − R(v)) / m_effective
v += a · dt
```

with `m_effective` ≈ 880 kg (boat + two crew + ~15% added mass). Three reasons
to integrate rather than solve for equilibrium:

1. Apparent wind depends on speed and speed depends on apparent wind. Integration
   resolves that feedback loop for free; a fixed-point solve has to iterate.
2. Negative speeds fall out naturally, which matters for [§3.4](#34-backing-a-sail).
3. Snapping instantly to a new speed looks wrong. A keelboat takes ~10 s to
   accelerate to hull speed, and that lag is itself a lesson — trim changes don't
   pay off instantly.

The boat still doesn't *translate*; only the speed number evolves. **[Q2]** Does
the ramp-up read as sluggish when you just want to compare two trim settings
side by side? We could shorten the time constant below reality if it hurts play.

### 3.6 Calibration targets

Constants get tuned until the polar hits roughly these marks in 10 kt true:

| Point of sail | TWA | Target speed |
| --- | --- | --- |
| Head to wind | 0° | 0 (in irons) |
| Close hauled | 45° | ≈ 4.2 kt |
| Beam reach | 90° | ≈ 5.4 kt |
| Broad reach | 135° | ≈ 5.2 kt |
| Run | 180° | ≈ 3.5 kt |

Beam reach fastest, run notably slower, and a no-go zone that simply *is* rather
than being drawn on. These become the model layer's unit tests.

---

## 4. Visual design

Top-down 2-D line drawing, SVG, abstract but proportioned like a Rhodes 19.

### 4.1 What's drawn

- **Hull** — a simple outline, beam-to-length ≈ 7:19. Deliberately abstract.
- **Mast** — a dot at the hull's mast station.
- **Main** — the boom drawn as a straight line from mast to clew (the chord),
  with the sail bulging leeward of it as a Bézier arc.
- **Jib** — no boom, so just a curve from the forestay at the bow to the clew.
- **Wind arrow** — outside the boat, at the perimeter (see [§5](#5-direct-manipulation)).
- **Speed arrow** — off the bow, or off the stern when speed is negative. Length
  grows with speed; colored per [§4.3](#43-the-speed-arrow).
- **Apparent wind overlay** — only when toggled on.

Camber depth is a function of trim and apparent wind pressure. When the luff
fraction is non-zero, a traveling sine wave is superimposed on the collapsed
portion — amplitude scaling with how deeply it's luffing, and the fluttering
region extending aft as the collapse spreads. A sail that is *just* starting to
break shows a small ripple at the luff only, which is exactly what a student
should learn to spot.

### 4.2 The traffic light

Green means **optimal**, and deteriorates through amber to red in *both*
directions — undertrimmed and overtrimmed alike. An overtrimmed sail is smooth,
quiet, and slow; without this, it would look identical to a well-trimmed one.

The scale is driven by **driving-force ratio, not angular error**:

```
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
than assumed. Five stops from worst to best:

| Quality | OKLCH | sRGB |
| --- | --- | --- |
| 0.00 | `oklch(0.52 0.20 25)` | `#c21725` |
| 0.25 | `oklch(0.62 0.16 50)` | `#cf630d` |
| 0.50 | `oklch(0.72 0.13 95)` | `#bea333` |
| 0.75 | `oklch(0.81 0.13 155)` | `#75da9c` |
| 1.00 | `oklch(0.88 0.14 170)` | `#64f5c9` |

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

**[Q5]** The optimal endpoint at hue 170 is a mint/aqua green. It has the
cleanest CVD separation, but it's arguably not "traffic-light green." Pulling the
endpoint to ~155 gives a more convincing green and keeps most of the separation.
I lean toward 155–160. Your call — you're the one showing it to students.

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

Support floor is Safari 15.4 / Chrome 111 / Firefox 113, ~93–95% globally.
Worth confirming the ESS iPads aren't on something ancient; if they are, the
palette module can emit sRGB hex fallbacks from the same source values.

### 4.5 Rendering constraints

Line weights need to survive both a phone in someone's hand and an iPad flat on
a table viewed by three students at an angle. Weights scale with viewport rather
than being fixed.

---

## 5. Direct manipulation

An iPad flat on a table, in a small group, plus phones. That means: **no hover
state exists**, touch targets must be large, and targets will overlap.

### Gestures

| Element | Gesture | Notes |
| --- | --- | --- |
| Hull | Drag to rotate | Rotates about the mast |
| Wind direction | Drag the perimeter arrow | Large target, never overlaps the boat |
| Wind speed | Slider | Separate control; easier than dragging arrow length on a phone |
| Main | Drag the boom | Past natural side = backing ([§3.4](#34-backing-a-sail)) |
| Jib | Drag the clew | Same |

Putting the **wind arrow on the perimeter** — a ring around the whole scene
rather than a vector near the boat — solves the worst of the overlap problem by
construction. It gives the wind an enormous, always-reachable target that can
never collide with the sails, and it reinforces the idea that the wind belongs
to the world while trim belongs to the boat.

### Overlap arbitration

The hard case is close hauled, where main and jib are both near the centerline,
on top of each other, and on top of the hull. Approach:

1. **Fat invisible hit paths.** Each draggable gets a transparent stroke of
   ~44 CSS px regardless of its visible line weight.
2. **Nearest-target-within-radius**, not strict topmost-hit. On pointer-down,
   measure distance to each candidate's grab point and take the nearest, with a
   priority tiebreak: jib clew > main boom > hull.
3. **Pointer capture.** Once a drag starts it owns that pointer until release, so
   overlap only matters in the instant of touchdown, never during the drag.
4. **Hull grab excludes the sails' zone.** The quarters and bow are usually
   clear even when everything is sheeted in hard.

**[Q3]** Rule 2 will sometimes guess wrong when main and jib are within a
finger-width of each other. Options: bias toward whichever was grabbed last, or
add a small visual offset so the two clews never render exactly coincident. I
lean toward the offset — a lie in the drawing, but one that keeps the thing
usable.

### Multi-touch

Two students, one on the main and one on the jib, at the same time. Pointer
events support this and the model is stateless enough not to care. For a tool
explicitly designed for small groups around a table, this is worth getting right
rather than treating as a bonus.

---

## 6. Architecture

```
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
  render/
    scene.ts          SVG root, viewBox, responsive layout
    hull.ts
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

TypeScript + Vite, building to static files for embedding in the ESS site.
**[Q4]** Embedding: an `<iframe>` is the safe answer for a WordPress-style host
(no CSS collisions, no script conflicts) but needs a fixed aspect ratio. Do you
know what the ESS site runs on?

---

## 7. Deliberately out of scope

Named here so we can decline them consistently rather than re-litigating each
one. Several are worth revisiting *after* v1 works.

**Out for now, plausible later (as toggles):**

- Leeway — the crab angle between heading and track
- Telltales
- Heel, which top-down can only hint at symbolically

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

- Main blanketing the jib downwind (real, and the reason a run is slower than
  the model will say — worth reconsidering if runs feel wrong)
- Slot effect between main and jib
- Sail twist, draft position, halyard/outhaul/cunningham controls
- Spinnaker
- Crew weight and movement
- Waves, current, gusts, wind shear

---

## 8. Build order

Each phase leaves something demonstrable, which is what makes this bead-able.

1. **Static scene** — SVG hull, mast, boom, jib, perimeter wind arrow, drawn
   from a hardcoded state object. No physics, no interaction.
2. **Direct manipulation** — rotate hull, rotate wind, trim both sails. Shapes
   follow state. Touch arbitration and multi-touch. Still no forces.
3. **Force model** — apparent wind, foil curves, hull resistance, integration,
   speed arrow. Calibration table from [§3.6](#36-calibration-targets) as unit
   tests. This is the phase where the simulator becomes true.
4. **Feedback** — trim-quality color, luff fraction, flutter animation, ghost
   boat, speed-arrow color.
5. **Backing** — held sails, reversed force, sailing astern, release animation.
6. **Polish and ship** — wind speed control, apparent wind toggle, touch tuning
   on real hardware, colorblind check, embed.

Phases 1–2 are pure UI and phase 3 is pure model, so they're independent and
could be built in either order — or in parallel.

---

## 9. Open questions

- **[Q1]** [§3.4](#34-backing-a-sail) — On release, should a backed sail swing
  back to its natural position, or stay put so the group can discuss the
  backwards state?
- **[Q2]** [§3.5](#35-hull-resistance-and-integration) — Is realistic
  acceleration lag (~10 s to hull speed) too sluggish for quick A/B comparison
  of trim settings?
- **[Q3]** [§5](#5-direct-manipulation) — How to disambiguate main and jib when
  they're within a finger-width close hauled. Visual offset, or last-grabbed
  bias?
- **[Q4]** [§6](#6-architecture) — What does the ESS site run on, and is an
  iframe embed acceptable?
- **[Q5]** [§4.4](#44-color) — Optimal-end hue: 170 (mint, best CVD separation)
  or ~155 (more convincingly "green")? I lean 155–160.
- **[Q6]** [§2.1](#21-initial-state-a-random-solvable-problem) — Add a `?seed=`
  URL parameter so an instructor can put a room on the same problem?

### Settled

- Apparent wind is modeled always, shown behind a toggle (default off)
- Trim quality is keyed to driving-force loss, deteriorating in both directions
- Speed is integrated over time; the boat still never translates
- Backing a sail = holding the pointer down; release swings it back
- Colors authored in OKLCH, applied via CSS only, never as SVG presentation
  attributes
- Opening state is randomized and mistrimmed, within bounds
