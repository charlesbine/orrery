/* ─────────────────────────────────────────────────────────────────────────
   hulls.js — the fleet's geometry, as meshes.

   One hull per SERVICE FAMILY, so a silhouette tells you what kind of thing
   you are looking at before you read the label: relays carry masts and dishes,
   AI stations reject heat through radiator farms, app stations spread solar
   wings. Within a family the shape is the same and the SEED moves the details —
   how many fins, how long the spine, where the pods sit — so two Ollama
   stations are recognisably siblings without being the same object twice.

   Everything here is plain data. dev/bake.js turns it into an atlas; nothing
   in this file knows about pixels.

   AXES, and they matter because the chart is a fixed view:
     +x  along the hull, and for craft it is the direction of travel
     +y  across the orbital plane
     +z  up, out of the plane

   MATERIALS are indices, resolved to colour at bake time:
     0 hull · 1 panel (darker) · 2 strut · 3 fitting (bright) · 4 window (emits)
   ───────────────────────────────────────────────────────────────────────── */

const HULL = 0, PANEL = 1, STRUT = 2, FITTING = 3, WINDOW = 4;
/* A dish reflector is a matte white composite, not polished metal. Without its
   own material it takes the hull's metalness, blows out against the sky and
   swallows the whole silhouette. */
const DISH = 5;

/* Three more, and they exist for one reason: DIFFERENTIATION. Relay is the
   only family anyone can name at a glance, and that is entirely because it
   carries one big unmistakable object. Every other breed was a greebled
   cylinder wearing slightly different accessories, and greebling all of them
   harder only made a fleet of identical machined cylinders. A family needs a
   hero feature, and a hero feature needs a material of its own or it just
   reads as more hull. */
const SOLAR = 6;     // photovoltaic: near-black indigo, glassy, drinks light
const RADPANEL = 7;  // heat rejection: matte white, the opposite of everything
const ENGINE = 8;    // the hot part of a nozzle
/* Radiator TUBING, as distinct from the panel it is bonded to. The structure
   stays cool white; the tubes carrying the working fluid glow sodium amber.
   That contrast is the whole read — a radiator you can see the heat moving
   through, rather than a warm-tinted plate. */
const RADTUBE = 9;

/* ── livery ──────────────────────────────────────────────────────────────
   One gentle accent colour per breed, painted onto a few parts rather than
   tinting the hull. Shape carries most of the identification and should keep
   carrying it — this is the second glance, not the first.

   Some families do not get one and that is deliberate: relay already has the
   big white dish, the ring has its band of windows, radiator has the sodium
   tubes and wing the near-black cells. Adding paint to those competes with a
   mark they already have. The four that get livery are the four with nothing
   but grey.

   The colour is a UNIFORM rather than a material, because it varies per
   family while the material does not. */
const ACCENT = 10;   // wears the family's livery colour
const ION = 11;      // a cold electric drive, as against a chemical one
const PLUME = 12;    // exhaust, intensity ramped along its length

const LIVERY = {
  sensor:   [0.36, 0.80, 0.92],   // cold cyan — cryo-cooled optics
  stack:    [0.40, 0.85, 0.54],   // signal green — services running
  hab:      [0.72, 0.52, 0.95],   // violet — the gateway everything docks at
  truss:    [0.95, 0.74, 0.22],   // hazard yellow — unclassified freight
  tender:   [0.98, 0.72, 0.30],   // warm, matching its chemical engines
  courier:  [0.42, 0.68, 1.00],   // ion blue, matching its drives
  derelict: [0.62, 0.30, 0.26],   // oxidised; nothing here is being maintained
  relay:    [0.80, 0.84, 0.90],   // unused — the dish is the mark
  ring:     [0.80, 0.84, 0.90],   // unused — the windows are the mark
  wing:     [0.30, 0.36, 0.78],
  radiator: [1.00, 0.58, 0.22],
};

/* Surface detail lives in greeble.js — see the header there for why it is the
   part that matters most. Node requires it; the forge preloads it. */
const G = (typeof require !== "undefined") ? require("./greeble.js") : window.GREEBLE;
const MATS = { HULL, PANEL, STRUT, FITTING, WINDOW, DISH, SOLAR, RADPANEL,
               ENGINE, RADTUBE, ACCENT, ION, PLUME };

/* The side of a hull the chart can actually SEE.
 *
 * Established by experiment, not by reasoning about the matrix — I had this
 * backwards and every window went onto the face turned away from the viewer.
 * The world is rotated -asin(COS) about x before an orthographic camera on +z,
 * which sends world -y toward the camera and world +z up the screen. So -y is
 * the near face. Anything meant to be read goes here or is not in the picture. */
const WATCH = [0, -0.86, 0.50];

/* Deterministic per-hull RNG. Two stations with the same seed must bake
   identical, or a re-bake silently reshuffles the whole fleet. */
function rng(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/* ── mesh building ──────────────────────────────────────────────────────── */

const mesh = () => ({ verts: [], tris: [] });

function addQuad(m, a, b, c, d, mat) {
  const i = m.verts.length;
  m.verts.push(a, b, c, d);
  m.tris.push([i, i + 1, i + 2, mat], [i, i + 2, i + 3, mat]);
}

/* Axis-aligned box. `mats` may be one material for the whole box or six, in
   face order -x +x -y +y -z +z, which is what lets a hull carry a window strip
   down one side without becoming a separate object. */
function box(m, cx, cy, cz, sx, sy, sz, mats) {
  const M = Array.isArray(mats) ? mats : [mats, mats, mats, mats, mats, mats];
  const x0 = cx - sx, x1 = cx + sx, y0 = cy - sy, y1 = cy + sy, z0 = cz - sz, z1 = cz + sz;
  const P = (x, y, z) => [x, y, z];
  addQuad(m, P(x0,y0,z0), P(x0,y1,z0), P(x0,y1,z1), P(x0,y0,z1), M[0]);
  addQuad(m, P(x1,y0,z0), P(x1,y0,z1), P(x1,y1,z1), P(x1,y1,z0), M[1]);
  addQuad(m, P(x0,y0,z0), P(x0,y0,z1), P(x1,y0,z1), P(x1,y0,z0), M[2]);
  addQuad(m, P(x0,y1,z0), P(x1,y1,z0), P(x1,y1,z1), P(x0,y1,z1), M[3]);
  addQuad(m, P(x0,y0,z0), P(x1,y0,z0), P(x1,y1,z0), P(x0,y1,z0), M[4]);
  addQuad(m, P(x0,y0,z1), P(x0,y1,z1), P(x1,y1,z1), P(x1,y0,z1), M[5]);
}

/* Cylinder along +x, capped. Low segment counts on purpose: these are hard
   surfaces at a few dozen pixels, and faceting reads as machined. */
function cyl(m, cx, r0, r1, len, seg, mat, capMat) {
  const a = cx - len, b = cx + len;
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
    const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
    addQuad(m,
      [a, c0 * r0, s0 * r0], [b, c0 * r1, s1 * 0 + s0 * r1],
      [b, c1 * r1, s1 * r1], [a, c1 * r0, s1 * r0], mat);
    // caps as fans from the axis
    const i0 = m.verts.length;
    m.verts.push([b, 0, 0], [b, c0 * r1, s0 * r1], [b, c1 * r1, s1 * r1]);
    m.tris.push([i0, i0 + 1, i0 + 2, capMat === undefined ? mat : capMat]);
    const i1 = m.verts.length;
    m.verts.push([a, 0, 0], [a, c1 * r0, s1 * r0], [a, c0 * r0, s0 * r0]);
    m.tris.push([i1, i1 + 1, i1 + 2, capMat === undefined ? mat : capMat]);
  }
}

/* ── the hull extruder ──────────────────────────────────────────────────────

   This is the method from a1studmuffin's SpaceshipGenerator, which is the thing
   that actually makes procedural hulls look like hulls: you do not place boxes,
   you EXTRUDE a cross-section forward over and over, and at every step you
   translate, scale AND ROTATE it a little. The rotation is the part that
   matters. A box gives you one lit quad and one dark quad and reads as paper no
   matter how it is shaded; a section that turns a few degrees per step gives
   every panel its own angle to the sun, and the hull resolves into a solid.

   The cross-section is an OCTAGON rather than a rectangle, which is a bevel by
   construction: eight faces round a hull instead of four, so the edges catch a
   highlight rather than being a hard switch between two tones.  */

const SECT = 8;

/* An octagonal ring in the frame (right, up) at `pos`, with the corners pulled
   in by `chamfer` so it reads as a machined box rather than a tube. */
function section(pos, right, up, hy, hz, chamfer) {
  const pts = [];
  for (let i = 0; i < SECT; i++) {
    const a = (i / SECT) * Math.PI * 2 + Math.PI / SECT;
    let cy = Math.cos(a), cz = Math.sin(a);
    // square the circle off, then knock the corners back
    const k = 1 / Math.max(Math.abs(cy), Math.abs(cz));
    cy *= k * (1 - chamfer) + chamfer * 0.72;
    cz *= k * (1 - chamfer) + chamfer * 0.72;
    pts.push([
      pos[0] + right[0] * cy * hy + up[0] * cz * hz,
      pos[1] + right[1] * cy * hy + up[1] * cz * hz,
      pos[2] + right[2] * cy * hy + up[2] * cz * hz,
    ]);
  }
  return pts;
}

const vadd = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const vmul = (a, s) => [a[0]*s, a[1]*s, a[2]*s];
const vnorm = (a) => { const l = Math.hypot(...a) || 1; return [a[0]/l, a[1]/l, a[2]/l]; };
const vcross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

/* Rotate `v` about `axis` by `ang`. Rodrigues; used once per extrusion step. */
function vrot(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = vcross(axis, v);
  const d = axis[0]*v[0] + axis[1]*v[1] + axis[2]*v[2];
  return [
    v[0]*c + k[0]*s + axis[0]*d*(1-c),
    v[1]*c + k[1]*s + axis[1]*d*(1-c),
    v[2]*c + k[2]*s + axis[2]*d*(1-c),
  ];
}

function bridge(m, a, b, mat) {
  for (let i = 0; i < SECT; i++)
    addQuad(m, a[i], a[(i+1)%SECT], b[(i+1)%SECT], b[i], mat);
}
function cap(m, ring, mat, flip) {
  const i0 = m.verts.length;
  m.verts.push(...ring);
  for (let i = 1; i < SECT - 1; i++)
    m.tris.push(flip ? [i0, i0+i+1, i0+i, mat] : [i0, i0+i, i0+i+1, mat]);
}

/* Extrude a hull along a spine, returning every ring so features can be hung
   off the result. `o` carries the character of a family: how much it tapers,
   how hard it bends, how many segments. */
function spine(m, rand, o) {
  let pos = o.from || [0, 0, 0];
  let fwd = vnorm(o.dir || [1, 0, 0]);
  let up  = vnorm(o.up  || [0, 0, 1]);
  let right = vnorm(vcross(fwd, up));
  let hy = o.hy, hz = o.hz;
  const rings = [];

  let ring = section(pos, right, up, hy, hz, o.chamfer ?? 0.5);
  cap(m, ring, o.mat ?? PANEL, true);
  rings.push({ ring, pos, fwd, right, up, hy, hz });

  for (let i = 0; i < o.segs; i++) {
    const t = i / Math.max(1, o.segs - 1);
    const len = o.len * (0.55 + rand() * 0.9);
    pos = vadd(pos, vmul(fwd, len));

    /* the two turns per step. Small — a hull that bends hard reads as a worm */
    const bend = (o.bend ?? 0.16);
    fwd = vnorm(vrot(fwd, up,    (rand() - 0.5) * bend));
    fwd = vnorm(vrot(fwd, right, (rand() - 0.5) * bend));
    right = vnorm(vcross(fwd, up));
    up = vnorm(vcross(right, fwd));

    /* Taper, with the odd step flaring back out so it is not a smooth cone —
       but CLAMPED. Unbounded, a run of flares compounds into a section three
       times the starting size, and a section that big is a pair of enormous
       blank quads that no amount of surface detail can rescue. */
    const flare = rand() < (o.flare ?? 0.25);
    const k = flare ? 1.0 + rand() * 0.45 : (o.taper ?? 0.86) + rand() * 0.16;
    hy *= k; hz *= k * (0.9 + rand() * 0.25);
    hy = Math.min(Math.max(hy, 0.02), o.hy * 1.35);
    hz = Math.min(Math.max(hz, 0.02), o.hz * 1.35);

    ring = section(pos, right, up, hy, hz, o.chamfer ?? 0.5);
    bridge(m, rings[rings.length - 1].ring, ring,
           i % 3 === 1 ? PANEL : (o.mat ?? HULL));
    rings.push({ ring, pos, fwd, right, up, hy, hz });
  }
  cap(m, ring, o.mat ?? PANEL, false);
  return rings;
}

/* Asymmetric growths, straight from step 2 of the reference: pick somewhere on
   the hull and grow a smaller stack out sideways, shrinking each time. Without
   this every hull is a single tapered tube and the fleet looks stamped. */
function growth(m, rand, r, dir, n, scale) {
  /* Starts ON the parent's axis, so the first sections are buried inside the
     hull and the growth is joined to it by construction. Starting outside —
     offset by the half-section — was a bet that the offset direction and the
     hull's real surface agree, and on a spine that bends they do not: the
     growth ends up parked in space beside the ship with a visible gap. */
  let pos = r.pos.slice();
  let fwd = vnorm(dir);
  let up = vnorm(Math.abs(fwd[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]);
  let right = vnorm(vcross(fwd, up));
  up = vnorm(vcross(right, fwd));
  let hy = scale, hz = scale * (0.7 + rand() * 0.6);
  let prev = section(pos, right, up, hy, hz, 0.5);
  const rings = [{ ring: prev, pos, fwd, right, up, hy, hz }];
  for (let i = 0; i < n; i++) {
    /* Short steps and a gentle taper. Long steps with a hard shrink produced a
       smooth cone half the length of the ship — a whisker, not a machine. */
    pos = vadd(pos, vmul(fwd, scale * (0.7 + rand() * 0.7)));
    fwd = vnorm(vrot(fwd, up, (rand() - 0.5) * 0.4));
    right = vnorm(vcross(fwd, up));
    hy *= 0.80 + rand() * 0.18; hz *= 0.80 + rand() * 0.18;
    const cur = section(pos, right, up, hy, hz, 0.5);
    bridge(m, prev, cur, i === 0 ? HULL : PANEL);
    rings.push({ ring: cur, pos, fwd, right, up, hy, hz });
    prev = cur;
  }
  cap(m, prev, FITTING, false);
  /* Detail it. A growth is a piece of the ship, and an undetailed one next to
     a greebled hull does not read as restraint — it reads as unfinished, and
     at this size it reads as a paper fin. */
  greebleSpine(m, rand, rings, { panels: 5, relief: 0.18, coverage: 0.9, budget: 90 });
  return rings;
}

/* Detail the hull that `spine` just extruded.
 *
 * This is the single most important call in the file. The extruder gives a
 * beautifully turned octagonal tube and a tube is exactly as featureless at
 * eight metres as at eight hundred — nothing on it has a knowable size. Every
 * family below except `ring` is built on a spine, so detailing the spine is
 * what takes the whole fleet from "turned wooden toy" to "machinery".
 *
 * Each segment side is a general quad, not a parallelogram: the section tapers,
 * flares and rotates between rings. greeble.js's bilinear frame handles that,
 * which is why the panels lie ON the hull rather than hovering off the taper.
 */
function greebleSpine(m, rand, rings, o = {}) {
  /* Per FACE, not per hull. A single shared pool is spent by the first few
     segments and every face after it silently renders bare — which is exactly
     why these hulls came out machined at the nose and a blank white lump at the
     tail. The starved end is always the same end, so it never reads as
     variation; it reads as unfinished. */
  const per = Math.max(8, Math.round((o.budget ?? 420) / (rings.length * SECT)) * 3);
  const cover = o.coverage ?? 0.72;
  for (let s = 0; s < rings.length - 1; s++) {
    const A = rings[s], B = rings[s + 1];
    /* BANDING, and it is the difference between machinery and noise.
       Detailing every segment to the same density gives an even carpet of
       greebles, which reads as static — Kinnear & Kaplan's "confusion" end of
       the scale. Real hulls alternate: a run of quiet plating, then a dense
       equipment bay, then quiet again. The calm bands are not wasted space,
       they are what gives the busy ones somewhere to be busy against. */
    const band = rand();
    const dense = band > 0.62, calm = band < 0.30;
    const panels = calm ? 4 : dense ? Math.round((o.panels ?? 7) * 1.5) : (o.panels ?? 7);
    const relief = (calm ? 0.30 : dense ? 1.25 : 0.8) * (o.relief ?? 0.30);
    for (let i = 0; i < SECT; i++) {
      if (rand() > cover) continue;
      const q0 = A.ring[i], q1 = A.ring[(i + 1) % SECT];
      const q2 = B.ring[(i + 1) % SECT], q3 = B.ring[i];
      const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
      const U = sub(q1, q0), V = sub(q3, q0);
      const N = vnorm(vcross(U, sub(q2, q0)));
      const f = { O: q0, U, V,
                  W: [q0[0]-q1[0]+q2[0]-q3[0], q0[1]-q1[1]+q2[1]-q3[1],
                      q0[2]-q1[2]+q2[2]-q3[2]], N };
      const scale = Math.min(Math.hypot(...U), Math.hypot(...V));
      G.greebleFace(m, addQuad, f, rand, {
        panels, height: scale * relief, minSize: calm ? 0.2 : 0.11,
        depth: calm ? 0 : (o.depth ?? 2), M: MATS,
        budget: { n: calm ? Math.round(per * 0.4) : per },
      });
    }
  }
}

/* A flat array — solar or radiator — that the chart can actually SEE.
 *
 * The camera sits 24° above the orbital plane, so world y is squashed to 0.4
 * on screen while world z keeps 0.92. A panel lying in the plane therefore
 * collapses to a scratch, which is precisely what happened to both of these
 * families: they were built as plates spanning x–y and rendered as horizontal
 * lines. A panel has to span x–z — standing up out of the plane — to be seen
 * as a panel at all.
 *
 * They are then stepped along y, which is the one direction that separates
 * them without either overlapping or vanishing: each successive panel slides
 * a little way up the screen, so the array reads as a stack of parallel
 * plates seen at a rake, which is exactly what a radiator farm looks like.
 */
function array(m, rand, o) {
  const n = o.n, w = o.w, h = o.h, mat = o.mat;
  for (let i = 0; i < n; i++) {
    const y = (i - (n - 1) / 2) * o.step;
    const cx = o.x, cz = o.z + (o.rise ?? 0) * (i - (n - 1) / 2);
    const yy = o.y + y;
    /* The frame sits OUTSIDE the panel's span in z, and every inner part is
       strictly thinner in y than the frame is. Sharing a plane with the panel
       — which is what happened when the rails sat exactly at cz and cz + h —
       gives two surfaces at the same depth and the renderer flickers between
       them. The gaps here are structural, not decorative. */
    const rail = 0.009;
    box(m, cx, yy, cz - rail, w + 0.012, o.thick * 1.6, rail, STRUT);
    box(m, cx, yy, cz + h + rail, w + 0.012, o.thick * 1.6, rail, STRUT);
    for (const sx of [1, -1])                       // side rails, closing the frame
      box(m, cx + sx * (w + 0.006), yy, cz + h / 2, 0.006, o.thick * 1.6, h / 2, STRUT);

    if (o.tubes) {
      /* RADIATOR TUBING. A flat plate is a plate — what makes a radiator read
         as a radiator is that you can see the working fluid's path: a rank of
         parallel tubes running between two headers, glowing the sodium amber
         of metal that is dumping heat. The gaps between tubes matter as much
         as the tubes: they are what stops it collapsing back into a slab. */
      const t = o.tubes, pitch = h / t;
      for (let j = 0; j < t; j++) {
        const tz = cz + pitch * (j + 0.5);
        box(m, cx, yy, tz, w * 0.96, o.thick * 0.85, pitch * 0.30, RADTUBE);
        // the dark web the tubes are bonded to, set back so it never coplanes
        box(m, cx, yy, tz, w * 0.94, o.thick * 0.45, pitch * 0.46, PANEL);
      }
      // headers at both ends, carrying the fluid across the rank
      for (const sx of [1, -1])
        box(m, cx + sx * w * 0.99, yy, cz + h / 2, w * 0.035, o.thick * 1.2, h * 0.5, RADPANEL);
    } else if (o.cells) {
      /* Subdivided into real cells with gaps. One big rectangle is a slab of
         colour at any size; the grid is what makes it read as an array, and
         the gaps are what make it read as thin.
         And then subdivided AGAIN — a cell with nothing inside it is the same
         low-resolution failure the radiator fins had: the smallest feature on
         the wing was a whole cell, so the wing had no knowable size. Real
         arrays carry interconnect gridlines across every cell, and those lines
         are what the eye measures the panel against. */
      const c = o.cells;
      const rows = 3 + Math.floor(rand() * 3);
      for (let j = 0; j < c; j++) {
        const cw = (w * 2) / c;
        const ccx = cx - w + cw * (j + 0.5);
        box(m, ccx, yy, cz + h / 2, cw * 0.42, o.thick, h * 0.46, mat);
        // interconnect busbars across the cell, and the frame around it
        for (let r = 1; r < rows; r++)
          box(m, ccx, yy, cz + (h * r) / rows, cw * 0.40, o.thick * 1.25, h * 0.006, STRUT);
        for (const sx of [-1, 1])
          box(m, ccx + sx * cw * 0.42, yy, cz + h / 2,
              cw * 0.018, o.thick * 1.3, h * 0.46, STRUT);
      }
    } else {
      box(m, cx, yy, cz + h / 2, w, o.thick, h * 0.46, mat);
    }
  }
}

/* A box from a centre and three half-axes, so geometry can be built at an
   ANGLE. `box` is axis-aligned, which is fine for a bus and useless for
   anything folded, canted or hinged. (U, V, N) must be right-handed. */
function slab(m, C, U, V, N, mat) {
  const P = (u, v, n) => [
    C[0] + U[0]*u + V[0]*v + N[0]*n,
    C[1] + U[1]*u + V[1]*v + N[1]*n,
    C[2] + U[2]*u + V[2]*v + N[2]*n,
  ];
  addQuad(m, P(-1,-1, 1), P( 1,-1, 1), P( 1, 1, 1), P(-1, 1, 1), mat);
  addQuad(m, P(-1,-1,-1), P(-1, 1,-1), P( 1, 1,-1), P( 1,-1,-1), mat);
  addQuad(m, P( 1,-1,-1), P( 1, 1,-1), P( 1, 1, 1), P( 1,-1, 1), mat);
  addQuad(m, P(-1,-1,-1), P(-1,-1, 1), P(-1, 1, 1), P(-1, 1,-1), mat);
  addQuad(m, P(-1, 1,-1), P(-1, 1, 1), P( 1, 1, 1), P( 1, 1,-1), mat);
  addQuad(m, P(-1,-1,-1), P( 1,-1,-1), P( 1,-1, 1), P(-1,-1, 1), mat);
}

/* A round tube: a cylinder about `C` with half-axis `A` and radius vectors
   `R1`, `R2` (perpendicular, both of length r, with R1 x R2 along A).
   Round, because a flat slab painted hot is a LINE — the whole reason a tube
   looks like a tube is that its curved surface shades continuously across its
   width and carries a specular highlight down its length. */
function tube(m, C, A, R1, R2, seg, mat) {
  const P = (t, s) => [
    C[0] + A[0]*s + R1[0]*Math.cos(t) + R2[0]*Math.sin(t),
    C[1] + A[1]*s + R1[1]*Math.cos(t) + R2[1]*Math.sin(t),
    C[2] + A[2]*s + R1[2]*Math.cos(t) + R2[2]*Math.sin(t),
  ];
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
    addQuad(m, P(t0, -1), P(t1, -1), P(t1, 1), P(t0, 1), mat);
    // caps, as fans from the axis
    const i0 = m.verts.length;
    m.verts.push([C[0]+A[0], C[1]+A[1], C[2]+A[2]], P(t0, 1), P(t1, 1));
    m.tris.push([i0, i0 + 1, i0 + 2, mat]);
    const i1 = m.verts.length;
    m.verts.push([C[0]-A[0], C[1]-A[1], C[2]-A[2]], P(t1, -1), P(t0, -1));
    m.tris.push([i1, i1 + 1, i1 + 2, mat]);
  }
}

/* One radiator fin, CANTED by `ang` about the hull axis.
 *
 * Flat parallel fins all facing the same way is a venetian blind: every panel
 * takes exactly the same light, so the rank renders as one grey rectangle with
 * stripes on it and no depth at all. Canting alternate fins turns the rank
 * into a folded accordion — consecutive panels catch the key at different
 * angles, one bright and one dark, and that alternation is what makes a stack
 * of plates read as occupying space rather than as a drawing of a stack.
 */
function fin(m, rand, C, w, hh, t, ang, tubes) {
  const s = Math.sin(ang), c = Math.cos(ang);
  const U = [w, 0, 0], V = [0, s * hh, -c * hh], N = [0, c * t, s * t];
  const vs = (k) => [V[0] * k, V[1] * k, V[2] * k];
  const at = (k) => [C[0] + vs(k)[0], C[1] + vs(k)[1], C[2] + vs(k)[2]];

  // the dark web the tubes are bonded to
  slab(m, C, U, [V[0]*0.92, V[1]*0.92, V[2]*0.92], [N[0]*0.4, N[1]*0.4, N[2]*0.4], PANEL);
  // edge rails, top and bottom, standing clear of the web in N
  for (const k of [-1, 1])
    slab(m, at(k), [w * 1.02, 0, 0], vs(0.055), [N[0]*1.5, N[1]*1.5, N[2]*1.5], STRUT);
  // headers at both ends, carrying fluid across the rank
  for (const sx of [-1, 1])
    slab(m, [C[0] + sx * w * 1.0, C[1], C[2]], [w * 0.04, 0, 0],
         [V[0]*0.98, V[1]*0.98, V[2]*0.98], [N[0]*1.2, N[1]*1.2, N[2]*1.2], RADPANEL);
  /* The tubes: ROUND, and standing proud of the web on both faces so they
     catch a highlight on top and drop into shadow underneath. Flat slabs read
     as painted stripes no matter what colour they are — the form has to be
     there for the light to find. */
  const vl = Math.hypot(...V) || 1, nl = Math.hypot(...N) || 1;
  const Vh = [V[0]/vl, V[1]/vl, V[2]/vl], Nh = [N[0]/nl, N[1]/nl, N[2]/nl];
  /* FAT enough to be a cylinder at the size this is actually seen. Thin tubes
     are more realistic and completely pointless: at a handful of pixels across
     there is nowhere for the shading to happen, so a thin tube renders as a
     one-pixel line whatever its geometry. Fewer, fatter tubes is the version
     that survives the projection. */
  const rad = Math.min((1.72 / tubes) * vl * 0.34, vl * 0.20);
  for (let j = 0; j < tubes; j++) {
    const k = -0.86 + (1.72 * (j + 0.5)) / tubes;
    for (const face of [1, -1]) {
      const C2 = at(k);
      const off = nl * 0.9 + rad * 0.55;
      tube(m, [C2[0] + Nh[0]*off*face, C2[1] + Nh[1]*off*face, C2[2] + Nh[2]*off*face],
           [w * 0.97, 0, 0],
           [Vh[0]*rad, Vh[1]*rad, Vh[2]*rad],
           [Nh[0]*rad, Nh[1]*rad, Nh[2]*rad], 10, RADTUBE);
    }
  }

  /* ── the tier that was missing ───────────────────────────────────────────
   *
   * A fin was six big bands and NOTHING below them — no feature smaller than a
   * stripe anywhere on it. Next to a hull carrying hundreds of greebles it
   * therefore read as low resolution, which is the same failure as the bare
   * cylinders at the start of all this, one level down: you read an object's
   * size from its smallest repeated feature, and a panel whose smallest
   * feature is a sixth of its height has no size at all.
   *
   * So: bays, saddles and fasteners. None of it is individually visible at
   * chart scale, and that is fine — the point is that the detail CONTINUES
   * below the scale you can resolve, which is what makes a surface look like
   * hardware instead of a texture. */
  const bays = 3 + Math.floor(rand() * 3);
  const P = (u, k) => [
    C[0] + U[0]*u + V[0]*k, C[1] + U[1]*u + V[1]*k, C[2] + U[2]*u + V[2]*k,
  ];
  for (let b = 1; b < bays; b++) {
    /* Jittered, because evenly spaced ribs plus evenly spaced tubes is a
       waffle — a printed grid, which is the regular failure the paper warns
       about just as much as the noisy one. Uneven bays read as structure
       placed where loads are. */
    const u = -1 + (2 * b) / bays + (rand() - 0.5) * (0.9 / bays);
    /* PANEL, and barely proud. A rib in STRUT stood off the web far enough to
       catch a hard specular down its whole length, which put a bright vertical
       bar across every fin — structure should recede, not out-shout the tubes
       it is holding. */
    slab(m, P(u, 0), [w * 0.008, 0, 0],
         [V[0]*0.88, V[1]*0.88, V[2]*0.88],
         [N[0]*0.55, N[1]*0.55, N[2]*0.55], PANEL);
    // saddle clamps holding the tubes down where they cross a rib — not every
    // crossing, so the eye finds a rhythm rather than a matrix
    for (let j = 0; j < tubes; j++) {
      if (rand() < 0.3) continue;
      const k = -0.86 + (1.72 * (j + 0.5)) / tubes;
      /* Clamped to stay INSIDE the panel. A saddle is sized off the tube, and
         on the outermost tube that reached past the edge rail and hung in
         space beyond the fin. Nothing should overhang an edge it is bolted
         to. */
      const ext = Math.min(rad * 1.15, Math.max(0, (0.95 - Math.abs(k)) * vl));
      if (ext < rad * 0.4) continue;
      for (const face of [1, -1]) {
        const Q = P(u, k), o2 = (nl * 0.9 + rad * 0.55) * face;
        slab(m, [Q[0] + Nh[0]*o2, Q[1] + Nh[1]*o2, Q[2] + Nh[2]*o2],
             [w * 0.016, 0, 0],
             [Vh[0]*ext, Vh[1]*ext, Vh[2]*ext],
             [Nh[0]*rad*1.10, Nh[1]*rad*1.10, Nh[2]*rad*1.10], STRUT);
      }
    }
  }
  /* Fasteners along both edge rails, at a finer pitch than the bays. STRUT
     rather than FITTING: FITTING is the brightest, glossiest material in the
     set, and putting it on the smallest parts made every one of them a
     blown-out speck. The smallest details should be the quietest. */
  const bolts = bays * 3;
  for (let b = 0; b < bolts; b++) {
    const u = -0.94 + (1.88 * (b + 0.5)) / bolts;
    for (const k of [-1, 1])
      slab(m, P(u, k * 0.97), [w * 0.009, 0, 0],
           [Vh[0]*rad*0.22, Vh[1]*rad*0.22, Vh[2]*rad*0.22],
           [N[0]*1.35, N[1]*1.35, N[2]*1.35], STRUT);
  }
}

/* An open instrument barrel — a telescope tube with a stepped sunshade and a
 * dark aperture you can see into.
 *
 * The strongest thing a hero feature can be is a HOLE. Every other object in
 * this fleet is a solid catching light, so a black open mouth ringed by baffles
 * is the one shape that cannot be confused with any of them, and it says
 * "this thing looks at things" without needing a label.
 */
function barrel(m, rand, x0, x1, r, o = {}) {
  const seg = 14;
  /* Built along +z — pointing UP out of the orbital plane, not along the hull.
     An aperture is only a hero feature if you can see into it, and the chart
     looks along -y from 24 degrees above: a barrel lying along x shows the
     camera nothing but its side, and the black mouth that justifies the whole
     shape never appears. Pointed up, the mouth faces the viewer. It is also
     the right answer for what the thing does, which is look outward. */
  const P = (t, rr, d) => [Math.cos(t) * rr, Math.sin(t) * rr, d];
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
    /* Wound so the normal points OUT. Ordering these the other way made every
       exterior quad backfacing, so the renderer culled the whole tube and drew
       the dark bore behind it — the barrel came out a black cylinder and read
       as an unlit shape rather than a lit one. */
    addQuad(m, P(t0, r, x0), P(t1, r, x0), P(t1, r, x1), P(t0, r, x1), HULL);
    /* …and detail it. A bare tube is a bare tube whichever way it points, and
       an undetailed barrel would have reintroduced the exact "everything is a
       cylinder" problem the hero features exist to solve. */
    const q0 = P(t0, r, x0), q1 = P(t1, r, x0), q2 = P(t1, r, x1), q3 = P(t0, r, x1);
    const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
    const U = sub(q1, q0), V = sub(q3, q0);
    G.greebleFace(m, addQuad,
      { O: q0, U, V, W: [0, 0, 0], N: vnorm([Math.cos(t0) + Math.cos(t1),
                                             Math.sin(t0) + Math.sin(t1), 0]) },
      rand, { panels: 6, height: r * 0.09, minSize: 0.13, depth: 1,
              M: MATS, budget: { n: 16 } });
    /* Inside, wound the other way so it faces down the bore. Without this the
       barrel is a solid rod from the front — the aperture is the whole point,
       and an aperture is an interior surface. */
    const ri = r * 0.88;
    addQuad(m, P(t0, ri, x0), P(t0, ri, x1), P(t1, ri, x1), P(t1, ri, x0), PANEL);
    // the rim joining the two, so the mouth has thickness
    addQuad(m, P(t0, r, x1), P(t1, r, x1), P(t1, ri, x1), P(t0, ri, x1), STRUT);
    // and the back, closed
    addQuad(m, P(t0, ri, x0), P(t1, ri, x0), P(t1, r, x0), P(t0, r, x0), PANEL);
  }
  /* Light baffles down the bore. They catch the key at grazing incidence and
     turn a flat black disc into a receding tunnel, which is what sells depth. */
  const baffles = o.baffles ?? 3;
  for (let b = 1; b <= baffles; b++) {
    const bx = x1 - (x1 - x0) * (b / (baffles + 1.5));
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      addQuad(m, P(t1, r * 0.87, bx), P(t1, r * 0.66, bx),
                 P(t0, r * 0.66, bx), P(t0, r * 0.87, bx), STRUT);
    }
  }
  /* External hoops. The middle one wears the livery — a single painted band
     round an instrument barrel, which is how real hardware is marked. */
  for (const f of [0.22, 0.58, 0.88]) {
    const hoopMat = (f === 0.58) ? ACCENT : STRUT;
    const hx = x0 + (x1 - x0) * f;
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      addQuad(m, P(t0, r * 1.07, hx - 0.012), P(t1, r * 1.07, hx - 0.012),
                 P(t1, r * 1.07, hx + 0.012), P(t0, r * 1.07, hx + 0.012), hoopMat);
    }
  }
}

/* An OPEN framework: four longerons with diagonal bracing between bays.
 *
 * truss is the family seventeen unclassified stations share, and it was a
 * stack of closed boxes — which is the one thing its own name says it is not.
 * A lattice reads instantly because you can see space THROUGH it, and nothing
 * else in the fleet does. */
function lattice(m, x0, x1, hy, hz, bays, t) {
  const rails = [[hy, hz], [-hy, hz], [-hy, -hz], [hy, -hz]];
  const cx = (x0 + x1) / 2, hx = (x1 - x0) / 2;
  for (const [y, z] of rails) box(m, cx, y, z, hx, t, t, STRUT);
  for (let b = 0; b <= bays; b++) {
    const bx = x0 + (x1 - x0) * (b / bays);
    // ring frame at every station
    for (const [a, c] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
      const A = rails[a], B = rails[c];
      box(m, bx, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2,
          t, Math.abs(A[0] - B[0]) / 2 + t, Math.abs(A[1] - B[1]) / 2 + t, STRUT);
    }
    if (b === bays) continue;
    /* Diagonals, alternating direction bay to bay. All one way reads as a
       pattern; alternating reads as engineering. */
    const nx = x0 + (x1 - x0) * ((b + 1) / bays);
    const dir = b % 2 ? 1 : -1;
    for (const s of [1, -1]) {
      const A = [bx, s * hy, dir * hz], B = [nx, s * hy, -dir * hz];
      const w = t * 0.8;
      addQuad(m, [A[0], A[1] - w, A[2]], [A[0], A[1] + w, A[2]],
                 [B[0], B[1] + w, B[2]], [B[0], B[1] - w, B[2]], STRUT);
      const C = [bx, dir * hy, s * hz], D = [nx, -dir * hy, s * hz];
      addQuad(m, [C[0], C[1], C[2] - w], [C[0], C[1], C[2] + w],
                 [D[0], D[1], D[2] + w], [D[0], D[1], D[2] - w], STRUT);
    }
  }
}

/* An engine bell, pointing -x, that reads as thrust without a plume.
 *
 * The last attempt at exhaust was a blue shape hung off the back and it was
 * rightly hated: a glow floating behind a ship is a smear, because nothing
 * casts it and nothing contains it. The light belongs INSIDE the nozzle. A
 * flared bell whose interior is hot gives you a bright crescent bounded by
 * hard geometry, it stays put when the craft turns, and at chart size it
 * reads as an engine burning rather than as a sticker.
 */
function nozzle(m, cx, cy, cz, r0, r1, len, mat, hot) {
  const HOT = hot ?? ENGINE;
  const seg = 12;
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
    const P = (t, r, x) => [x, cy + Math.cos(t) * r, cz + Math.sin(t) * r];
    // the bell, flaring aft
    /* PANEL, not a polished fitting: a smooth metal cone with nothing
       around it to reflect renders as a black wedge, which is exactly what
       the first bell did. */
    addQuad(m, P(t0, r0, cx), P(t0, r1, cx - len), P(t1, r1, cx - len), P(t1, r0, cx), mat ?? PANEL);
    /* The interior, wound the other way so it faces out of the mouth. This is
       the only surface that emits, and it is recessed inside the flare — so
       the glow is bounded by the bell's own rim on every side. */
    addQuad(m, P(t1, r1 * 0.46, cx - len * 0.45), P(t1, r0 * 0.30, cx + len * 0.10),
               P(t0, r0 * 0.30, cx + len * 0.10), P(t0, r1 * 0.46, cx - len * 0.45), HOT);
    /* A hot LIP band around the mouth. The interior cone alone is invisible
       here: the chart looks down on the plane and a craft's nozzle points
       along its heading, so for most headings you never see into the bell at
       all and the engine reads as dead metal. A glowing rim is visible from
       every side, and it is still bounded geometry rather than a haze. */
    addQuad(m, P(t0, r1, cx - len), P(t0, r1 * 0.985, cx - len * 0.90),
               P(t1, r1 * 0.985, cx - len * 0.90), P(t1, r1, cx - len), HOT);
    // a cooled throat collar, so the bell is attached to something
    addQuad(m, P(t0, r0 * 1.20, cx + len * 0.16), P(t0, r0, cx),
               P(t1, r0, cx), P(t1, r0 * 1.20, cx + len * 0.16), STRUT);
  }
}

/* A BERTH: a docking port you could actually mate to.
 *
 * hab is the gateway node — the docking hub everything passes through — so its berths
 * are not detail on a drum, they are the point of it. Which means each one has
 * to be a hole with hardware round it rather than a stub: a tunnel, a mating
 * collar standing proud, an open bore you can see down, latches round the rim
 * and guidance lights to aim at. Small stubs read as pipes; this reads as
 * somewhere a ship arrives.
 */
function berth(m, C, dir, r, len, rand) {
  const f = vnorm(dir);
  const up = Math.abs(f[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const a = vnorm(vcross(f, up));
  const b = vnorm(vcross(f, a));          // (a, b, f) is right-handed
  const SEG = 12;
  const P = (t, rr, d) => [
    C[0] + f[0]*d + (a[0]*Math.cos(t) + b[0]*Math.sin(t)) * rr,
    C[1] + f[1]*d + (a[1]*Math.cos(t) + b[1]*Math.sin(t)) * rr,
    C[2] + f[2]*d + (a[2]*Math.cos(t) + b[2]*Math.sin(t)) * rr,
  ];
  const R = r * 1.34, bore = r * 0.72, cw = r * 0.34, lip = len + cw;

  for (let i = 0; i < SEG; i++) {
    const t0 = (i / SEG) * Math.PI * 2, t1 = ((i + 1) / SEG) * Math.PI * 2;
    // the tunnel, then the collar standing proud of it
    addQuad(m, P(t0, r, 0), P(t1, r, 0), P(t1, r, len), P(t0, r, len), HULL);
    addQuad(m, P(t0, R, len), P(t1, R, len), P(t1, R, lip), P(t0, R, lip), PANEL);
    // the collar's back face, and its mating face with the bore cut out
    addQuad(m, P(t0, r, len), P(t1, r, len), P(t1, R, len), P(t0, R, len), STRUT);
    addQuad(m, P(t0, R, lip), P(t1, R, lip), P(t1, bore, lip), P(t0, bore, lip), STRUT);
    /* The bore, wound inward so you are looking DOWN it. This is the whole
       difference between a port and a bump — a berth is a hole. */
    addQuad(m, P(t0, bore, 0), P(t0, bore, lip), P(t1, bore, lip), P(t1, bore, 0), PANEL);
    // and it is capped inboard, so the hole has a floor rather than a void
    if (i > 0 && i < SEG - 1) {
      const i0 = m.verts.length;
      m.verts.push(P(0, bore, 0), P(t1, bore, 0), P(t0, bore, 0));
      m.tris.push([i0, i0 + 1, i0 + 2, PANEL]);
    }
  }

  /* Latches round the rim, and guidance lights to aim at. Both are built in a
     radial/tangential frame at each angle, so they sit square on the collar
     however the berth is pointed. (rad x tan = f, which keeps slab's axes
     right-handed.) */
  const at = (t, k) => [a[0]*Math.cos(t)*k + b[0]*Math.sin(t)*k,
                        a[1]*Math.cos(t)*k + b[1]*Math.sin(t)*k,
                        a[2]*Math.cos(t)*k + b[2]*Math.sin(t)*k];
  const tan = (t, k) => [-a[0]*Math.sin(t)*k + b[0]*Math.cos(t)*k,
                         -a[1]*Math.sin(t)*k + b[1]*Math.cos(t)*k,
                         -a[2]*Math.sin(t)*k + b[2]*Math.cos(t)*k];
  const along = (k) => [f[0]*k, f[1]*k, f[2]*k];

  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * Math.PI * 2 + 0.2;
    slab(m, P(t, R * 1.02, len + cw * 0.5),
         at(t, r * 0.10), tan(t, r * 0.17), along(r * 0.13), FITTING);
  }
  for (let i = 0; i < 3; i++) {
    const t = (i / 3) * Math.PI * 2 + 0.9;
    slab(m, P(t, R * 0.88, lip + r * 0.015),
         at(t, r * 0.07), tan(t, r * 0.07), along(r * 0.03), ACCENT);
  }
}

/* An exhaust PLUME, streaming aft from a nozzle mouth.
 *
 * The last attempt at exhaust was a glow hung behind the ship and was rightly
 * hated. The difference here is that this one is ATTACHED and it FADES: it
 * starts exactly at the bell mouth, tapers, and its brightness ramps to
 * nothing along its length — carried per-vertex, in the same slot the plate
 * tone uses, since a plume has no plating to vary. A blob of colour behind a
 * hull reads as a sticker; a cone that is brightest where it leaves the engine
 * and gone a moment later reads as thrust.
 */
function plume(m, cx, cy, cz, r, len, seg) {
  const P = (t, rr, x) => [x, cy + Math.cos(t) * rr, cz + Math.sin(t) * rr];
  const N = 4;
  for (let k = 0; k < N; k++) {
    const f0 = k / N, f1 = (k + 1) / N;
    /* Narrows then widens a little, the way an underexpanded plume does. */
    const w0 = r * (1.0 - 0.55 * f0 + 0.30 * f0 * f0);
    const w1 = r * (1.0 - 0.55 * f1 + 0.30 * f1 * f1);
    for (let i = 0; i < seg; i++) {
      const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
      addQuad(m, P(t0, w0, cx - len * f0), P(t1, w0, cx - len * f0),
                 P(t1, w1, cx - len * f1), P(t0, w1, cx - len * f1), PLUME);
      /* The fade, written where the plate tone would go. Four values per
         quad is enough of a ramp at the size this is ever seen. */
      const a0 = (1 - f0) * (1 - f0), a1 = (1 - f1) * (1 - f1);
      const n = m.tris.length;
      m.tris[n - 2].fade = [a0, a0, a1];
      m.tris[n - 1].fade = [a0, a1, a1];
    }
  }
}

/* A run of windows that is actually ON the hull.
 *
 * The old `windows()` places boxes at coordinates written down when hulls were
 * axis-aligned crates. A spine tapers, bends and rotates, so those boxes now
 * hang in space beside the ship — which is most of why the lights read as
 * stuck-on rather than lit-from-within. This walks the real segments, finds the
 * side facing `dir`, and insets a small emissive panel into it.
 *
 * They are recessed rather than proud: a window is a hole, and a lit box
 * standing off the hull is a lamp bolted to the outside.
 */
function spineWindows(m, rings, dir, rand, o = {}) {
  const d = vnorm(dir);
  const size = o.size ?? 0.055, rows = o.rows ?? 1;
  for (let s = o.from ?? 1; s < Math.min(rings.length - 1, o.to ?? 99); s++) {
    const A = rings[s], B = rings[s + 1];
    let best = -1, bestDot = 0.35;               // no window if nothing faces us
    for (let i = 0; i < SECT; i++) {
      const q0 = A.ring[i], q1 = A.ring[(i + 1) % SECT], q2 = B.ring[(i + 1) % SECT];
      const N = vnorm(vcross([q1[0]-q0[0], q1[1]-q0[1], q1[2]-q0[2]],
                             [q2[0]-q0[0], q2[1]-q0[1], q2[2]-q0[2]]));
      const dot = N[0]*d[0] + N[1]*d[1] + N[2]*d[2];
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
    if (best < 0 || rand() < (o.skip ?? 0.22)) continue;  // never a perfect run
    const q0 = A.ring[best], q1 = A.ring[(best + 1) % SECT];
    const q2 = B.ring[(best + 1) % SECT], q3 = B.ring[best];
    const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
    const U = sub(q1, q0), V = sub(q3, q0);
    const N = vnorm(vcross(U, sub(q2, q0)));
    const f = { O: q0, U, V, W: [q0[0]-q1[0]+q2[0]-q3[0], q0[1]-q1[1]+q2[1]-q3[1],
                                 q0[2]-q1[2]+q2[2]-q3[2]], N };
    /* A raised dark surround with the lit panel sunk inside it. Same reading as
       a recessed port and it keeps every wall facing outward — a real pocket
       inverts its own side quads and goes black under a one-sided renderer. */
    const t = Math.min(Math.hypot(...U), Math.hypot(...V)) * 0.09;
    const n = o.n ?? 2;
    for (let r = 0; r < rows; r++) for (let i = 0; i < n; i++) {
      const y = (i + 0.5) / n, x = rows === 1 ? 0.5 : (r + 0.5) / rows;
      const R0 = { x: x - size, y: y - size * 0.55, w: size * 2, h: size * 1.1 };
      G.pad(m, addQuad, f, R0, 0, t, PANEL, PANEL);
      G.pad(m, addQuad, f, { x: R0.x + size * 0.34, y: R0.y + size * 0.2,
                             w: R0.w - size * 0.68, h: R0.h - size * 0.4 },
            0, t * 0.55, PANEL, WINDOW);
    }
  }
}

/* Detail every face of a box. This is the workhorse: a hull mass goes in, a
   machined component comes out, and because greebleFace works in a face's own
   frame the same call details a bus, a pod or a wing. */
function greebleBox(m, rand, cx, cy, cz, sx, sy, sz, o = {}) {
  box(m, cx, cy, cz, sx, sy, sz, o.mat ?? HULL);
  const faces = [
    { O:[cx-sx,cy-sy,cz+sz], U:[2*sx,0,0], V:[0,2*sy,0], N:[0,0,1]  },
    { O:[cx-sx,cy+sy,cz-sz], U:[2*sx,0,0], V:[0,-2*sy,0],N:[0,0,-1] },
    { O:[cx+sx,cy-sy,cz-sz], U:[0,2*sy,0], V:[0,0,2*sz], N:[1,0,0]  },
    { O:[cx-sx,cy+sy,cz-sz], U:[0,-2*sy,0],V:[0,0,2*sz], N:[-1,0,0] },
    { O:[cx+sx,cy+sy,cz-sz], U:[-2*sx,0,0],V:[0,0,2*sz], N:[0,1,0]  },
    { O:[cx-sx,cy-sy,cz-sz], U:[2*sx,0,0], V:[0,0,2*sz], N:[0,-1,0] },
  ];
  const h = Math.min(sx, sy, sz) * (o.relief ?? 0.55);
  const per = Math.max(12, Math.round((o.budget ?? 150) / 3));   // per face, see greebleSpine
  for (const f of faces) {
    G.greebleFace(m, addQuad, f, rand, {
      panels: o.panels ?? 13, height: h, minSize: o.minSize ?? 0.06,
      depth: o.depth ?? 2, M: MATS, budget: { n: per },
    });
  }
}

/* ── the families ───────────────────────────────────────────────────────── */

/* Each returns a mesh in roughly a ±1 box; bake.js normalises the framing. */
const FAMILIES = {

  /* relay — gateways and edge. Mast, dish, and as little else as possible:
     this one is defined by being spindly. */
  relay(rand) {
    const m = mesh();
    /* A comms platform, not a pedestal. The previous one was a tapering column
       with a plate on top, which is a birdbath — it had a foot, an obvious
       standing-up direction, and a dish you only ever saw edge-on.

       This is built the way real spacecraft are: a dense equipment BUS carrying
       everything, a large dish on a yoke aimed off-axis so you see into its
       face, and solar wings for power. The dish is the hero and takes about a
       third of the silhouette. */
    const bw = 0.26 + rand() * 0.06, bh = 0.20 + rand() * 0.05, bd = 0.22 + rand() * 0.05;
    greebleBox(m, rand, 0, 0, -0.20, bw, bd, bh,
               { panels: 15, relief: 0.22, depth: 2, budget: 200 });

    /* the dish, tilted up and toward the viewer so its face reads */
    const R = 0.52 + rand() * 0.10;
    const tilt = 0.55 + rand() * 0.18;
    const cz = 0.40, cyoff = -0.06;
    const dp = (t, u) => {
      const rr = R * u;
      const x = Math.cos(t) * rr, y0 = Math.sin(t) * rr;
      const z0 = 0.72 * u * u * R;                   // the parabola
      // tilt about x so we look into the dish
      return [x, cyoff + y0 * Math.cos(tilt) - z0 * Math.sin(tilt),
                 cz   + y0 * Math.sin(tilt) + z0 * Math.cos(tilt)];
    };
    const SEGS = 24, RINGS = 6;
    for (let i = 0; i < SEGS; i++) {
      const t0 = (i / SEGS) * Math.PI * 2, t1 = ((i + 1) / SEGS) * Math.PI * 2;
      for (let j = 0; j < RINGS; j++) {
        const u0 = j / RINGS, u1 = (j + 1) / RINGS;
        const mat = j === RINGS - 1 ? PANEL : DISH;
        addQuad(m, dp(t0, u0), dp(t0, u1), dp(t1, u1), dp(t1, u0), mat);
      }
    }
    /* Radial ribs, as GEOMETRY standing off the face. Alternating the material
       instead just painted a dartboard; a rib has to catch its own highlight
       and throw its own shadow, which is also what gives the dish scale. */
    /* A rib is a constant WORLD width, so its half-angle has to grow as 1/r
       toward the hub. Deriving the angle from a fixed constant instead made
       every rib about four thousandths of a unit wide — present in the mesh,
       invisible in every render. A rib you cannot see is not a rib. */
    const RIBS = 12, HALFW = 0.011, RISE = 0.020;
    const off = (p, d) => [p[0], p[1] - Math.sin(tilt) * d, p[2] + Math.cos(tilt) * d];
    for (let i = 0; i < RIBS; i++) {
      const t = (i / RIBS) * Math.PI * 2;
      for (let j = 1; j < RINGS; j++) {
        const u0 = j / RINGS, u1 = (j + 1) / RINGS;
        const w0 = HALFW / (R * u0), w1 = HALFW / (R * u1);
        const c = [dp(t - w0, u0), dp(t + w0, u0), dp(t + w1, u1), dp(t - w1, u1)];
        const [A, B, C, D] = c.map(p => off(p, RISE));
        addQuad(m, A, B, C, D, STRUT);                       // the standing top
        addQuad(m, c[0], A, D, c[3], PANEL);                 // and its two walls,
        addQuad(m, c[1], c[2], C, B, PANEL);                 // which throw the shadow
      }
    }
    // hub where the ribs meet
    box(m, 0, cyoff, cz + 0.02, 0.055, 0.055, 0.030, FITTING);
    // feed horn on a tripod over the dish mouth
    const focus = [0, cyoff - Math.sin(tilt) * R * 0.62, cz + Math.cos(tilt) * R * 0.62];
    box(m, focus[0], focus[1], focus[2], 0.045, 0.045, 0.055, FITTING);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const rim = dp(a, 1.0);
      addQuad(m,
        [focus[0] - 0.006, focus[1], focus[2]], [focus[0] + 0.006, focus[1], focus[2]],
        [rim[0] + 0.006, rim[1], rim[2]], [rim[0] - 0.006, rim[1], rim[2]], PANEL);
    }
    // yoke: two arms from the bus up to the dish back
    for (const sx of [1, -1]) {
      greebleBox(m, rand, sx * (bw * 0.78), cyoff * 0.5, 0.10,
                 0.035, 0.05, 0.26, { panels: 4, relief: 0.5, depth: 1, budget: 20 });
    }

    /* solar wings, low and wide so they read as a horizon under the dish */
    const span = 0.44 + rand() * 0.12, cells = 3 + Math.floor(rand() * 2);
    for (const sx of [1, -1]) {
      // one continuous spar the whole span, so the cells hang off structure
      box(m, sx * (bw + 0.10 + span / 2), 0, -0.20, span / 2 + 0.06, 0.012, 0.014, STRUT);
      for (let i = 0; i < cells; i++) {
        const w = span / cells;
        box(m, sx * (bw + 0.12 + w * (i + 0.5)), 0, -0.20,
            w * 0.44, 0.105, 0.008, PANEL);
      }
    }

    // a whip antenna, off to one side so the thing is never mirror-symmetric
    box(m, bw * 0.5, 0.02, -0.52, 0.012, 0.012, 0.16, STRUT);
    return m;
  },

  /* stack — ops. Modules threaded onto a spine, and the modules are obviously
     separate objects: this family should read as "several things bolted up". */
  stack(rand) {
    const m = mesh();
    /* DISCRETE modules on an exposed backbone.
     *
     * One tapering spine with the flare turned up was supposed to read as
     * "several things joined". It never did: a continuous surface is a single
     * object no matter how its diameter wobbles, and the result was a loaf.
     * Surface detail cannot fix that — greebling a loaf gives a detailed loaf.
     *
     * What actually reads is SEPARATION. Distinct masses, different diameters,
     * with the backbone visible in the gaps between them. The rhythm of
     * module-gap-module is the silhouette, and it survives being 30 pixels
     * wide, which is the size this is usually seen at. */
    const n = 3 + Math.floor(rand() * 2);
    const bone = 0.030 + rand() * 0.008;
    let x = -0.66;
    const ends = [];
    for (let i = 0; i < n; i++) {
      /* Chunky, not long. Modules longer than they are wide stack into one
         continuous thin bar and the separation stops reading. */
      const len = 0.085 + rand() * 0.075;
      const rad = 0.17 + rand() * 0.11;
      /* Alternate the cross-section: a drum next to a boxy bay is two objects,
         two drums in a row is one object with a waist. */
      const flat = i % 2 === 1;
      /* Each module is a short EXTRUSION with its own roll, not an axis-aligned
         box. Boxes gave the separation I wanted and cost the shading: every
         camera-facing panel on an axis-aligned box shares one normal, so the
         whole row flattens into a street map. Rolling an octagon a few degrees
         per module hands every module its own set of angles to the sun, which
         is the same reason the extruder exists at all. */
      const roll = (rand() - 0.5) * 0.9;
      const mr = spine(m, rand, {
        from: [x, 0, 0], dir: [1, (rand() - 0.5) * 0.05, (rand() - 0.5) * 0.05],
        up: [0, -Math.sin(roll), Math.cos(roll)],
        hy: rad, hz: flat ? rad * 0.72 : rad,
        len: len * 0.9, segs: 2, taper: 0.99, bend: 0.05, flare: 0.2,
        chamfer: flat ? 0.72 : 0.42,
      });
      greebleSpine(m, rand, mr, {
        panels: flat ? 12 : 9, relief: 0.14, coverage: 1.0, budget: 300,
      });
      // collars, so a module is joined to the backbone rather than skewered
      /* The collars go back to being structure. Painting the whole ring put a
         bright green band on the end of every module — the colour arrived
         before the shape did, and it read as tape stuck on rather than as
         part of the machine. */
      for (const s of [-1, 1])
        box(m, x + len + s * (len + 0.012), 0, 0, 0.012, rad * 0.46, rad * 0.46, STRUT);
      /* The livery survives as one small indicator per module, recessed on
         the side the chart can see. Little enough to be a detail, consistent
         enough to be a fleet marking. */
      box(m, x + len, -rad * 0.92, rad * 0.30, len * 0.16, 0.010, rad * 0.055, ACCENT);
      ends.push({ x: x + len * 0.9, rad, len });
      x += len * 2 + 0.075 + rand() * 0.05;      // the gap: the whole point
    }
    /* The backbone is a KEEL, slung under the modules — not an axle through
       their middles. Run through the centres it lit up as one bright unbroken
       horizontal bar that cut every module in half and flattened the whole
       row; the eye followed the bar instead of the masses. Underneath, the
       same member does the opposite job: it ties the modules into one vehicle
       and gives the silhouette a bottom edge to sit on. */
    const span = (x - 0.075) - (-0.66);
    const cxs = -0.66 + span / 2, keel = -0.20;
    box(m, cxs, 0, keel, span / 2, bone, bone * 0.8, STRUT);
    box(m, cxs, 0, keel - bone * 2.0, span / 2, bone * 0.55, bone * 0.4, PANEL);
    /* A powerline down the keel: one continuous thin run in the family's
       colour, tying the modules together. This is where the livery belongs on
       a stack — the family is defined by things bolted onto a shared spine,
       so the mark should be the thing that runs the whole length. */
    box(m, cxs, -bone * 0.9, keel - bone * 0.55, span / 2, bone * 0.16, bone * 0.16, ACCENT);
    /* diagonals, so it is a truss and not a pipe */
    const bays = Math.max(6, Math.round(span / 0.07));
    for (let i = 0; i < bays; i++) {
      const bx = -0.66 + (i + 0.5) * (span / bays);
      const lean = (i % 2 ? 1 : -1) * (span / bays) * 0.42;
      addQuad(m, [bx - lean, 0, keel], [bx + lean, 0, keel - bone * 2.0],
                 [bx + lean + 0.006, 0, keel - bone * 2.0], [bx - lean + 0.006, 0, keel], STRUT);
    }
    // droppers tying each module down onto the keel
    for (const e of ends)
      box(m, e.x, 0, (keel + 0) / 2 - 0.02, 0.010, 0.010, Math.abs(keel) * 0.44, STRUT);

    /* One module gets a radiator pair and one gets a dish mast — asymmetry is
       what stops a row of modules reading as a barcode. */
    const hot = ends[1 + Math.floor(rand() * (ends.length - 1))];
    for (const s of [-1, 1])
      box(m, hot.x, s * (hot.rad + 0.10), 0.02, hot.len * 0.85, 0.085, 0.010, PANEL);
    const top = ends[Math.floor(rand() * ends.length)];
    box(m, top.x, 0, top.rad + 0.13, 0.016, 0.016, 0.13, STRUT);
    greebleBox(m, rand, top.x, 0, top.rad + 0.27, 0.05, 0.05, 0.04,
               { panels: 5, relief: 0.5, depth: 1, budget: 40 });

    for (const e of ends) {
      const f = { O: [e.x - e.len, e.rad * 0.80, -e.rad * 0.5], U: [e.len * 2, 0, 0],
                  V: [0, 0, e.rad], N: [0, 1, 0] };
      G.pad(m, addQuad, f, { x: 0.18, y: 0.42, w: 0.2, h: 0.14 }, 0, 0.004, PANEL, WINDOW);
      G.pad(m, addQuad, f, { x: 0.56, y: 0.42, w: 0.2, h: 0.14 }, 0, 0.004, PANEL, WINDOW);
    }
    return m;
  },

  /* sensor — monitoring. Instrument booms reaching a long way out of a small
     body, because what it does is look outward. */
  sensor(rand) {
    const m = mesh();
    /* A telescope, which is what a monitoring station is. The hero is the
       BARREL and its open aperture: a black hole ringed by baffles is the one
       shape in this fleet that cannot be mistaken for anything else, because
       everything else is a solid catching light. The service module behind it
       is deliberately small — the instrument is the spacecraft. */
    const r = 0.19 + rand() * 0.05;
    barrel(m, rand, -0.10, 0.52 + rand() * 0.10, r,
           { baffles: 3 + Math.floor(rand() * 2) });

    // the bus, slung under the barrel where a real one lives
    const rings = spine(m, rand, {
      from: [-0.30, 0, -0.26], hy: r * 0.86, hz: r * 0.62, len: 0.15, segs: 3,
      taper: 0.96, bend: 0.08, flare: 0.2,
    });
    greebleSpine(m, rand, rings, { panels: 8, relief: 0.16, coverage: 0.95, budget: 300 });

    /* Star trackers on short booms — a telescope has to know where it is
       pointing, and they break the barrel's straight line. */
    growth(m, rand, rings[1], [ 0.2, 1, 0.1 ], 3, 0.042);
    growth(m, rand, rings[2], [ 0.1, -1, -0.3], 3, 0.038);

    /* Sunshade PETALS round the mouth, not a slab. A single plate standing off
       the barrel was a black rectangle pasted over the render — it hid the
       aperture it was meant to shade. Thin radial vanes leave the mouth open
       and give the top of the silhouette a crown. */
    const petals = 5 + Math.floor(rand() * 3);
    const top = 0.52 + rand() * 0.10;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2 + rand() * 0.1;
      const c = Math.cos(a), sn = Math.sin(a);
      const A = [c * r * 1.02, sn * r * 1.02, top - 0.02];
      const B = [c * r * 1.42, sn * r * 1.42, top + 0.07];
      const w = 0.012;
      addQuad(m, [A[0] - sn*w, A[1] + c*w, A[2]], [A[0] + sn*w, A[1] - c*w, A[2]],
                 [B[0] + sn*w, B[1] - c*w, B[2]], [B[0] - sn*w, B[1] + c*w, B[2]], PANEL);
    }
    return m;
  },

  /* hab — GATEWAY / DOCKING NODE. A node of berths that everything docks at.
     It began as a habitat and swapped jobs with the ring, which is the more
     obviously inhabited shape. That was the right way round — a drum
     bristling with ports was always describing a place you ARRIVE at. */
  hab(rand) {
    const m = mesh();

    /* THE NODE IS THE HERO, and it is most of the model.
       When the berths were stubs on a big drum, the drum won and the family
       read as a pressurised cylinder with pipes. Now the hub is the largest
       single mass, each port is a real hole with a collar and latches round
       it, and the pressurised core is the thing hanging off the BACK. What a
       station is for should be the first thing you see. */
    const hr = 0.21 + rand() * 0.03;
    greebleBox(m, rand, 0, 0, 0, hr, hr, hr * 0.92,
               { panels: 12, relief: 0.26, depth: 2, budget: 200 });

    /* Four radial berths and one axial. Radial ports are what make the
       silhouette a star rather than a tube, and the axial one is what stops
       the star being flat. */
    const br = hr * 0.50, bl = hr * 0.62;
    for (const [dy, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
      berth(m, [0, dy * hr * 0.96, dz * hr * 0.88], [0, dy, dz], br, bl, rand);
    berth(m, [hr * 0.94, 0, 0], [1, 0, 0], br * 1.15, bl * 0.85, rand);

    /* The pressurised core, slung aft. Short, so it supports the node rather
       than competing with it, and it keeps the windows — this is still where
       whoever works the gateway lives. */
    const rings = spine(m, rand, {
      from: [-hr * 1.05, 0, 0], dir: [-1, 0, 0],
      hy: hr * 0.74, hz: hr * 0.70, len: 0.15, segs: 3,
      taper: 0.97, bend: 0.05, flare: 0.15, chamfer: 0.75,
    });
    greebleSpine(m, rand, rings, { panels: 8, relief: 0.14, coverage: 0.95, budget: 320 });
    spineWindows(m, rings, WATCH, rand, { n: 2, rows: 2, size: 0.05, from: 0 });
    growth(m, rand, rings[1], [0, 0, 1], 3, 0.055);

    /* One band round the core at a bulkhead — a single stripe is how a
       pressurised module actually gets marked, and it survives being small. */
    {
      const rg = rings[Math.min(1, rings.length - 1)];
      for (let i = 0; i < SECT; i++) {
        const a = rg.ring[i], b = rg.ring[(i + 1) % SECT];
        const nx = rg.fwd, w = 0.016;
        addQuad(m,
          [a[0] - nx[0]*w, a[1] - nx[1]*w, a[2] - nx[2]*w],
          [b[0] - nx[0]*w, b[1] - nx[1]*w, b[2] - nx[2]*w],
          [b[0] + nx[0]*w, b[1] + nx[1]*w, b[2] + nx[2]*w],
          [a[0] + nx[0]*w, a[1] + nx[1]*w, a[2] + nx[2]*w], ACCENT);
      }
    }

    /* A cupola facing the viewer — someone watches the approaches. The one
       window in the fleet that is a place rather than a light. */
    const cy = -(hr + 0.055), cz = hr * 0.30;
    box(m, -hr * 0.15, cy, cz, 0.075, 0.045, 0.062, STRUT);
    box(m, -hr * 0.15, cy - 0.030, cz, 0.052, 0.020, 0.042, WINDOW);
    for (const s of [1, -1])
      box(m, -hr * 0.15 + s * 0.068, cy - 0.018, cz, 0.012, 0.028, 0.050, PANEL);
    return m;
  },

  /* wing — apps. Big solar arrays: the family that is mostly not hull. */
  wing(rand) {
    const m = mesh();
    const rings = spine(m, rand, {
      from: [-0.18, 0, 0], hy: 0.15, hz: 0.18, len: 0.13, segs: 3,
      taper: 0.95, bend: 0.10, flare: 0.35,
    });
    growth(m, rand, rings[2], [0.6, 0, 0.8], 3, 0.055);
    /* The arrays are the family, so they have to be the biggest thing in the
       silhouette. Standing in x–z they keep nearly their full height; lying in
       the plane they were edge-on and the family had no identity at all. */
    /* Solar arrays as SLATS on a spar, not slabs. One big plate is a flat dark
       rectangle from every angle — the array has to be a run of narrow cells
       with gaps and a frame, and it has to be canted a few degrees so it
       catches light differently from the hull beside it. */
    /* Two big photovoltaic wings, in their own near-black material and cut
       into real cells. This is the family's hero feature and it has to carry
       the silhouette the way relay's dish does — which means BIG, and which
       means standing out of the plane rather than lying in it. */
    const span = 0.46 + rand() * 0.10, hgt = 0.40 + rand() * 0.10;
    const cells = 5 + Math.floor(rand() * 3);
    for (const s of [1, -1]) {
      box(m, s * 0.26, 0, 0, 0.12, 0.018, 0.018, STRUT);                 // spar
      array(m, rand, {
        n: 2, x: s * (0.40 + span / 2), y: 0, z: -hgt / 2,
        w: span / 2, h: hgt, thick: 0.006, step: 0.075, rise: 0.03,
        mat: SOLAR, cells,
      });
      /* The yoke and the drive that turns the wing to face the sun. A wing
         bolted straight to a hull reads as a fin; a wing on a visible rotary
         joint reads as a mechanism that tracks. */
      box(m, s * 0.36, 0, 0, 0.030, 0.040, 0.040, STRUT);
      box(m, s * 0.40, 0, 0, 0.012, 0.055, 0.055, FITTING);
      for (const dz of [1, -1])
        box(m, s * (0.44 + span * 0.25), 0, dz * hgt * 0.46,
            span * 0.25, 0.010, 0.008, STRUT);   // outrigger booms
    }
    box(m, 0, 0, 0.24, 0.045, 0.045, 0.06, FITTING);
    greebleSpine(m, rand, rings, { panels: 8, relief: 0.16, coverage: 0.95, budget: 320 });
    return m;
  },

  /* radiator — AI. Heat rejection, because compute rejects heat. Stacked fins
     with real gaps, which is what makes it read at a glance. */
  radiator(rand) {
    const m = mesh();
    const rings = spine(m, rand, {
      from: [-0.20, 0, 0], hy: 0.15, hz: 0.17, len: 0.14, segs: 3,
      taper: 0.94, bend: 0.10, flare: 0.35,
    });
    growth(m, rand, rings[0], [-1, 0, 0.1], 3, 0.07);

    /* Radiator FINS, and they have to look like radiator fins: a rank of big
       matte-white plates standing out of the plane, stepped so you see them
       one behind the next. The old ones were wide, thin and lying flat in the
       orbital plane, so the 24° camera squashed them to four horizontal
       scratches and the family had no silhouette whatsoever.
       The structure stays cool white; the TUBES running across each fin glow
       sodium amber, because what makes a radiator read as a radiator is
       seeing the working fluid's path. Dim, and only the tubes — the cool
       frame around them is what makes the glow read as heat rather than as
       paint, and a radiator lit up like a lamp reads as a fire. */
    /* The rise per panel has to be most of a panel HEIGHT, or the rank stacks
       into one solid white wall and you are back to no silhouette — just an
       opaque one instead of an invisible one. What makes a fin read as a fin
       is the gap of black sky between it and the next one. */
    /* A DEPLOYED accordion, not a stack of identical cards.
     *
     * Three same-sized rectangles above and three below, all facing the same
     * way, is a venetian blind: perfectly regular, perfectly flat, and every
     * panel taking identical light so the whole rank renders as one grey
     * rectangle with stripes. Gombrich's boredom end, exactly.
     *
     * So: alternate fins cant in opposite directions, which makes consecutive
     * panels catch the key differently — one bright, one dark — and that
     * alternation is what makes plates read as occupying space. The rank also
     * tapers as it goes out, and the two ranks are different lengths, because
     * a deployable that unfolds to a length is a mechanism and a symmetric
     * pair of stacks is a diagram. */
    const fw = 0.27 + rand() * 0.06;
    const fh = 0.20 + rand() * 0.04;
    const cant = 0.26 + rand() * 0.12;
    const tubes = 3 + Math.floor(rand() * 2);

    /* Finish the body FIRST, then measure it. A fixed stand-off is a guess
       about how tall the greebled hull came out for this particular seed, and
       the guess was wrong often enough that some radiators had a fin driven
       through the machinery. The mesh knows its own height; ask it. */
    greebleBox(m, rand, -0.30, 0, -0.06, 0.075, 0.085, 0.075,
               { panels: 6, relief: 0.3, depth: 1, budget: 60 });
    greebleSpine(m, rand, rings, { panels: 8, relief: 0.17, coverage: 0.95, budget: 320 });
    let zhi = 0, zlo = 0;
    for (const v of m.verts) { if (v[2] > zhi) zhi = v[2]; if (v[2] < zlo) zlo = v[2]; }

    const gap = 0.065;
    // different counts up and down — a mechanism, not a mirror
    const counts = rand() < 0.5 ? [3, 2] : [2, 3];
    [1, -1].forEach((s, si) => {
      const n = counts[si];
      const root = (s > 0 ? zhi : zlo);
      const base = Math.abs(root) + gap;
      // the boom out to the rank, and the rotary joint that deploys it
      slab(m, [0.02, 0, s * (Math.abs(root) + gap * 0.5)],
           [0.020, 0, 0], [0, 0.050, 0], [0, 0, gap * 0.55], STRUT);
      slab(m, [0.02, 0, s * (base + 0.012)],
           [0.062, 0, 0], [0, 0.062, 0], [0, 0, 0.024], FITTING);

      /* PARALLAX. One rank grows as it goes out, the other shrinks — and the
         spacing grows and shrinks with it, because a foreshortened run closes
         up as well as narrowing. Tapering both ranks the same way just read as
         two identical tapered stacks; opposed, the eye takes the growing rank
         as coming toward it and the shrinking one as receding, and the whole
         assembly picks up a depth the fixed axonometric camera cannot give it.
         It is a cheat — there is no perspective in this projection — but it is
         the same cheat a matte painter uses, and it works for the same
         reason. */
      const grow = s > 0 ? 1 : -1;
      const step = 0.14;
      let cz = base + 0.05;
      for (let j = 0; j < n; j++) {
        const k = 1 + grow * j * step;
        const pitch = fh * 1.35 * k;
        fin(m, rand, [0.02, 0, s * (cz + pitch * 0.5)], fw * k, fh * 0.5 * k, 0.005,
            (j % 2 ? 1 : -1) * cant, tubes);
        cz += pitch;
        /* hinge rods where consecutive fins meet — this is what makes it a
           folded thing rather than a row of floating plates */
        if (j < n - 1)
          slab(m, [0.02, 0, s * cz], [fw * k * 1.04, 0, 0],
               [0, 0.010, 0], [0, 0, 0.010], STRUT);
      }
    });
    return m;
  },

  /* ring — rotating habitat wheel. A lit torus turning in the dark. */
  ring(rand) {
    const m = mesh();
    /* SEG is high because the torus is the whole family. At 22 you could count
       the facets, and a countable polygon is the definition of low resolution
       — every other fault on this hull was invisible next to it. The ring is
       one continuous machined band, so it can carry the triangles. */
    const R = 0.66, t = 0.085 + rand() * 0.03, seg = 64;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (a, rr, zz) => [Math.cos(a) * rr, Math.sin(a) * rr, zz];
      /* ONE material the whole way round. Alternating it every third segment
         was meant to read as plating and instead produced a hard repeating
         light-dark border — a checkerboard, which is the most artificial thing
         a surface can do. Variation on this hull comes from the plate tones
         and from the fittings, both of which are irregular. */
      /* The flat faces are split into radial BANDS. As single quads spanning
         the full width they took one plate tone each, which came out as 64
         radial streaks — a starburst, the most obviously synthetic thing on
         the model. Banded, the same tones read as plating. */
      const BANDS = 3;
      for (let b = 0; b < BANDS; b++) {
        const r0 = R - t + (2 * t * b) / BANDS, r1 = R - t + (2 * t * (b + 1)) / BANDS;
        addQuad(m, p(a0, r0, -t), p(a1, r0, -t), p(a1, r1, -t), p(a0, r1, -t), HULL);
        addQuad(m, p(a0, r0,  t), p(a0, r1,  t), p(a1, r1,  t), p(a1, r0,  t), HULL);
      }
      addQuad(m, p(a0, R + t, -t), p(a1, R + t, -t), p(a1, R + t,  t), p(a0, R + t,  t), HULL);
      addQuad(m, p(a0, R - t, -t), p(a0, R - t,  t), p(a1, R - t,  t), p(a1, R - t, -t), PANEL);
    }

    /* Circumferential seams: two shallow bands running the whole way round the
       outer face, and radial ribs at intervals. This is the tier below the
       torus — without it the band is one smooth surface of unknowable size,
       and with it you can read the ring against its own plating. */
    for (const bz of [-t * 0.62, t * 0.62]) {
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
        const rr = R + t + 0.004, hwz = t * 0.055;
        const q = (a, zz) => [Math.cos(a) * rr, Math.sin(a) * rr, zz];
        addQuad(m, q(a0, bz - hwz), q(a1, bz - hwz), q(a1, bz + hwz), q(a0, bz + hwz), STRUT);
      }
    }
    const ribs = 24;
    for (let i = 0; i < ribs; i++) {
      const a = (i / ribs) * Math.PI * 2;
      const c0 = Math.cos(a), s0 = Math.sin(a);
      const rr = R + t + 0.003, hw = 0.010;
      const tx = -s0 * hw, ty = c0 * hw;
      addQuad(m,
        [c0 * rr - tx, s0 * rr - ty, -t * 0.92],
        [c0 * rr + tx, s0 * rr + ty, -t * 0.92],
        [c0 * rr + tx, s0 * rr + ty,  t * 0.92],
        [c0 * rr - tx, s0 * rr - ty,  t * 0.92], STRUT);
    }

    /* Windows the whole way round the OUTSIDE. The ring's shape already says
       what it is, so these are not there to identify it — a ring of lights
       turning against the dark is simply the best-looking thing in the fleet,
       and it is the only family where lights earned their place.
       Their count is independent of SEG now: tying them to the tessellation
       meant smoothing the torus would have quadrupled them. */
    const wins = 26;
    for (let i = 0; i < wins; i++) {
      const am = ((i + 0.5) / wins) * Math.PI * 2;
      const c0 = Math.cos(am), s0 = Math.sin(am);
      for (const dz of [-t * 0.30, t * 0.30]) {
        const w = 0.022;
        const q = [c0 * (R + t + 0.006), s0 * (R + t + 0.006), dz];
        const tx = -s0 * w, ty = c0 * w;
        addQuad(m,
          [q[0] - tx, q[1] - ty, q[2] - w * 0.5],
          [q[0] + tx, q[1] + ty, q[2] - w * 0.5],
          [q[0] + tx, q[1] + ty, q[2] + w * 0.5],
          [q[0] - tx, q[1] - ty, q[2] + w * 0.5], WINDOW);
      }
    }

    /* The hub and spokes, detailed. The ring's shape already says what it is,
       so nothing here may compete with the torus — but a smooth hub and four
       plain bars had no feature smaller than a spoke, which is the same
       low-resolution failure the radiator fins had. Detail that reads as
       structure at a glance and as machinery up close. */
    greebleBox(m, rand, 0, 0, 0, 0.19, 0.19, 0.13,
               { panels: 12, relief: 0.22, depth: 2, budget: 180 });
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const along = dx ? R * 0.42 : 0.024, across = dy ? R * 0.42 : 0.024;
      box(m, dx * R * 0.5, dy * R * 0.5, 0, along, across, 0.022, STRUT);
      // a second, thinner member below each spoke, braced between the two
      box(m, dx * R * 0.5, dy * R * 0.5, -0.040, along * 0.9, across * 0.9, 0.008, PANEL);
      for (let i = 0; i < 5; i++) {
        const f = -0.75 + (1.5 * i) / 4;
        box(m, dx * R * (0.5 + f * 0.42), dy * R * (0.5 + f * 0.42),
            -0.020, 0.010, 0.010, 0.022, STRUT);
      }
    }

    /* Fittings round the outside of the rim, between the window pairs: grapple
       points, antennae, and the odd larger module so the ring is not a
       perfectly repeating extrusion. */
    const fits = 20;
    for (let i = 0; i < fits; i++) {
      if (rand() < 0.45) continue;
      const a = ((i + 0.5) / fits) * Math.PI * 2;
      const c0 = Math.cos(a), s0 = Math.sin(a);
      const big = rand() < 0.22;
      const rr = R + t + (big ? 0.055 : 0.020);
      box(m, c0 * rr, s0 * rr, 0,
          big ? 0.055 : 0.018, big ? 0.055 : 0.018, big ? 0.045 : 0.014,
          big ? PANEL : FITTING);
      if (big)                                   // a mast on the larger ones
        box(m, c0 * (rr + 0.05), s0 * (rr + 0.05), 0, 0.030, 0.030, 0.006, STRUT);
    }
    // docking arms reaching in toward the hub from the rim
    for (const q of [0, 1]) {
      const a = (q * 0.5 + 0.13) * Math.PI * 2;
      const c0 = Math.cos(a), s0 = Math.sin(a);
      box(m, c0 * (R - t - 0.05), s0 * (R - t - 0.05), 0, 0.045, 0.045, 0.030, FITTING);
    }
    return m;
  },

  /* truss — the generic hull, and the one 17 stations currently share. It has
     to stay plain enough to mean "unclassified" while still being a machine. */
  truss(rand) {
    const m = mesh();
    /* Plain enough to mean "unclassified" and still be a machine. Stepped
       masses rather than one box, because a single rectangle reads as 2D no
       matter how it is lit. */
    /* An actual TRUSS, which the family was named for and had never been: an
       open framework with pallets clamped along it. Seventeen stations share
       this hull, so it has to mean "unclassified" — and an open backbone with
       a few modules bolted on is exactly that, a chassis carrying whatever it
       happens to be carrying. It also reads instantly, because you can see
       stars through it and nothing else in the fleet lets you. */
    const len = 0.62 + rand() * 0.14;
    lattice(m, -len, len, 0.115, 0.125, 5 + Math.floor(rand() * 2), 0.016);

    /* Pallets: a few boxes clamped to the frame at irregular stations. The
       irregularity is the point — evenly spaced modules read as a printed
       pattern, and this family should look like it accreted. */
    let px = -len * 0.82;
    const pallets = 2 + Math.floor(rand() * 2);
    for (let i = 0; i < pallets; i++) {
      const pw = 0.10 + rand() * 0.10;
      const up = rand() < 0.5;
      greebleBox(m, rand, px + pw, 0, up ? 0.20 : -0.20, pw, 0.12, 0.085,
                 { panels: 9, relief: 0.35, depth: 2, budget: 120 });
      for (const s of [1, -1])                         // the clamps
        box(m, px + pw + s * pw * 0.7, 0, up ? 0.145 : -0.145, 0.012, 0.10, 0.045, ACCENT);
      px += pw * 2 + 0.10 + rand() * 0.22;
      if (px > len * 0.6) break;
    }
    // a service module amidships, so the frame has a middle
    greebleBox(m, rand, 0, 0, 0, 0.15, 0.135, 0.135,
               { panels: 12, relief: 0.28, depth: 2, budget: 160 });
    // docking fixtures at both ends, which is what a chassis is FOR
    for (const s of [1, -1]) {
      box(m, s * (len + 0.05), 0, 0, 0.05, 0.075, 0.075, FITTING);
      box(m, s * (len + 0.10), 0, 0, 0.012, 0.095, 0.095, ACCENT);
    }
    box(m, -len * 0.3, 0, 0.30, 0.014, 0.014, 0.11, STRUT);
    return m;
  },

  /* ── craft: these MOVE, so they point where they are going ─────────────
     Everything above is a structure and sits still. These three are the only
     hulls baked at multiple headings. */

  /* A blunt working hull: wide aft, narrowing forward, with a lot bolted on. */
  tender(rand) {
    const m = mesh();
    const rings = spine(m, rand, {
      from: [-0.48, 0, 0], hy: 0.20, hz: 0.17, len: 0.17, segs: 6,
      taper: 0.88, bend: 0.14, flare: 0.30,
    });
    growth(m, rand, rings[1], [0, 1, 0.2], 3, 0.07);
    growth(m, rand, rings[2], [0, -1, 0.1], 3, 0.065);
    growth(m, rand, rings[4], [0, 0.3, 1], 2, 0.055);
    // engines aft, which is the one detail that says which way it goes
    for (const s of [1, -1]) {
      /* Twin bells, offset across the plane so the aft end has structure
         rather than one lump on the axis. */
      nozzle(m, -0.50, s * 0.105, -0.01, 0.050, 0.078, 0.11);
      // a short, fat chemical plume — a working tug, not a racer
      plume(m, -0.62, s * 0.105, -0.01, 0.044, 0.12, 10);
      box(m, -0.52, s * 0.13, -0.02, 0.06, 0.05, 0.05, FITTING);
    }
    greebleSpine(m, rand, rings, { panels: 9, relief: 0.16, coverage: 0.95, budget: 480 });
    spineWindows(m, rings, WATCH, rand, { n: 2, size: 0.05, from: 3 });
    return m;
  },

  /* Slender and quick: a long taper with almost nothing on it. */
  courier(rand) {
    const m = mesh();
    const rings = spine(m, rand, {
      from: [-0.58, 0, 0], hy: 0.115, hz: 0.10, len: 0.19, segs: 7,
      taper: 0.90, bend: 0.09, flare: 0.12, chamfer: 0.65,
    });
    growth(m, rand, rings[2], [0, 1, 0.15], 3, 0.042);
    growth(m, rand, rings[2], [0, -1, 0.15], 3, 0.042);
    /* The exhaust IS the courier's hero feature — the family means "moving",
       and a big bell with a hot throat is the only thing in the fleet that
       says which way something is going and that it is under power. */
    /* ION. An electrostatic drive is a cold, efficient, low-thrust thing —
       so the courier gets a blue throat and a long thin plume, against the
       tender's short fat amber one. Two ships, two propulsion technologies,
       readable from the colour of the light alone. */
    nozzle(m, -0.56, 0, 0, 0.062, 0.092, 0.11, undefined, ION);
    plume(m, -0.68, 0, 0, 0.046, 0.26, 12);
    // two verniers flanking it, so the aft end is an engine cluster
    for (const s of [1, -1]) {
      nozzle(m, -0.50, s * 0.090, -0.015, 0.024, 0.036, 0.06, undefined, ION);
      plume(m, -0.57, s * 0.090, -0.015, 0.019, 0.10, 8);
    }
    /* Lower coverage than the working hulls: a courier is fast, and a fast
       thing is smooth where a tender is bristling. */
    greebleSpine(m, rand, rings, { panels: 7, relief: 0.14, coverage: 0.9, budget: 320 });
    spineWindows(m, rings, WATCH, rand, { n: 1, size: 0.06, from: 4, to: 6 });
    return m;
  },

  /* Holed, canted, still in orbit. Decommissioning, drawn: the spine bends
     hard and one growth is missing where the other side has two. */
  derelict(rand) {
    const m = mesh();
    const rings = spine(m, rand, {
      from: [-0.42, 0, 0], hy: 0.16, hz: 0.15, len: 0.16, segs: 6,
      taper: 0.86, bend: 0.42, flare: 0.35,
    });
    growth(m, rand, rings[1], [0, 1, 0.4], 2, 0.06);
    growth(m, rand, rings[3], [0.2, 0.9, -0.4], 3, 0.05);
    greebleSpine(m, rand, rings, { panels: 8, relief: 0.16, coverage: 0.95, budget: 420 });
    /* Almost every port dark. The family means decommissioning, and the way you
       read a dead ship is by the two lights still on in a hull that should be
       full of them — not by the hull being empty. */
    spineWindows(m, rings, WATCH, rand, { n: 1, size: 0.05, from: 1, skip: 0.7 });
    return m;
  },
};

/* Craft point where they are going and therefore need heading frames; a
   structure does not rotate, so it bakes once. */
const CRAFT = new Set(["tender", "courier", "derelict"]);

/* Node for the bake, the browser for the forge. Same geometry either way — the
   forge exists to LOOK at hulls under a real renderer, and it would be useless
   if it were looking at a different mesh than the one that ships. */
/* Named, not `API` — see the note in greeble.js. Both ship as classic scripts
   into one global scope. */
const HULLS_API = { FAMILIES, CRAFT, rng, LIVERY, HULL, PANEL, STRUT, FITTING,
                    WINDOW, DISH, SOLAR, RADPANEL, ENGINE, RADTUBE,
                    ACCENT, ION, PLUME };
if (typeof module !== "undefined" && module.exports) module.exports = HULLS_API;
if (typeof window !== "undefined") window.HULLS = HULLS_API;
