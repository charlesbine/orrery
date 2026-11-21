# Orrery — Roadmap & Backlog

Outstanding ideas and rendering improvements, in rough priority.

---

## Features

### 1. True-scale toggle
Switch the chart between its topology layout and **real astronomical distances**,
eased over about a second rather than cut. Watching the inner planets collapse
into the sun's glare while Neptune sits six times further out than Jupiter
explains the scale of the solar system in one motion.

Two independent switches:
- **true orbits** — real AU (spanning 0.39 to 39.5, a 100× range)
- **true body sizes** — opt-in separately, since the sun is 109× Earth and at
  true size *and* true distance every planet is sub-pixel

### 2. Guided tour mode
Step outward body by body — camera flies, readout opens, narrative advances.
Arrow keys or a play button.

### 3. Event-driven transfers
`SHIPS` currently run on fixed periods. Wiring transfer arcs to real webhook or
log events (CI/CD deploys, nightly backup completions, API calls) turns the
transfer layer into live telemetry.

---

## Remaining celestial populations

### 4. Scattered disc, Centaurs, Oort cloud
- **Scattered disc** — eccentric bodies overlapping and beyond the Kuiper belt
- **Centaurs** — unstable orbits between Jupiter and Neptune
- **Oort cloud** — subtle outer halo at the far boundary of the system

### 5. Uranus and Neptune ring systems
Only Jupiter and Saturn rings are currently drawn. Uranus has 13 narrow dark
rings; Neptune has its famous incomplete arcs.

---

## Rendering quality

### 6. Greater differentiation across regolith worlds
Rocky/regolith bodies currently vary by seed; adding richer per-body terrain
modes would give minor bodies even more visual individuality.

### 7. Stronger Jovian cloud bands and storm structure
Higher contrast bands, finer vortex detail, and a more turbulent Great Red Spot.

### 8. Per-host station archetypes for single-ring hosts
Hosts without compose shells currently fall back to the default `truss`
archetype. Allowing per-host or per-service archetype overrides in
`orrery.config.json` lets every node carry distinctive station geometry.

### 9. Cached orbit web layer
The 2D backdrop currently re-traces the static orbit ellipses each frame (~1.1 ms
at 13 Mpx). Caching the static ellipses onto a camera-invalidated offscreen
layer (just like the starfield) would leave only the moving trailing arcs to
draw per frame.
