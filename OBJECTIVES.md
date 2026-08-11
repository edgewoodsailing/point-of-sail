# Point-of-sail project objectives

The goal os this project is to create a limited sailing simulator for student
use at the Edgewood Sailing School to help them understand points of sail and
the relationship between the wind, the hull, the sails, and boat speed.

The boat in the UI is abstract, but to the extent that real shapes and
specifications are needed, the model should be the
[Rhodes 19 keelboat](https://sailboatdata.com/sailboat/rhodes-19/).

## Technology

The deliverable is a single web page with Javascript. All state is maintained by
the web page for a single session. There is no long-term client or server state.
The page resets to default settings whenever it is reloaded.

## Interface

The primary interface is a top-down, 2-D line drawing with direct manipulation
of elements. The user can rotate the hull by dragging it, rotate the wind
direction by dragging it, adjust sail trim by dragging the sails, etc.

The diagram shows properly curved sail shapes. When a section of sail is
luffing, that is indicated with an animated fluttering (sine-wave deformation?)
of the sail shape.

Color is used to provide feedback using an interpolated traffic-light system.
Properly trimmed sails are green. Fully luffing sails are red. In-between are
amber. The user sees these color changes in real time as they drag the sails.

Boat speed is indicated by an arrow off the bow of the boat (or off the stern
when sailing backwards) whose length grows as boat speed grows. In addition to
arrow length, color compares the current boat speed to what it would be with
optimal sail trim.

## Prior Art

[By the Lee](https://github.com/leeboardtools/bythelee) — Written entirely in
JavaScript and deliberately separated into a core library, a sailing simulator
engine, and a UI. The sailsim folder holds the physics modeling and doesn't
depend on the 3D rendering code. You could take the force model and render it as
flat SVG.

[Saba_Sailing](https://github.com/Ofek-Shani/Saba_Sailing) — top-down 2D, and
the only one I found that visualizes exactly what you want: sail shape reflects
the wind force applied, loose sails flicker side to side when the wind blows on
them, and sail color shows which side the wind is hitting. Unity rather than
web, but the visual vocabulary is worked out.
