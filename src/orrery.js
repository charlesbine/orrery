(() => {
  "use strict";

  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const TILT = 0.40;              // sin(24°) — viewing angle above the plane
  const TAU  = Math.PI * 2;

  const KIND_ID = { star:0, gas:1, ice:2, rock:3, dark:4, reserved:5, station:6, craft:7 };

  /* ═══════════════════════════════════════════════════════════════════
     SETUP
     ═══════════════════════════════════════════════════════════════════ */

  const stage  = document.getElementById("stage");
  const cBack  = document.getElementById("backdrop");
  const cBody  = document.getElementById("bodies");
  const cOver  = document.getElementById("overlay");
  const bg     = cBack.getContext("2d");
  const ov     = cOver.getContext("2d");
  /* `depth` for the hull pass: a real mesh has to occlude itself, and without a
     depth buffer a station renders inside-out. Nothing else in the chart uses
     it — the body quads sort on the CPU. */
  const gl     = cBody.getContext("webgl", { alpha:true, antialias:true, premultipliedAlpha:false, depth:true });

  let W = 0, H = 0, DPR = 1;

  /* Resolved once. Reading a custom property forces a style recalc, and the
     label pass would otherwise do it ~80× a frame. */
  const css = getComputedStyle(document.documentElement);
  const FONT_MONO = css.getPropertyValue("--mono").trim();
  const FONT_SANS = css.getPropertyValue("--sans").trim();

  /* Live-tunable from the ⌘K panel. `speed` scales simulated time only — it
     never touches the camera, so panning stays 1:1 with the pointer. */
  const CFG = {
    speed: 0.45, paused: false, ghosts: true,
    rate: 1, rateTarget: 1,   // eased 0..1 — space ramps this, it never snaps
    dust: true, orbits: true, trails: true, stars: true, ships: true, drift: true,
  };

  const bodies = FLEET.slice();

  const byId = Object.fromEntries(bodies.map(b => [b.id, b]));

  /* Allocation, not health: an ALLOCATED body maps to real hardware or a real
     service; an unallocated one is a real celestial object whose name is still
     free. Hiding unallocated bodies must not orphan allocated ones, so anything
     with an allocated descendant stays on as a dimmed structural marker even
     when ghosts are off — you cannot draw Charon and omit what it orbits. */
  const isAllocated = b => b.allocated !== false && b.state !== "reserved";
  const structural = new Set();
  for (const b of bodies) {
    if (!isAllocated(b)) continue;
    let p = b.parent;
    while (p && byId[p]) { structural.add(p); p = byId[p].parent; }
  }
  const hiddenGhost = b => !CFG.ghosts && !isAllocated(b) && !structural.has(b.id);
  const dimGhost    = b => !CFG.ghosts && !isAllocated(b) && structural.has(b.id);

  /* Kepler's third law holds *within* a system, not across them: a moon of
     a planet and a moon with the same semi-major axis have wildly
     different periods. One constant per gravitational well, tuned so inner
     bodies visibly travel and outer ones creep. */
  const K_SUN = 0.160, K_MOON = 0.055, K_STATION = 0.006;

  bodies.forEach((b, i) => {
    if (b.phase === undefined) b.phase = (i * 2.399963) % TAU;   // golden-angle spread
    // fleet.js may pin omega directly (the station disc rotates near-rigidly
    // rather than shearing); otherwise derive it from Kepler.
    if (b.omega === undefined) {
      const K = b.station ? K_STATION : b.parent ? K_MOON : K_SUN;
      b.omega = b.a ? K / Math.pow(b.a, 1.5) : 0;
    }
    if (b.seed === undefined) b.seed = (i * 37.31) % 100;
    b.spin  = 0;
    b.pos   = { x:0, y:0 };
    b.scr   = { x:0, y:0, r:0 };
    b._focusAlpha = 1;
    b._i    = i;        // fixed tiebreak for painter's order — see drawBodies
  });
  /* Belt dust: orbital elements are constant, so derive them once. Motes inside
     a resonance gap are dropped rather than nudged — a real belt is carved by
     Kirkwood gaps, and that structure is what stops it reading as static. */
  const DUST = [];
  BELTS.forEach((belt, bi) => {
    for (let i = 0; i < belt.count; i++) {
      const a = belt.from + ((i * 7919) % 1000) / 1000 * (belt.to - belt.from);
      if (belt.gaps.some(([g0, g1]) => a > g0 && a < g1)) continue;
      DUST.push({ a, base: i * 2.399963, w: K_SUN / Math.pow(a, 1.5),
                  tint: belt.tint, size: belt.size, belt: bi });
    }
  });

  /* Dust is drawn in BINS, one per (belt × brightness step).

     The old loop quantised alpha and set fillStyle only when the bucket
     changed, which reads like a batching optimisation and is not one: the
     motes are ordered by orbit, not by brightness, so the bucket flips almost
     every mote. Measured on the real roster it set fillStyle ~999 times a
     frame, each one parsing a freshly built `rgba(...)` string. Binning first
     and drawing each bin in one pass makes that ~24 assignments of strings
     that were built once at startup.

     Coordinates go into flat Float32Arrays sized for the worst case, so the
     hot loop neither allocates nor grows. */
  const DUST_LEVELS = 8;
  const dustBins = [];
  BELTS.forEach((belt, bi) => {
    for (let q = 0; q < DUST_LEVELS; q++) {
      const alpha = 0.12 + (q / (DUST_LEVELS - 1)) * 0.26;
      dustBins[bi * DUST_LEVELS + q] = {
        style: `rgba(${belt.tint},${alpha.toFixed(3)})`,
        size: belt.size, n: 0,
        xy: new Float32Array(belt.count * 2),
      };
    }
  });

  document.getElementById("count").textContent =
    String(bodies.filter(b => b.kind !== "reserved").length) + " lit · " +
    String(bodies.filter(b => b.kind === "reserved").length) + " reserved";

  const META = (typeof FLEET_META !== "undefined" && FLEET_META) ? FLEET_META : {};
  const plateTitleEl = document.getElementById("plateTitle");
  const plateChartEl = document.getElementById("plateChart");
  if (META.title) document.title = META.title;
  else if (META.name) document.title = "Orrery — " + META.name;
  if (plateTitleEl && META.heading) plateTitleEl.textContent = META.heading;
  if (plateChartEl) {
    if (META.chart) plateChartEl.textContent = META.chart;
    else if (META.name) plateChartEl.textContent = META.name + " fleet · orbital plane 24°";
  }

  /* ── camera ─────────────────────────────────────────────────────── */
  const cam = { x:0, y:0, zoom:100, tz:100 };
  let selected = null, hovered = null, drift = 0, zoomAnchor = null;
  let focus = null;        // what the camera is holding onto
  /* Where a HARD-selected body should sit so that it AND its readout are both
     fully in frame. Centring the body is not enough: the readout hangs up and to
     the right in fixed pixels, so at high zoom or near an edge it runs off. */
  const framing = { x: 0, y: 0 };
  let readoutSize = { w: 268, h: 220 };
  let readoutBox = null;   // its screen footprint, so labels keep clear of it
  let fitPending = false;

  const LEADER_RUN = 96;          // 74px out + 22px across, from drawOverlay
  const READOUT_RISE = 51;        // how far above the body the readout starts
  const EDGE = 26;

  function reframe() {
    const b = selected && byId[selected];
    const shipSel = selected && selected.startsWith("ship:");
    if (!b && !shipSel) { framing.x = framing.y = 0; return; }
    const R = b ? Math.max(b.scr.r + 15, 27) : 24;
    const { w: rw, h: rh } = readoutSize;

    // Centre the whole group (body + leader + readout), not the body alone.
    const groupW = R + LEADER_RUN + rw;
    const wantX = W / 2 - (groupW / 2 - R);
    const down = Math.max(R, rh - READOUT_RISE);
    const up = Math.max(READOUT_RISE, R);
    const wantY = H / 2 - (down - up) / 2;

    framing.x = (wantX - W / 2) / cam.zoom;
    framing.y = (wantY - H / 2) / cam.zoom;

    // Zoom to fit — but ONLY on the click, never continuously, or it would
    // fight the wheel now that zooming targets the selection.
    if (fitPending) {
      fitPending = false;
      if (b) {
        // Fit works in BOTH directions. Selecting a station from a relation row
        // used to leave you staring at a body half a pixel across (and culled
        // from drawing entirely) — "focus this object" has to actually go there.
        const availW = W - EDGE * 2 - LEADER_RUN - rw;
        const availH = H - EDGE * 2;
        const bodyR = b.scr.r || 0.5;
        const maxR = Math.max(12, Math.min(availW, availH) * 0.42);
        if (bodyR > maxR) cam.tz = Math.max(22, cam.tz * (maxR / bodyR));
        else if (bodyR < 7) cam.tz = Math.min(MAX_ZOOM, cam.tz * (11 / Math.max(0.2, bodyR)));
      }
    }
  }

  let baseZoom = 100;
  function fit() {
    // Sun out to the heliopause, derived from fleet.js / dev/layout.js.
    const span = (typeof HELIOPAUSE === "number" && HELIOPAUSE > 0) ? HELIOPAUSE : 20.8;
    cam.zoom = cam.tz = baseZoom =
      Math.min(W / (2 * span), H / (2 * span * TILT)) * 0.94;
  }
  const toScreen = (wx, wy) => ({
    x: (wx - cam.x) * cam.zoom + W / 2,
    y: (wy * TILT - cam.y) * cam.zoom + H / 2
  });

  /* toScreen allocates a fresh {x,y} per call, ~5,000 times a frame, which
     looks like an obvious thing to hoist into a scalar out-param. Measured: it
     is not. V8's escape analysis already stack-allocates these — a
     non-allocating rewrite of the dust, swarm and orbit loops moved per-frame
     heap growth by under 1%. Left as the readable version deliberately; if
     this ever does show up in a profile, the reason it did is that something
     made the call site megamorphic, and that is the thing to fix. */

  /* Once you are zoomed in at all, the camera should hold onto something —
     otherwise the body you zoomed toward simply orbits out of frame while you
     watch it. Score = how significant the body is, divided by how far it is from
     where you are looking. Hysteresis (1.35x) stops it flicking between two
     comparable candidates every frame. */
  const LOCK_ZOOM = 210;   // ~2.9x the fit zoom
  /* Deep enough that a station fills a good part of the frame — the jump in
     scale from whole-system to single-structure is most of the point. */
  const MAX_ZOOM = 50000;
  let panQuietUntil = 0;
  function pickFocus() {
    if (selected) return selected;
    if (t < panQuietUntil) return null;      // you just panned; hands off              // an explicit click always wins
    if (cam.zoom < LOCK_ZOOM) return null;      // wide shot: let it drift freely
    // stations count as candidates exactly when they are drawn
    const wantStations = cam.zoom >= baseZoom * 6.8;
    let best = null, bestScore = 0;
    for (const b of bodies) {
      if (b.kind === "reserved") continue;
      if (b.station && !wantStations) continue;
      const { x, y, r } = b.scr;
      if (x < -r || x > W + r || y < -r || y > H + r) continue;
      const d = Math.hypot(x - W / 2, y - H / 2);
      const weight = (b.tier === 0 ? 2.2 : b.tier === 1 ? 1.6 : 1.0) * Math.max(r, 2);
      const score = weight / (1 + d / 260);
      if (score > bestScore) { bestScore = score; best = b.id; }
    }
    // Nothing on screen. With no explicit selection the camera does NOT go
    // looking for something — panning into open space is a thing you are
    // allowed to do, and hauling the view back to the nearest body was the
    // camera overriding a deliberate action.
    if (!best) return null;
    if (focus && focus !== best) {
      const cur = byId[focus];
      if (cur) {
        const d = Math.hypot(cur.scr.x - W / 2, cur.scr.y - H / 2);
        const w = (cur.tier === 0 ? 2.2 : cur.tier === 1 ? 1.6 : 1.0) * Math.max(cur.scr.r, 2);
        if (bestScore < (w / (1 + d / 260)) * 1.35) return focus;
      }
    }
    return best;
  }

  /* A point on a body's own orbit at true anomaly A. The drawn path has to use
     the same conic the body is integrated on, or eccentric bodies visibly ride
     off their own orbit line. */
  /* Shared origin: the old code built a throwaway {x:0,y:0} for every
     heliocentric point, ~3,700 times a frame, and that one does escape. */
  const ORIGIN = { x: 0, y: 0 };

  function orbitPoint(b, A) {
    const e = b.e || 0;
    const r = b.a * (1 - e * e) / (1 + e * Math.cos(A));
    const p = b.parent ? byId[b.parent].pos : ORIGIN;
    return toScreen(p.x + r * Math.cos(A), p.y + r * Math.sin(A));
  }

  /* ═══════════════════════════════════════════════════════════════════
     STARFIELD — real named stars + procedural fill, baked once
     ═══════════════════════════════════════════════════════════════════ */

  const NAMED = [   // [name, x%, y%, magnitude, tint]
    ["Sirius",8,72,-1.46,"#cfe0ff"],   ["Canopus",17,88,-0.74,"#fff4e2"],
    ["Arcturus",78,24,-0.05,"#ffd9b0"],["Vega",63,9,0.03,"#e7efff"],
    ["Capella",30,14,0.08,"#fff2d4"],  ["Rigel",13,58,0.13,"#d6e4ff"],
    ["Procyon",22,64,0.34,"#f4f6ff"],  ["Betelgeuse",19,49,0.50,"#ffcaa4"],
    ["Altair",71,33,0.77,"#f0f4ff"],   ["Aldebaran",26,38,0.85,"#ffcfa8"],
    ["Antares",88,62,1.09,"#ffb894"],  ["Spica",83,45,1.04,"#cddcff"],
    ["Pollux",34,27,1.14,"#ffdcb4"],   ["Deneb",57,17,1.25,"#eef2ff"],
    ["Regulus",41,35,1.40,"#e2ecff"],  ["Castor",37,22,1.58,"#eef4ff"]
  ];

  /* The star layer is its OWN canvas element, not an image blitted into the
     backdrop every frame. Baking it at device resolution and sliding it with a
     CSS transform means the parallax costs nothing per frame: the compositor
     moves an existing GPU texture instead of the CPU resampling a full-screen
     image 60 times a second. The old path baked at CSS resolution and drew
     through the backdrop's DPR transform, so every frame upscaled a 2400×1350
     source over the whole viewport — the single most expensive thing in the
     frame, and it was paid whether anything moved or not. */
  const cStars = document.getElementById("stars");
  const sx = cStars.getContext("2d");
  let starW = 0, starH = 0;
  let starTX = null, starTY = null;   // last applied transform, in CSS px

  function bakeStars() {
    starW = Math.ceil(W * 1.25); starH = Math.ceil(H * 1.25);
    cStars.width = Math.ceil(starW * DPR);
    cStars.height = Math.ceil(starH * DPR);
    cStars.style.width = starW + "px";
    cStars.style.height = starH + "px";
    const x = sx;
    // backing store carries the DPR, so the bake below stays in CSS units
    x.setTransform(DPR, 0, 0, DPR, 0, 0);
    x.clearRect(0, 0, starW, starH);
    starTX = starTY = null;      // force the transform to be re-applied
    const c = { width: starW, height: starH };

    // procedural fill — magnitude-weighted so most stars are faint
    let seed = 20260726;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 2600; i++) {
      const px = rnd() * c.width, py = rnd() * c.height;
      const m = Math.pow(rnd(), 2.6);               // few bright, many faint
      const r = 0.35 + m * 1.25;
      const a = 0.10 + m * 0.72;
      const warm = rnd();
      x.beginPath();
      x.fillStyle = warm > 0.86 ? `rgba(255,214,180,${a})`
                  : warm < 0.13 ? `rgba(200,220,255,${a})`
                                : `rgba(226,236,248,${a})`;
      x.arc(px, py, r, 0, TAU); x.fill();
    }
    // real named stars, with diffraction bloom
    NAMED.forEach(([, nx, ny, mag, tint]) => {
      const px = nx / 100 * c.width, py = ny / 100 * c.height;
      const b = Math.max(0.22, 1 - (mag + 1.5) / 4.2);
      const g = x.createRadialGradient(px, py, 0, px, py, 13 * b + 4);
      g.addColorStop(0, tint);
      g.addColorStop(0.16, `rgba(255,255,255,${0.30 * b})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = g;
      x.beginPath(); x.arc(px, py, 13 * b + 4, 0, TAU); x.fill();
      x.fillStyle = tint;
      x.beginPath(); x.arc(px, py, 0.7 + b * 1.5, 0, TAU); x.fill();
    });
  }

  /* Slide the star layer. Rounded to whole device pixels so the compositor
     gets an integer translation and does a straight copy instead of resampling
     the whole layer every frame. */
  function placeStars() {
    if (!starW) return;
    const q = 1 / DPR;
    let px = -cam.x * cam.zoom * 0.045, py = -cam.y * cam.zoom * 0.045;
    px = Math.round((px % starW) / q) * q - starW * 0.12;
    py = Math.round((py % starH) / q) * q - starH * 0.12;
    if (px === starTX && py === starTY) return;      // no layout write if still
    starTX = px; starTY = py;
    cStars.style.transform = `translate3d(${px}px, ${py}px, 0)`;
  }

  /* ═══════════════════════════════════════════════════════════════════
     WEBGL — lit procedural spheres
     ═══════════════════════════════════════════════════════════════════ */

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      console.error(gl.getShaderInfoLog(s));
    return s;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
  const aQuad = gl.getAttribLocation(prog, "a_quad");
  gl.enableVertexAttribArray(aQuad);
  gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  ["u_center","u_res","u_radius","u_light","u_tint","u_kind","u_spin","u_lit",
     "u_seed","u_sel","u_ghost","u_focusAlpha","u_style","u_atmo","u_detail","u_arch","u_craft","u_angle",
     "u_alb","u_nrm","u_cell","u_hull","u_accent"]
    .forEach(n => U[n] = gl.getUniformLocation(prog, n));

  gl.enable(gl.BLEND);

  /* ═══════════════════════════════════════════════════════════════════
     THE HULL ATLAS

     Stations and craft are sprites baked from real meshes (dev/hulls.js →
     dev/bake.js) rather than the signed distance fields in the shader. The
     SDFs remain the fallback and that is deliberate, not laziness: these are
     two megabytes of PNG arriving some frames after first paint, and a chart
     that shows nothing until its textures land is worse than one that shows a
     simpler glyph and then sharpens. `u_hull` is the switch, per body, per
     frame — so a half-loaded atlas is never a half-drawn fleet.
     ═══════════════════════════════════════════════════════════════════ */

  const atlas = { ready: false, alb: null, nrm: null, cells: null };

  /* A device that cannot hold the sheet gets the glyphs instead. The atlas is
     2816px on its long side and the WebGL floor is 2048 — plenty of older
     mobile GPUs stop there, and binding an oversized texture does not fail
     loudly, it silently samples black. Checking costs one call at startup. */
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const atlasFits = typeof HULL_ATLAS !== "undefined" &&
                    Math.max(HULL_ATLAS.width, HULL_ATLAS.height) <= maxTex;

  if (atlasFits) {
    /* Index the manifest once: family → variant → heading → cell. Craft carry
       24 headings and structures one, so the heading axis is present for both
       and simply has length 1 for a station. */
    const byFam = {};
    for (const c of HULL_ATLAS.cells) {
      ((byFam[c.f] ||= [])[c.v] ||= [])[c.h] = c;
    }
    atlas.cells = byFam;
    atlas.craft = new Set(HULL_ATLAS.craft);

    const tex = (img) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      /* CLAMP and LINEAR, and no mipmaps. Mipmapping an atlas bleeds
         neighbouring cells into each other at distance, which on this sheet
         means one station's hull haloing another's. The chart draws these
         between about 3 and 200 pixels, so the minification is real but a
         little aliasing beats a smear of the wrong ship. */
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return t;
    };

    /* The chart ships from two depths — src/index.html and the bundled
       orrery.html at the repo root — so there is no single correct relative
       path. Try the flat one, then the nested one. */
    const load = (name) => new Promise((res, rej) => {
      let i = 0;
      const paths = [name, "src/" + name];
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => (++i < paths.length) ? (img.src = paths[i]) : rej(name);
      img.src = paths[0];
    });

    Promise.all([load("hulls-albedo.png"), load("hulls-normal.png")])
      .then(([a, n]) => {
        atlas.alb = tex(a);
        atlas.nrm = tex(n);
        atlas.ready = true;
        draw();                       // the fleet just got its hulls
      })
      .catch(() => { /* keep the SDF glyphs; the chart is still a chart */ });
  }

  /* ═══════════════════════════════════════════════════════════════════
     THE HULL PASS — real geometry once a sprite would show its pixels

     Impostors far, mesh near. The atlas is exactly right for a station three
     pixels across and hopeless the moment the chart frames one, because no
     fixed sprite survives being magnified to fill a screen. Past the
     threshold the mesh is drawn instead, from the same code the baker uses —
     so the two agree, and the geometry costs 45 kB of JS rather than
     megabytes of PNG.
     ═══════════════════════════════════════════════════════════════════ */

  const hullProg = (typeof HULLS !== "undefined") ? (() => {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, HULL_VS));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, HULL_FS));
    gl.linkProgram(p);
    return p;
  })() : null;

  const HU = {}, HA = {};
  if (hullProg) {
    ["u_center","u_res","u_scale","u_head","u_light","u_tint","u_lit","u_sel",
     "u_ghost","u_accent"]
      .forEach(n => HU[n] = gl.getUniformLocation(hullProg, n));
    ["a_pos","a_nrm","a_mat","a_tone"].forEach(n => HA[n] = gl.getAttribLocation(hullProg, n));
  }

  /* Below this many device pixels of radius the sprite is indistinguishable
     from the mesh and far cheaper, so it wins. Above it the sprite starts to
     show its own texels. */
  const HULL_MESH_PX = 46;

  const meshCache = new Map();

  /* Build the interleaved buffer for one hull. Flat normals, computed per
     triangle and not shared between them: these are machined surfaces, and
     smoothing the normals across an edge reads as melted rather than milled.
     That means no index buffer — every triangle carries its own vertices,
     which is also what lets each one take its own plate tone. */
  function hullMesh(family, variant) {
    const key = family + "/" + variant;
    let e = meshCache.get(key);
    if (e !== undefined) return e;

    const fn = HULLS.FAMILIES[family];
    if (!fn) { meshCache.set(key, null); return null; }
    const m = fn(HULLS.rng(family.length * 977 + variant * 7919 + 13));

    /* Normalise to the same framing the baker uses, so a hull is the same size
       whichever path draws it. The baker fits the PROJECTED bounds, so this
       has to as well — fitting the world bounds instead would make meshes
       jump a few percent as they cross the threshold. */
    const TILT_ = 0.40, COS_ = Math.sqrt(1 - TILT_ * TILT_);
    let mnX = 1e9, mxX = -1e9, mnY = 1e9, mxY = -1e9;
    for (const p of m.verts) {
      const sx = p[0], sy = p[1] * TILT_ - p[2] * COS_;
      if (sx < mnX) mnX = sx; if (sx > mxX) mxX = sx;
      if (sy < mnY) mnY = sy; if (sy > mxY) mxY = sy;
    }
    const span = Math.max(mxX - mnX, mxY - mnY) * 1.06 || 1;
    const k = 2 / span;
    const cx = (mnX + mxX) / 2, cy = (mnY + mxY) / 2;
    /* Recentre in the PROJECTED frame, which for x is a plain shift and for
       the vertical has to be undone through the same basis. */
    const oz = -cy / COS_;

    /* The baker's plate-tone hash, exactly. Both paths must agree or a hull
       changes its freckles as it crosses the size threshold. */
    const tone = (v) => {
      let h = Math.imul(Math.round(v[0] * 5000) ^ 0x9e37, 0x85eb);
      h = Math.imul(h ^ Math.round(v[1] * 5000), 0xc2b2);
      h = Math.imul(h ^ Math.round(v[2] * 5000), 0x27d4);
      h = (h ^ (h >>> 15)) >>> 0;
      return 0.88 + (h / 4294967296) * 0.24;
    };

    const n = m.tris.length;
    const data = new Float32Array(n * 3 * 8);
    let o = 0;
    for (const tri of m.tris) {
      const [i0, i1, i2, mat] = tri;
      const A = m.verts[i0], B = m.verts[i1], C = m.verts[i2];
      const ux = B[0]-A[0], uy = B[1]-A[1], uz = B[2]-A[2];
      const vx = C[0]-A[0], vy = C[1]-A[1], vz = C[2]-A[2];
      let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      /* A plume writes its length-ramp into the same slot the plate tone
         uses; it has no plating to vary, and this is what lets the exhaust
         dissolve rather than stop. */
      const t = tri.fade ? null : tone(A);
      const V3 = [A, B, C];
      for (let j = 0; j < 3; j++) {
        const P = V3[j];
        data[o++] = (P[0] - cx) * k;
        data[o++] = P[1] * k;
        data[o++] = (P[2] + oz) * k;
        data[o++] = nx; data[o++] = ny; data[o++] = nz;
        data[o++] = mat; data[o++] = tri.fade ? tri.fade[j] : t;
      }
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    e = { buf, count: n * 3 };
    meshCache.set(key, e);
    return e;
  }

  /* Draw one hull as geometry. Returns false if it declined — too small to be
     worth it, no mesh, or the sources are not loaded — and the caller falls
     back to the sprite. */
  function drawHullMesh(b, s, r, lit, head, lx, ly) {
    if (!hullProg || r * DPR < HULL_MESH_PX) return false;
    const h = hullOf(b);
    if (!h) return false;
    const mesh = hullMesh(h.family, h.variant);
    if (!mesh) return false;

    gl.useProgram(hullProg);
    /* Depth is cleared PER HULL. Two stations that overlap on screen must not
       depth-test against each other — they are separate objects at separate
       distances and the chart has already decided their order by drawing them
       in sequence. Within one hull, the buffer is exactly what makes it
       solid. */
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
    const S = 8 * 4;
    gl.enableVertexAttribArray(HA.a_pos);
    gl.vertexAttribPointer(HA.a_pos, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(HA.a_nrm);
    gl.vertexAttribPointer(HA.a_nrm, 3, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(HA.a_mat);
    gl.vertexAttribPointer(HA.a_mat, 1, gl.FLOAT, false, S, 24);
    gl.enableVertexAttribArray(HA.a_tone);
    gl.vertexAttribPointer(HA.a_tone, 1, gl.FLOAT, false, S, 28);

    gl.uniform2f(HU.u_center, s.x * DPR, s.y * DPR);
    gl.uniform2f(HU.u_res, cBody.width, cBody.height);
    gl.uniform1f(HU.u_scale, r * DPR);
    gl.uniform1f(HU.u_head, HULLS.CRAFT.has(h.family) ? head : 0);
    gl.uniform2f(HU.u_light, lx, ly);
    gl.uniform3fv(HU.u_tint, b.tint);
    gl.uniform3fv(HU.u_accent, HULLS.LIVERY[h.family] || [0.8, 0.84, 0.9]);
    gl.uniform1f(HU.u_lit, lit);
    gl.uniform1f(HU.u_sel, (selected === b.id ? 1 : 0) + (hovered === b.id ? 0.4 : 0));
    gl.uniform1f(HU.u_ghost, dimGhost(b) ? 0.45 : 1.0);

    gl.drawArrays(gl.TRIANGLES, 0, mesh.count);

    /* Hand the context back exactly as it was found. The body pass that
       follows shares this canvas and assumes no depth test and its own quad
       bound to attribute 0. */
    gl.disable(gl.DEPTH_TEST);
    gl.disableVertexAttribArray(HA.a_nrm);
    gl.disableVertexAttribArray(HA.a_mat);
    gl.disableVertexAttribArray(HA.a_tone);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(aQuad);
    gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0);
    return true;
  }

  /* Which family and variant a body is. One place, so the sprite path and the
     mesh path can never disagree about which hull a station has. */
  function hullOf(b) {
    if (typeof HULLS === "undefined") return null;
    const family = HULLS.CRAFT.has(b.craft) ? b.craft : b.arch;
    if (!family || !HULLS.FAMILIES[family]) return null;
    const variant = HULLS.CRAFT.has(family) ? 0
      : (Math.abs(b.seed | 0) % (typeof HULL_ATLAS !== "undefined" ? HULL_ATLAS.variants : 4));
    return { family, variant };
  }

  /* Which cell a body draws from. Structures pick a variant off their seed so
     two Ollama stations are siblings rather than the same object twice; craft
     pick the heading frame nearest the way they are actually travelling, which
     is why the sprite must never be rotated in the shader — the lighting is
     baked per frame and would turn with it. */
  function hullCell(b, angle) {
    if (!atlas.ready) return null;
    const hull = hullOf(b);
    if (!hull) return null;
    const byV = atlas.cells[hull.family];
    if (!byV) return null;
    const row = byV[hull.variant] || byV[0];
    if (!row) return null;
    let frame = 0;
    if (atlas.craft.has(hull.family)) {
      const n = HULL_ATLAS.headings;
      frame = ((Math.round((angle / (Math.PI * 2)) * n) % n) + n) % n;
    }
    return row[frame] || row[0] || null;
  }

  /* ═══════════════════════════════════════════════════════════════════
     RESIZE
     ═══════════════════════════════════════════════════════════════════ */

  /* Render scale. Every full-screen cost in the frame — two 2D clears, the sun
     glow, the whole WebGL body pass — scales with the SQUARE of this, so on a
     HiDPI panel DPR 2 is 4× the work of DPR 1 before a single body is drawn.
     That is the difference between a chart that runs and one that does not, so
     it is a dial rather than a constant, and `quality` is what the dial sets.
     Auto steps down (never up) when the frame budget is being missed, because
     a sharp 27fps is worse than a slightly soft 60. */
  const SCALES = [1, 1.25, 1.5, 2];
  let quality = "auto", autoCap = 2;

  function targetDPR() {
    const want = quality === "auto" ? autoCap : Number(quality);
    return Math.max(1, Math.min(devicePixelRatio || 1, want));
  }

  function resize() {
    DPR = targetDPR();
    W = stage.clientWidth; H = stage.clientHeight;
    [cBack, cBody, cOver].forEach(c => {
      c.width = Math.floor(W * DPR); c.height = Math.floor(H * DPR);
      c.style.width = W + "px"; c.style.height = H + "px";
    });
    bg.setTransform(DPR, 0, 0, DPR, 0, 0);
    ov.setTransform(DPR, 0, 0, DPR, 0, 0);
    gl.viewport(0, 0, cBody.width, cBody.height);
    bakeStars();
    if (!started) fit();
  }
  let started = false;

  /* ═══════════════════════════════════════════════════════════════════
     SIMULATION
     ═══════════════════════════════════════════════════════════════════ */

  let t = 0;
  function step(dt) {
    /* Space sets a target and the rate glides to it over ~1s, so the system
       spins down and back up instead of stopping dead on a frame boundary. */
    CFG.rate += (CFG.rateTarget - CFG.rate) * Math.min(1, dt * 3.0);
    if (Math.abs(CFG.rate - CFG.rateTarget) < 0.0025) CFG.rate = CFG.rateTarget;

    if (CFG.rate > 0) {
    const dts = dt * CFG.rate;
    t += dts * CFG.speed;
    for (const b of bodies) {
      b.prevX = b.pos.x; b.prevY = b.pos.y;
      if (b.fixed) { b.pos.x = b.fixed[0]; b.pos.y = b.fixed[1]; continue; }
      if (!b.a) { b.pos.x = 0; b.pos.y = 0; continue; }
      const th = b.phase + t * b.omega;
      const e  = b.e || 0;
      const r  = b.a * (1 - e * e) / (1 + e * Math.cos(th));
      const p  = b.parent ? byId[b.parent].pos : { x:0, y:0 };
      b.pos.x = p.x + r * Math.cos(th);
      b.pos.y = p.y + r * Math.sin(th);
      b.spin += dts * (b.kind === "gas" ? 0.13 : 0.05);
    }
    // r^2 dtheta/dt is constant on a two-body orbit — integrating that directly
    // gives the real crawl-at-aphelion, whip-through-perihelion motion.
    for (const cm of COMETS) {
      if (cm._th === undefined) cm._th = cm.phase;
      const r = cm.a * (1 - cm.e * cm.e) / (1 + cm.e * Math.cos(cm._th));
      const h = K_COMET * Math.sqrt(cm.a * (1 - cm.e * cm.e));
      cm._th = (cm._th + dts * h / (r * r)) % TAU;
    }
    }
    // camera keeps easing while paused, so panning and zooming stay live
    // camera easing toward target zoom + gentle ambient drift

    /* Zooming with a body selected pins THAT BODY, the way the wheel anchor
       pins the cursor. The wheel handler already declines to set an anchor when
       something is selected, but that alone was not enough: the framing target
       is computed from the zoom, so as the scale changed the ideal position
       moved, and the follow below only eases toward it at dt*5. The body slid
       off-centre during the zoom and was hauled back after it — zoom, then pan.
       Holding its screen position across the scale change removes the slide, and
       the ease is left to do what it is for, which is following the body's own
       orbital motion. */
    const held = selected && !dragging && !zoomAnchor ? byId[selected] : null;
    const heldAt = held ? toScreen(held.pos.x, held.pos.y) : null;

    const prevZoom = cam.zoom;
    cam.zoom += (cam.tz - cam.zoom) * Math.min(1, dt * 6);

    if (heldAt && cam.zoom !== prevZoom) {
      cam.x = held.pos.x - (heldAt.x - W / 2) / cam.zoom;
      cam.y = held.pos.y * TILT - (heldAt.y - H / 2) / cam.zoom;
    }

    // hold the point under the cursor fixed while the zoom eases
    if (zoomAnchor) {
      cam.x = zoomAnchor.u - (zoomAnchor.sx - W / 2) / cam.zoom;
      cam.y = zoomAnchor.v - (zoomAnchor.sy - H / 2) / cam.zoom;
      if (Math.abs(cam.tz - cam.zoom) < 0.5) zoomAnchor = null;
    }

    focus = pickFocus();

    if (CFG.drift && !REDUCED && !focus && !dragging && !zoomAnchor) {
      drift += dt * 0.030;
      cam.x += Math.cos(drift) * dt * 0.016;
      cam.y += Math.sin(drift * 0.73) * dt * 0.008;
    }
    if (focus && !zoomAnchor && !dragging) {
      const f = byId[focus];
      if (f) {
        if (focus === selected) {
          /* An explicit click frames deliberately: body + leader + readout. */
          reframe();
          const k = Math.min(1, dt * 5.0);
          cam.x += (f.pos.x - cam.x - framing.x) * k;
          cam.y += (f.pos.y * TILT - cam.y - framing.y) * k;
        } else if (f.prevX !== undefined) {
          /* A soft lock MATCHES THE SUBJECT'S MOTION and does nothing else: it
             applies the body's own displacement to the camera, so the thing you
             zoomed toward cannot drift out of frame while your framing stays
             exactly where you put it.

             It used to ease toward a stored offset, and that offset was clamped
             to a third of a screen for void-recovery — so whenever the auto-lock
             switched to an off-centre body the clamp hauled the camera across.
             That was the camera "capturing" you with nothing selected. Velocity
             matching has no attractor and cannot do it. */
          cam.x += f.pos.x - f.prevX;
          cam.y += (f.pos.y - f.prevY) * TILT;
        }
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     DRAW — backdrop
     ═══════════════════════════════════════════════════════════════════ */

  let drawnBodies = 0, drawnOrbits = 0;
  const order = [];            // persistent painter's-order buffer, see drawBodies

  /* The four alpha tiers the orbit web actually uses. Colour strings are built
     once here instead of per body per frame. */
  const ORBIT_TIERS = [0.055, 0.05, 0.13, 0.085].map(a => ({
    alpha: a,
    style: `rgba(160,190,220,${a})`,
    trailStyle: `rgba(200,224,244,${a * 2.6})`,
    members: [], trailers: [],
  }));
  const ORBIT_BY_ALPHA = Object.fromEntries(ORBIT_TIERS.map(x => [x.alpha, x]));

  function drawBackdrop() {
    bg.clearRect(0, 0, W, H);
    drawnOrbits = 0;

    // the starfield is a composited layer now — it only needs repositioning
    placeStars();

    const sun = toScreen(0, 0);

    // sun glow — the one warm thing in the palette. Baked to an offscreen
    // canvas and blitted: building a full-screen radial gradient and filling it
    // every frame was the single most expensive thing on the backdrop.
    const glow = Math.min(cam.zoom * 3.2, Math.max(W, H) * 1.15);
    bg.drawImage(sunGlow(), sun.x - glow, sun.y - glow, glow * 2, glow * 2);

    // heliopause — the trust boundary
    ellipse(bg, sun, HELIOPAUSE, "rgba(129,140,248,0.16)", [5, 9]);

    // belt dust — orbital elements precomputed once (this was 420 Math.pow
    // calls per frame); alpha quantised so fillStyle changes ~8x, not 420x.
    if (CFG.dust) {
      for (let k = 0; k < dustBins.length; k++) dustBins[k].n = 0;
      for (let i = 0; i < DUST.length; i++) {
        const d = DUST[i];
        const th = d.base + t * d.w;
        const p = toScreen(d.a * Math.cos(th), d.a * Math.sin(th));
        if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
        const lit = 0.30 + 0.55 * Math.max(0, Math.cos(th - Math.PI));
        const q = Math.min(DUST_LEVELS - 1, Math.max(0,
          Math.round(lit * (DUST_LEVELS - 1))));
        const bin = dustBins[d.belt * DUST_LEVELS + q];
        bin.xy[bin.n * 2] = p.x; bin.xy[bin.n * 2 + 1] = p.y; bin.n++;
      }
      for (let k = 0; k < dustBins.length; k++) {
        const bin = dustBins[k];
        if (!bin.n) continue;
        bg.fillStyle = bin.style;                 // ~24 times a frame, not ~999
        // one path per bin, one fill — rect() is path building, fillRect is a
        // draw command, and there were 1,509 of those a frame
        bg.beginPath();
        for (let j = 0; j < bin.n; j++)
          bg.rect(bin.xy[j * 2], bin.xy[j * 2 + 1], bin.size, bin.size);
        bg.fill();
      }
    }

    // Co-orbital swarms — clumps that travel WITH a planet rather than rings
    // around the sun, so they are placed relative to the host's own angle.
    if (CFG.dust) for (const sw of SWARMS) {
      const host = byId[sw.host];
      if (!host || hiddenGhost(host)) continue;
      const hostA = Math.atan2(host.pos.y, host.pos.x);
      const hostR = Math.hypot(host.pos.x, host.pos.y);
      const lead = sw.lead * Math.PI / 180;
      // same binning as the belt dust, and for the same reason
      if (!sw._bins) {
        sw._bins = [];
        for (let q = 0; q < DUST_LEVELS; q++)
          sw._bins[q] = { style: `rgba(${sw.tint},${(0.12 + (q / (DUST_LEVELS - 1)) * 0.24).toFixed(3)})`,
                          n: 0, xy: new Float32Array(sw.count * 2) };
      }
      for (let q = 0; q < DUST_LEVELS; q++) sw._bins[q].n = 0;
      for (let i = 0; i < sw.count; i++) {
        const j1 = ((i * 7919) % 1000) / 1000 - 0.5;
        const j2 = ((i * 6247) % 1000) / 1000 - 0.5;
        const th = hostA + lead + j1 * (sw.spread * Math.PI / 180)
                 + Math.sin(t * 0.05 + i) * 0.012 * sw.drift;
        const rr = hostR * (1 + j2 * 0.085);
        const p = toScreen(rr * Math.cos(th), rr * Math.sin(th));
        if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
        const lit = 0.30 + 0.55 * Math.max(0, Math.cos(th - Math.PI));
        const g = Math.min(DUST_LEVELS - 1, Math.max(0,
          Math.round(lit * (DUST_LEVELS - 1))));
        const bin = sw._bins[g];
        bin.xy[bin.n * 2] = p.x; bin.xy[bin.n * 2 + 1] = p.y; bin.n++;
      }
      for (let q = 0; q < DUST_LEVELS; q++) {
        const bin = sw._bins[q];
        if (!bin.n) continue;
        bg.fillStyle = bin.style;
        bg.beginPath();
        for (let j = 0; j < bin.n; j++)
          bg.rect(bin.xy[j * 2], bin.xy[j * 2 + 1], 1.05, 1.05);
        bg.fill();
      }
    }

    /* Orbits — faint ellipse, brighter in the arc just travelled.

       There are only four alpha tiers in the whole web, so the orbits are
       gathered into four paths and stroked four times rather than stroked once
       per body. Separate subpaths in one path cost nothing (each starts with a
       moveTo); a separate stroke() per body costs a tessellation and a draw
       each, ~140 of them a frame on this roster. */
    if (CFG.orbits) {
      // cleared at the top, not just after use: toggling the layer off
      // mid-frame would otherwise leave stale bodies in a buffer
      for (const tier of ORBIT_TIERS) { tier.members.length = 0; tier.trailers.length = 0; }

      /* Pass 1 decides WHAT is drawn; passes 2 and 3 draw it, one tier at a
         time. The bodies have to be bucketed first — a canvas has exactly one
         current path, so building subpaths for four tiers interleaved and
         stroking at the end silently discards everything before the last
         beginPath() and then strokes the remainder four times over. */
      for (const b of bodies) {
        if (!b.a || b.fixed) continue;
        if (b.station && cam.zoom < baseZoom * 2.7) continue;
        if (hiddenGhost(b)) continue;
        const rp = b.a * cam.zoom;
        if (rp < 8) continue;
        const pc = b.parent ? byId[b.parent].pos : ORIGIN;
        const ps = toScreen(pc.x, pc.y);
        if (!ringOnScreen(ps.x, ps.y, rp, rp * TILT)) continue;
        drawnOrbits++;
        const faint = b.state === "reserved" ? 0.055
                    : b.station ? 0.05
                    : b.tier === 1 ? 0.13 : 0.085;
        const tier = ORBIT_BY_ALPHA[faint];
        tier.members.push(b);
        if (CFG.trails && rp >= 26) tier.trailers.push(b);
      }

      // one path and one stroke per tier for the full ellipses …
      bg.lineWidth = 1;
      for (const tier of ORBIT_TIERS) {
        if (!tier.members.length) continue;
        bg.beginPath();
        for (const b of tier.members) {
          // 96 segments on a 12px orbit is wasted work; scale with screen size
          const segs = Math.max(18, Math.min(96, Math.round(b.a * cam.zoom * 0.5)));
          for (let i = 0; i <= segs; i++) {
            const p = orbitPoint(b, (i / segs) * TAU);
            i ? bg.lineTo(p.x, p.y) : bg.moveTo(p.x, p.y);
          }
        }
        bg.strokeStyle = tier.style; bg.stroke();
      }
      // … and one per tier for the just-travelled arcs
      bg.lineWidth = 1.1;
      for (const tier of ORBIT_TIERS) {
        if (!tier.trailers.length) continue;
        bg.beginPath();
        for (const b of tier.trailers) {
          const th = b.phase + t * b.omega;
          for (let i = 0; i <= 26; i++) {
            const p = orbitPoint(b, th - (i / 26) * 0.85);
            i ? bg.lineTo(p.x, p.y) : bg.moveTo(p.x, p.y);
          }
        }
        bg.strokeStyle = tier.trailStyle; bg.stroke();
        tier.trailers.length = 0;
      }
    }

    drawRings(bg, false);
    drawComets(bg);

    // Permanent corridors — a route flagged `corridor` in fleet.js is drawn as
    // a standing lane, not just when a craft is on it.
    for (const sh of SHIPS) {
      if (!sh.corridor) continue;
      const ch = byId[sh.from], eu = byId[sh.to];
      if (!ch || !eu) continue;
      const a = toScreen(ch.pos.x, ch.pos.y), c = toScreen(eu.pos.x, eu.pos.y);
      const lg = bg.createLinearGradient(a.x, a.y, c.x, c.y);
      lg.addColorStop(0, "rgba(129,140,248,0.03)");
      lg.addColorStop(0.5, "rgba(129,140,248,0.16)");
      lg.addColorStop(1, "rgba(129,140,248,0.05)");
      bg.strokeStyle = lg; bg.lineWidth = 1; bg.setLineDash([2, 7]);
      bg.beginPath(); bg.moveTo(a.x, a.y); bg.lineTo(c.x, c.y); bg.stroke();
      bg.setLineDash([]);
    }
  }

  /* Built ONCE at a fixed small size and scaled up on blit.

     The previous version sized the cached canvas to the glow's on-screen radius,
     which meant zooming in reallocated it — up to 3680x3680, ~54 MB — and
     re-uploaded it as a GPU texture on nearly every wheel tick. That single line
     was the entire "fps drops when I zoom" symptom. A radial gradient has no
     high-frequency detail, so a 512px source upscales to any size for free. */
  const GLOW_TEX = 512;
  let glowTex = null;
  function sunGlow() {
    if (glowTex) return glowTex;
    const c = document.createElement("canvas");
    c.width = c.height = GLOW_TEX;
    const x = c.getContext("2d"), r = GLOW_TEX / 2;
    const g = x.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0,    "rgba(255,217,168,0.30)");
    g.addColorStop(0.14, "rgba(255,190,130,0.13)");
    g.addColorStop(0.42, "rgba(120,140,190,0.05)");
    g.addColorStop(1,    "rgba(0,0,0,0)");
    x.fillStyle = g; x.fillRect(0, 0, GLOW_TEX, GLOW_TEX);
    glowTex = c;
    return c;
  }

  /* Does the ring (not its bounding box) actually cross the viewport?
     Normalised distance is 1 on the ring, so the ring is visible iff the nearest
     point of the screen rect is inside it and the farthest corner is outside.
     Bounding-box tests get this wrong in the common case: when you are zoomed
     right in, an outer orbit's bbox contains the whole screen while the ring
     itself is thousands of pixels away. */
  function ringOnScreen(cx, cy, rx, ry) {
    if (rx < 1 || ry < 1) return false;
    const nx = Math.max(0, Math.min(W, cx)), ny = Math.max(0, Math.min(H, cy));
    const near = Math.hypot((nx - cx) / rx, (ny - cy) / ry);
    let far = 0;
    for (const [px, py] of [[0,0],[W,0],[0,H],[W,H]])
      far = Math.max(far, Math.hypot((px - cx) / rx, (py - cy) / ry));
    return near <= 1.02 && far >= 0.98;
  }

  /* A ring draws in two passes: the far half on the backdrop (behind the body)
     and the near half on the overlay (in front of it). One pass on either layer
     puts the whole ring behind or in front of the planet, which reads as wrong
     instantly. Near half = larger screen y = sin(theta) > 0. */
  function drawRings(ctx, front) {
    for (const rs of RINGS) {
      const host = byId[rs.host];
      if (!host) continue;
      // a ring belongs to its planet: it hides and dims with it
      if (hiddenGhost(host)) continue;
      const ringFade = dimGhost(host) ? 0.45 : (isAllocated(host) ? 1.0 : 0.62);
      const c = toScreen(host.pos.x, host.pos.y);
      const bodyAU = host.rad / 100;
      for (const band of rs.bands) {
        const r0 = bodyAU * band.from * cam.zoom;
        const r1 = bodyAU * band.to * cam.zoom;
        if (r1 < 7) continue;
        if (c.x + r1 < -20 || c.x - r1 > W + 20 ||
            c.y + r1 * TILT < -20 || c.y - r1 * TILT > H + 20) continue;
        const steps = Math.max(2, Math.min(10, Math.round((r1 - r0) / 2.2)));
        ctx.strokeStyle = `rgba(${band.tint},${band.alpha * ringFade})`;
        ctx.lineWidth = 1;
        // A band is concentric arcs in ONE colour, so it is one path and one
        // stroke — not ten. Six bands over two ring systems, twice a frame for
        // the near and far halves, was up to 120 strokes on its own.
        ctx.beginPath();
        for (let i = 0; i < steps; i++) {
          const rr = r0 + (r1 - r0) * (i / Math.max(1, steps - 1));
          ctx.ellipse(c.x, c.y, rr, rr * TILT, 0,
                      front ? 0 : Math.PI, front ? Math.PI : TAU);
        }
        ctx.stroke();
      }
    }
  }

  /* Long-period comets. The tail is anti-sunward and grows as they fall in —
     the one thing about a comet that has to be right. */
  function drawComets(ctx) {
    const sun0 = toScreen(0, 0);
    for (const cm of COMETS) {
      if (cm._th === undefined) cm._th = cm.phase;
      const rAt = th => cm.a * (1 - cm.e * cm.e) / (1 + cm.e * Math.cos(th));

      // Faint path, so it reads as a body on an orbit rather than a stray streak
      ctx.beginPath();
      for (let i = 0; i <= 128; i++) {
        const th = (i / 128) * TAU, r = rAt(th);
        const q = toScreen(r * Math.cos(th), r * Math.sin(th));
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      ctx.strokeStyle = `rgba(${cm.tint},0.10)`;
      ctx.lineWidth = 1; ctx.stroke();
      // a brighter arc just behind the head, exactly as the planets get,
      // so the comet visibly rides a path rather than floating
      ctx.beginPath();
      for (let i = 0; i <= 22; i++) {
        const th = cm._th - (i / 22) * 0.55, rr = rAt(th);
        const q = toScreen(rr * Math.cos(th), rr * Math.sin(th));
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      ctx.strokeStyle = `rgba(${cm.tint},0.26)`;
      ctx.lineWidth = 1.1; ctx.stroke();

      const r = rAt(cm._th);
      const p = toScreen(r * Math.cos(cm._th), r * Math.sin(cm._th));
      const near = Math.max(0, Math.min(1, (cm.a * 1.5 - r) / (cm.a * 1.25)));
      if (near > 0.02 && p.x > -400 && p.x < W + 400 && p.y > -400 && p.y < H + 400) {
        /* A comet has TWO tails and only one of them is radial. The ion tail is
           swept straight anti-sunward by the solar wind; the DUST tail is left
           behind along the orbit and curves. Drawing only the radial one is
           what made them look wrong. */
        const dx = p.x - sun0.x, dy = p.y - sun0.y;
        const L = Math.hypot(dx, dy) || 1;
        const ax = dx / L, ay = dy / L;                       // anti-sunward
        const scale = Math.min(1.8, Math.max(0.35, cam.zoom / baseZoom));

        // direction of travel, from the orbit itself
        const eps = 0.02;
        const rb = rAt(cm._th - eps);
        const pb = toScreen(rb * Math.cos(cm._th - eps), rb * Math.sin(cm._th - eps));
        let vx = p.x - pb.x, vy = p.y - pb.y;
        const vl = Math.hypot(vx, vy) || 1;
        vx /= vl; vy /= vl;

        // dust tail — a curved fan lagging between anti-sunward and anti-velocity
        // cap against the comet's distance from the sun on screen — an
        // absolute pixel length turns into a line across the whole chart
        const maxTail = Math.max(14, L * 0.30);
        const dustLen = Math.min((14 + 70 * near) * scale, maxTail * 0.8);
        for (let k = 0; k < 3; k++) {
          const lag = 0.26 + 0.40 * (k / 2);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          for (let i = 1; i <= 10; i++) {
            const u = i / 10;
            const bend = lag * u;                              // curvature grows down-tail
            const tx = ax * (1 - bend) - vx * bend;
            const ty = ay * (1 - bend) - vy * bend;
            const m = Math.hypot(tx, ty) || 1;
            ctx.lineTo(p.x + tx / m * dustLen * u, p.y + ty / m * dustLen * u);
          }
          ctx.strokeStyle = `rgba(255,232,196,${0.042 * near * (1 - k / 4)})`;
          ctx.lineWidth = 1.1;
          ctx.stroke();
        }

        // ion tail — narrow, straight, anti-sunward, bluer
        const ionLen = Math.min((16 + 110 * near) * scale, maxTail);
        const ex = p.x + ax * ionLen, ey = p.y + ay * ionLen;
        const g = ctx.createLinearGradient(p.x, p.y, ex, ey);
        g.addColorStop(0,    `rgba(${cm.tint},${0.34 * near})`);
        g.addColorStop(0.35, `rgba(${cm.tint},${0.12 * near})`);
        g.addColorStop(1,    `rgba(${cm.tint},0)`);
        ctx.strokeStyle = g;
        ctx.lineWidth = Math.max(1, 2.0 * near);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(ex, ey); ctx.stroke();

        // coma + nucleus
        const cg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 7 * near + 2);
        cg.addColorStop(0, `rgba(${cm.tint},${0.55 * near})`);
        cg.addColorStop(1, `rgba(${cm.tint},0)`);
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.arc(p.x, p.y, 7 * near + 2, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(${cm.tint},${0.65 + 0.35 * near})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.0, 1.6 * near), 0, TAU); ctx.fill();
      }
    }
  }

  function ellipse(ctx, c, au, stroke, dash) {
    ctx.save();
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, au * cam.zoom, au * cam.zoom * TILT, 0, 0, TAU);
    ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }

  /* ═══════════════════════════════════════════════════════════════════
     DRAW — bodies (GL)
     ═══════════════════════════════════════════════════════════════════ */

  const LIT = { ok:1.0, degraded:0.55, down:0.055, fading:0.26, reserved:1.0 };
  const FOCUS_OCCLUDER_ALPHA = 0.30;

  function drawBodies(dt) {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.u_res, cBody.width, cBody.height);

    /* Bind the atlas once for the whole pass rather than per body — the two
       textures never change, only which cell of them a hull reads. */
    if (atlas.ready) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas.alb);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, atlas.nrm);
      gl.uniform1i(U.u_alb, 0);
      gl.uniform1i(U.u_nrm, 1);
    }
    drawnBodies = 0;

    /* Painter's order, far side of the plane first. Sorted IN PLACE in a
       persistent array: bodies move a fraction of a pixel between frames, so
       the array is already almost sorted and an insertion pass is ~O(n) with
       no allocation, where slice()+sort() reallocated 86 slots and re-sorted
       from scratch 60 times a second.

       The `|| _i` tiebreak is not decoration. Stations on one shell share an
       orbital radius exactly and run at e:0, so two of them at phases θ and
       π−θ have IDENTICAL pos.y. Sorting a persistent array means ties keep
       last frame's order rather than being re-derived from a fixed base every
       frame — so equal-depth stations swap which one draws on top, and that
       reads as a flicker. Ordering ties by a fixed index makes the result
       depend only on the current positions, never on the previous frame. */
    if (order.length !== bodies.length) { order.length = 0; order.push(...bodies); }
    for (let i = 1; i < order.length; i++) {
      const v = order[i], vy = v.pos.y, vi = v._i;
      let j = i - 1;
      while (j >= 0 && (order[j].pos.y > vy ||
                       (order[j].pos.y === vy && order[j]._i > vi))) {
        order[j + 1] = order[j]; j--;
      }
      order[j + 1] = v;
    }

    // light direction is toward the sun — one projection per frame, not per body
    const sunS = toScreen(0, 0);
    const selectedBody = selected && byId[selected];
    const selectedS = selectedBody && toScreen(selectedBody.pos.x, selectedBody.pos.y);
    const selectedR = selectedBody
      ? Math.max(selectedBody.kind === "star" ? 3 : selectedBody.station ? 2.5 : 1,
                 selectedBody.rad * (cam.zoom / 100))
      : 0;

    for (const b of order) {
      const s = toScreen(b.pos.x, b.pos.y);
      let r = b.rad * (cam.zoom / 100);
      /* Stations get a floor of their own. They first draw at ~1px radius,
         where the hull's features are a hundredth of a pixel across and which
         sub-shape wins the SDF changes with sub-pixel position — so the glyph
         crawls even with the edge antialiased. Below ~2.5px there is no
         silhouette to read anyway, so hold them there and let zoom grow them. */
      r = Math.max(b.kind === "star" ? 3 : b.station ? 2.5 : 1.0, r);
      b.scr = { x:s.x, y:s.y, r };

      if (s.x < -r * 4 - 60 || s.x > W + r * 4 + 60 ||
          s.y < -r * 4 - 60 || s.y > H + r * 4 + 60) continue;
      if (b.station && cam.zoom < baseZoom * 6.8) continue;
      if (b.kind === "reserved" && cam.zoom < 55) continue;
      if (hiddenGhost(b)) continue;

      /* A selected station can pass behind the world it orbits. At the close
         zoom used for a readout, that world can fill the viewport and erase
         the subject entirely. Fade only a real body that both overlaps the
         selection on screen and sits later in painter's order (therefore in
         front of it). The eased alpha prevents a hard flash at the limb as an
         orbit crosses from the far side to the near side. */
      const drawnAfterSelection = selectedBody &&
        (b.pos.y > selectedBody.pos.y ||
         (b.pos.y === selectedBody.pos.y && b._i > selectedBody._i));
      const occludesSelection = drawnAfterSelection && b !== selectedBody &&
        !b.station && b.kind !== "reserved" &&
        Math.hypot(s.x - selectedS.x, s.y - selectedS.y) < r + Math.max(selectedR, 12);
      const focusTarget = occludesSelection ? FOCUS_OCCLUDER_ALPHA : 1;
      b._focusAlpha += (focusTarget - b._focusAlpha) * Math.min(1, dt * 9);

      // light direction: toward the sun, in screen space
      const dx = sunS.x - s.x, dy = sunS.y - s.y;
      const L = Math.hypot(dx, dy) || 1;

      let lit = LIT[b.state] ?? 1;
      if (b.state === "degraded")
        lit *= 0.72 + 0.28 * Math.sin(t * 5.1 + b.seed);
      if (b.state === "fading")
        lit *= 0.80 + 0.20 * Math.sin(t * 0.9 + b.seed);
      if (dimGhost(b)) lit *= 0.45;
      else if (!isAllocated(b)) lit *= 0.62;   // real, but not yours

      gl.blendFunc(gl.SRC_ALPHA, b.kind === "star" ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform2f(U.u_center, s.x * DPR, s.y * DPR);
      gl.uniform1f(U.u_radius, r * DPR);
      gl.uniform2f(U.u_light, dx / L, dy / L);
      gl.uniform3fv(U.u_tint, b.tint);
      gl.uniform1f(U.u_kind, KIND_ID[b.kind]);
      gl.uniform1f(U.u_spin, b.spin);
      gl.uniform1f(U.u_lit, lit);
      gl.uniform1f(U.u_seed, b.seed);
      gl.uniform1f(U.u_ghost, dimGhost(b) ? 0.45 : 1.0);
      gl.uniform1f(U.u_focusAlpha, b._focusAlpha);
      gl.uniform1f(U.u_style, SURFACE_ID[b.surface] ?? 0);
      gl.uniform1f(U.u_arch, ARCH_ID[b.arch] ?? 0);
      gl.uniform1f(U.u_craft, CRAFT_ID[b.craft] ?? 0);
      // heading from the body's own motion, so a hull faces its direction of travel
      const heading = b.prevX === undefined ? 0
        : Math.atan2((b.pos.y - b.prevY) * TILT, b.pos.x - b.prevX);
      gl.uniform1f(U.u_angle, heading);
      gl.uniform1f(U.u_atmo, b.atmo || 0);

      /* Hand the hull sprite over, if this body has one and the atlas has
         landed. u_hull staying 0 is a complete answer: the shader falls back
         to the SDF glyph for that body alone. */
      const cell = KIND_ID[b.kind] > 5.5 ? hullCell(b, heading) : null;
      if (cell) {
        const cw = HULL_ATLAS.cell / HULL_ATLAS.width;
        const ch = HULL_ATLAS.cell / HULL_ATLAS.height;
        gl.uniform4f(U.u_cell, cell.c * cw, cell.r * ch, cw, ch);
        gl.uniform1f(U.u_hull, 1);
        const hl = hullOf(b);
        gl.uniform3fv(U.u_accent,
          (hl && typeof HULLS !== "undefined" && HULLS.LIVERY[hl.family]) || [0.8, 0.84, 0.9]);
      } else {
        gl.uniform1f(U.u_hull, 0);
      }
      // detail follows SCREEN COVERAGE, not zoom: a 40px body is cheap however
      // far in you are, and only a near-fullscreen one pays for deep octaves
      gl.uniform1f(U.u_detail, Math.min(1, (r * 2) / Math.min(W, H)));
      gl.uniform1f(U.u_sel, (selected === b.id ? 1 : 0) + (hovered === b.id ? 0.4 : 0));
      /* Big enough that the sprite would show its texels? Draw the real
         thing instead. The quad's uniforms are already set and simply go
         unused for this body — cheaper than restructuring the loop, and it
         keeps one place where a body decides what it is. */
      if (cell && drawHullMesh(b, s, r, lit, heading, dx / L, dy / L)) { drawnBodies++; continue; }

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      drawnBodies++;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     DRAW — overlay: ships, labels, leader lines
     ═══════════════════════════════════════════════════════════════════ */

  function drawOverlay() {
    ov.clearRect(0, 0, W, H);

    const shipLabels = [];
    readoutBox = null;
    drawRings(ov, true);        // near half of every ring, over its planet

    /* ── ships: discrete departures on transfer arcs ───────────────── */
    if (CFG.ships) for (const sh of SHIPS) {
      const A = byId[sh.from], B = byId[sh.to];
      if (!A || !B) continue;
      const u = (t % sh.period) / sh.period;
      if (u > 0.72) { sh._scr = null; continue; }   // in dock the rest of the cycle
      const k = u / 0.72;
      const p0 = toScreen(A.pos.x, A.pos.y), p1 = toScreen(B.pos.x, B.pos.y);
      // bowed transfer arc, not a straight line
      const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
      const nx = -(p1.y - p0.y), ny = (p1.x - p0.x);
      const nl = Math.hypot(nx, ny) || 1;
      const bow = Math.hypot(p1.x - p0.x, p1.y - p0.y) * 0.16;
      const cx = mx + nx / nl * bow, cy = my + ny / nl * bow;
      const at = s => ({
        x: (1-s)*(1-s)*p0.x + 2*(1-s)*s*cx + s*s*p1.x,
        y: (1-s)*(1-s)*p0.y + 2*(1-s)*s*cy + s*s*p1.y
      });
      // ion trail
      ov.beginPath();
      for (let i = 0; i <= 22; i++) {
        const s = Math.max(0, k - (i / 22) * 0.26);
        const p = at(s);
        i ? ov.lineTo(p.x, p.y) : ov.moveTo(p.x, p.y);
      }
      const q = at(k);
      const tg = ov.createLinearGradient(q.x, q.y, at(Math.max(0, k - 0.26)).x, at(Math.max(0, k - 0.26)).y);
      tg.addColorStop(0, sh.hue + "cc"); tg.addColorStop(1, sh.hue + "00");
      ov.strokeStyle = tg; ov.lineWidth = 1.2; ov.stroke();
      // craft — remember it so it can be picked and selected
      sh._scr = { x: q.x, y: q.y };
      const selShip = selected === "ship:" + sh.id;
      ov.fillStyle = sh.hue;
      ov.beginPath(); ov.arc(q.x, q.y, selShip ? 3.2 : 1.7, 0, TAU); ov.fill();
      if (selShip) {
        ov.strokeStyle = "rgba(56,189,248,0.75)"; ov.lineWidth = 1;
        ov.beginPath(); ov.arc(q.x, q.y, 11, 0, TAU); ov.stroke();
      }
      if (cam.zoom > 70) {
        ov.font = "500 8.5px " + FONT_MONO;
        const w = ov.measureText(sh.label.toUpperCase()).width;
        shipLabels.push({ x: q.x + 7, y: q.y - 5, w, text: sh.label.toUpperCase(),
                          hue: sh.hue });
      }
    }

    /* ── the selected body's annotation: reticle, leader, and a soft scrim
          under the readout. No card — this is what makes it read as part of
          the chart rather than a web panel dropped on top of it. ────────── */
    const selShipObj = selected && selected.startsWith("ship:")
      ? SHIPS.find(z => "ship:" + z.id === selected) : null;
    const anchor = selShipObj ? (selShipObj._scr && { ...selShipObj._scr, r: 9 })
                 : (byId[selected] && byId[selected].scr);
    if (anchor) {
      const { x, y, r } = anchor;
      const R = Math.max(r + 15, 27);
      /* No mirroring. reframe() always solves for a right-hand readout, so an
         edge-triggered flip made the layout and the camera disagree: the flip
         pushed the readout left, framing pushed the body left to make room on
         the right, and the two chased each other off-screen. That feedback loop
         is the camera drifting away after a focus. One side, always. */
      const flip = false;
      const dir = 1;
      const ang = -0.58;                                  // up and outward
      const ax = x + Math.cos(ang) * R * dir, ay = y + Math.sin(ang) * R;
      const ex = ax + 74 * dir,               ey = ay - 42;
      const tx = ex + 22 * dir;

      // The scrim is a CSS layer on the readout itself, not a canvas fill. It
      // used to be a radial gradient sized to the readout's bounding box — with
      // a long station list that box is ~750px tall, so the fill covered the
      // entire viewport and dimmed the whole map. Anchored to the element, it
      // can only ever cover the text.
      const rd = readout.getBoundingClientRect();
      if (rd.width) {
        readoutSize = { w: rd.width, h: rd.height };
        readoutBox = { x: (flip ? tx - rd.width : tx) - 14, y: ey - 9 - 9,
                       w: rd.width + 28, h: rd.height + 18 };
      }

      ov.strokeStyle = "rgba(56,189,248,0.55)";
      ov.lineWidth = 1;
      // reticle: an open ring with four bracket ticks, not a solid circle
      for (let k = 0; k < 4; k++) {
        const a0 = k * (TAU / 4) + 0.30;
        ov.beginPath(); ov.arc(x, y, R, a0, a0 + 0.62); ov.stroke();
      }
      for (let k = 0; k < 4; k++) {
        const a0 = k * (TAU / 4) + 0.30 + 0.31;
        ov.beginPath();
        ov.moveTo(x + Math.cos(a0) * (R - 4), y + Math.sin(a0) * (R - 4));
        ov.lineTo(x + Math.cos(a0) * (R + 4), y + Math.sin(a0) * (R + 4));
        ov.stroke();
      }
      // leader out to the type
      ov.beginPath();
      ov.moveTo(ax, ay); ov.lineTo(ex, ey); ov.lineTo(tx, ey);
      ov.stroke();

      readout.classList.toggle("flip", flip);
      readout.style.left = (flip ? tx - rd.width : tx) + "px";
      readout.style.top  = (ey - 9) + "px";
    }

    /* ── labels: star-atlas convention, leader line + offset text ──── */
    ov.textBaseline = "middle";
    if ("letterSpacing" in ov) ov.letterSpacing = "1.6px";

    /* Labels are placed in PRIORITY order, then anything that would collide with
       an already-placed label is dropped. Drawing them in array order let a
       station's caption land on top of a planet's, which is the overlap you saw.
       Dropping beats nudging here: a label that has wandered from its body is
       worse than no label, and zooming in reveals them anyway. */
    const placed = readoutBox ? [readoutBox] : [];
    const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x &&
                           a.y < b.y + b.h && a.y + a.h > b.y;

    /* Craft captions sit BETWEEN the tiers: a passing ship must never cost a
       host its name (that is how Europa lost its caption), but it should still
       outrank a minor body. Tier-1 boxes are reserved first, below. */
    const drawShipLabels = () => {
      if ("letterSpacing" in ov) ov.letterSpacing = "0px";
      ov.font = "500 8.5px " + FONT_MONO;
      for (const L of shipLabels) {
        const box = { x: L.x, y: L.y - 8, w: L.w + 4, h: 12 };
        if (placed.some(q => hits(q, box))) continue;
        placed.push(box);
        ov.fillStyle = L.hue + "88";
        ov.fillText(L.text, L.x, L.y);
      }
      if ("letterSpacing" in ov) ov.letterSpacing = "1.6px";
    };

    const cands = bodies.filter(b => {
      const { x, y, r } = b.scr;
      if (x < -80 || x > W + 80 || y < -60 || y > H + 60) return false;
      // the selected body's name lives in its readout — drawing it here too is
      // what produced two captions with two leader lines crossing each other
      if (b.id === selected) return false;
      if (hiddenGhost(b)) return false;
      if (b.id === hovered) return true;
      if (b.tier <= 1) return true;
      if (b.tier === 2) return cam.zoom > baseZoom * 0.85;
      if (b.tier === 3) return cam.zoom > baseZoom * 0.95;
      if (b.tier === 4) return cam.zoom > baseZoom * 13;
      return false;
    }).sort((a, b) =>
      (a.tier - b.tier) || (b.scr.r - a.scr.r) || (a.pos.y - b.pos.y));

    let shipsDrawn = false;
    for (const b of cands) {
      if (!shipsDrawn && b.tier > 1) { drawShipLabels(); shipsDrawn = true; }
      const { x, y, r } = b.scr;
      const sel = b.id === hovered;
      const lead = Math.max(r + 9, 15);
      const lx = x + lead * 0.74, ly = y - lead * 0.74;

      const big = b.tier <= 1;
      ov.font = "500 " + (big ? 10.5 : 9.5) + "px " + FONT_SANS;
      const nameW = ov.measureText(b.name.toUpperCase()).width;
      const withDesig = cam.zoom > 92 || sel;
      ov.font = "400 8px " + FONT_MONO;
      const desigW = withDesig ? ov.measureText(b.desig.toUpperCase()).width : 0;

      const box = { x: lx + 13, y: ly - 9,
                    w: Math.max(nameW, desigW) + 8, h: withDesig ? 24 : 14 };
      if (placed.some(q => hits(q, box))) continue;
      placed.push(box);

      ov.strokeStyle = sel ? "rgba(56,189,248,0.65)" : "rgba(207,227,242,0.20)";
      ov.lineWidth = 1;
      ov.beginPath();
      ov.moveTo(x + (r + 3) * 0.7, y - (r + 3) * 0.7);
      ov.lineTo(lx, ly); ov.lineTo(lx + 11, ly);
      ov.stroke();

      const dim = b.state === "reserved" || b.state === "fading";
      ov.font = "500 " + (big ? 10.5 : 9.5) + "px " + FONT_SANS;
      ov.fillStyle = sel ? "#e8f4ff" : dim ? "rgba(207,227,242,0.42)" : "rgba(207,227,242,0.86)";
      ov.fillText(b.name.toUpperCase(), lx + 15, ly);

      if (withDesig) {
        ov.font = "400 8px " + FONT_MONO;
        ov.fillStyle = sel ? "rgba(56,189,248,0.85)" : "rgba(100,116,139,0.85)";
        ov.fillText(b.desig.toUpperCase(), lx + 15, ly + 11);
      }
    }
    if (!shipsDrawn) drawShipLabels();
    if ("letterSpacing" in ov) ov.letterSpacing = "0px";
  }

  /* ═══════════════════════════════════════════════════════════════════
     LOOP
     ═══════════════════════════════════════════════════════════════════ */

  /* Per-layer timing. Without it "the orrery is slow" is a guess — this says
     which of the three passes is actually eating the frame, and ⌘K reads it
     straight out. Smoothed, because a raw per-frame number is unreadable. */
  const cost = { back: 0, body: 0, over: 0 };
  const blend = (k, v) => { cost[k] += (v - cost[k]) * 0.1; };

  /* Step the render scale down when the frame budget is being missed. Only
     ever downward, only on a sustained miss, and never mid-gesture — resizing
     three canvases while the camera is moving is its own stutter. */
  let autoFrames = 0;
  function autoScale() {
    if (quality !== "auto" || autoCap <= SCALES[0]) return;
    if (dragging || zoomAnchor) { autoFrames = 0; return; }
    if (frames.n < frames.buf.length) return;
    if (++autoFrames < 90) return;
    autoFrames = 0;
    if (frames.stats().ms <= 20) return;            // 50fps or better: leave it
    autoCap = SCALES[Math.max(0, SCALES.indexOf(autoCap) - 1)];
    resize();
  }

  let last = performance.now();
  function frame(now) {
    // Clamped at BOTH ends: an rAF timestamp that goes backwards (headless
    // virtual time, tab restore, clock adjustment) produced a negative dt and
    // ran the whole simulation backwards past zero.
    const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
    last = now;
    step(REDUCED ? dt * 0.12 : dt);
    panStep(dt);
    frames.push(dt);

    const t0 = performance.now();
    drawBackdrop();
    const t1 = performance.now();
    drawBodies(dt);
    const t2 = performance.now();
    drawOverlay();
    const t3 = performance.now();
    blend("back", t1 - t0); blend("body", t2 - t1); blend("over", t3 - t2);

    autoScale();
    updateCmdk(now);
    const mins = Math.floor(t * 4);
    document.getElementById("epoch").textContent =
      "T+" + String(Math.floor(mins / 60)).padStart(2, "0") + ":" +
      String(mins % 60).padStart(2, "0") + (CFG.paused ? "  \u00b7  HOLD" : "");
    // the plate stated a fixed 1s ≈ 4min, which stopped being true the moment
    // the speed dial existed
    document.getElementById("rate").textContent =
      CFG.paused ? "held" : "1s \u2248 " + Math.round(CFG.speed * 240) + "s";
    requestAnimationFrame(frame);
  }

  /* ═══════════════════════════════════════════════════════════════════
     INSTRUMENT PANEL (⌘K / Ctrl-K)
     ═══════════════════════════════════════════════════════════════════ */

  /* Ring buffer of frame durations. Reports the mean and the worst frame in the
     window — a 60fps average hides a 90ms hitch, and the hitch is what you feel. */
  const frames = {
    buf: new Float32Array(140), i: 0, n: 0,
    push(dt) { this.buf[this.i] = dt; this.i = (this.i + 1) % this.buf.length;
               if (this.n < this.buf.length) this.n++; },
    stats() {
      let sum = 0, worst = 0;
      for (let k = 0; k < this.n; k++) { const v = this.buf[k]; sum += v; if (v > worst) worst = v; }
      const mean = sum / Math.max(1, this.n);
      return { fps: 1 / mean, ms: mean * 1000, worstFps: 1 / (worst || 1), worstMs: worst * 1000 };
    },
  };

  const cmdk = document.getElementById("cmdk");
  const fpsGraph = document.getElementById("fpsGraph");
  const fg = fpsGraph.getContext("2d");
  const el = id => document.getElementById(id);
  let cmdkOpen = false;

  function setPaused(v) {
    CFG.paused = v;
    CFG.rateTarget = v ? 0 : 1;
    stage.classList.toggle("paused", v);
  }

  /* The layer toggles used to be a row of buttons. They are commands now — you
     find them the same way you find Europa — so all that is left here is the
     state change itself and the one side effect that is not just a flag. */
  const TOGGLES = [
    ["ghosts", "unallocated"], ["stars", "starfield"], ["dust", "belt"],
    ["orbits", "orbits"], ["trails", "trails"], ["ships", "ships"], ["drift", "drift"],
  ];
  function setToggle(key, v) {
    CFG[key] = v;
    // the starfield is its own layer now, so it hides by hiding the layer
    if (key === "stars") cStars.style.display = v ? "block" : "none";
  }
  setPaused(false);

  /* Render scale, as a dial rather than a guess. Position 0 is "auto" — step
     down on a sustained miss — and 1..4 pin it, so a slow machine can be told
     to stop trying and a fast one can be told to stop being careful. */
  {
    const sc = el("ctlScale"), out = el("outScale");
    const show = () => {
      out.textContent = quality === "auto" ? "auto" : Number(quality).toFixed(2) + "×";
    };
    sc.value = "0";
    show();
    sc.addEventListener("input", () => {
      const i = Number(sc.value);
      quality = i === 0 ? "auto" : SCALES[i - 1];
      if (quality === "auto") autoCap = 2;
      show();
      resize();
    });
  }

  const speed = el("ctlSpeed"), outSpeed = el("outSpeed");
  speed.value = String(CFG.speed);
  const showSpeed = () => { outSpeed.textContent = Number(CFG.speed).toFixed(2) + "\u00d7"; };
  speed.addEventListener("input", () => { CFG.speed = Number(speed.value); showSpeed(); });
  showSpeed();

  /* ═══════════════════════════════════════════════════════════════════
     FIND — bodies, stations, transfers and actions, all in one list

     78 lit bodies, and Europa alone carries 28 stations. Past about thirty
     things you stop scanning a chart and start hunting on it, and the chart
     already knew every name — it just had no way to be asked.
     ═══════════════════════════════════════════════════════════════════ */

  const findInput = el("cmdkInput"), findList = el("cmdkList"), findEmpty = el("cmdkEmpty");

  /* Subsequence fuzzy match. Returns null if the query's characters do not all
     appear in order, otherwise a score and the matched indices so the row can
     show WHERE it hit — a result you cannot see the reason for reads as a bug.

     The scoring is three ideas: a character starting a word is worth much more
     than one mid-word (so "ad" finds "AdGuard", not "shAreD"), a run of
     adjacent characters compounds (so "adgu" beats a scattered a-d-g-u), and
     a match near the front of a short field beats one buried in a long one. */
  const WORD_BREAK = /[\s·—\-_./:()]/;
  const nextBreak = (t, from) => {
    for (let i = from; i < t.length; i++) if (WORD_BREAK.test(t[i])) return i;
    return -1;
  };
  function fuzzy(q, text, tight) {
    const t = text.toLowerCase();
    const hits = [];
    let from = 0, score = 0, run = 0, boundaries = 0;
    for (const ch of q) {
      /* A typed space matches any separator. Half a homelab roster is hyphenated —
         uptime-kuma, paperless-ngx, home-assistant — and nobody types the
         hyphen. Matching the class rather than the character means "uptime
         kuma" finds it, and the hit indices still line up for highlighting. */
      const at = ch === " " ? nextBreak(t, from) : t.indexOf(ch, from);
      if (at < 0) return null;
      run = hits.length && at === hits[hits.length - 1] + 1 ? run + 1 : 0;
      const boundary = at === 0 || WORD_BREAK.test(t[at - 1]);
      if (boundary) boundaries++;
      score += 4 + run * 7 + (boundary ? 11 : 0);
      hits.push(at);
      from = at + 1;
    }

    /* A plain subsequence test is far too generous on long text: the letters of
       "anub" appear in order somewhere inside almost any paragraph, which filled
       the list with transfers that had nothing to do with the query. Two gates.
       The match must be DENSE — spread over a bounded window rather than strung
       across a whole sentence — and past two characters it must start at least
       one word, so it is anchored to something a person would type. */
    const span = hits[hits.length - 1] - hits[0] + 1;
    if (span > (tight ? q.length + 3 : q.length * 4 + 8)) return null;
    if (q.length > 2 && !boundaries) return null;

    score += Math.max(0, 20 - hits[0]);            // early beats buried
    score -= Math.min(18, (t.length - q.length) * 0.3);  // tight beats padded
    score -= Math.min(20, (span - q.length) * 2);  // contiguous beats scattered
    return { score, hits };
  }

  /* Each entry is searched across several fields at different weights. The
     name is what you are most likely to be typing, but "proxmox" or "grafana"
     lives in the designation and "ad-block" only in the role, and all three
     should match cleanly. */
  const FIELD_WEIGHT = { name: 3.0, desig: 1.7, context: 1.1, role: 1.0, text: 0.34 };

  function scoreEntry(q, entry) {
    let best = null;
    for (const field in FIELD_WEIGHT) {
      const text = entry[field];
      if (!text) continue;
      /* Prose is matched as a PHRASE, near-contiguously. Descriptions are long
         and many are boilerplate shared verbatim across a dozen stations, so a
         scattered subsequence hit there returns a page of identical-looking
         rows that all matched on "An off-the-shelf service…". Requiring the
         letters to sit together means "magnetosphere" still finds Ganymede and
         "restic" no longer matches every station on a host. */
      const m = fuzzy(q, text, field === "text");
      if (!m) continue;
      const weighted = m.score * FIELD_WEIGHT[field];
      if (!best || weighted > best.weighted)
        best = { weighted, field, hits: m.hits };
    }
    return best;
  }

  /* Actions are looked up exactly like bodies, so there is one thing to learn.
     Labels are functions because they describe the state they would move you
     to, and that flips as you use them. */
  /* `context` carries BOTH verbs deliberately. An action's name describes the
     state it moves you to, so running it flips the label — and a row that
     renames itself out of your own query vanishes the instant you use it,
     which reads as the menu breaking. Searching a stable keyword string keeps
     it under the cursor where you left it. */
  const ACTIONS = [
    { id: "act:pause", kind: "action", label: "time",
      name: () => (CFG.paused ? "Resume time" : "Hold time"),
      desig: "space", context: "hold resume pause play time",
      run: () => setPaused(!CFG.paused) },
    ...TOGGLES.map(([key, label]) => ({
      id: "act:" + key, kind: "action", label: "layer",
      name: () => (CFG[key] ? "Hide " : "Show ") + label,
      desig: label, context: "show hide " + label + " layer",
      run: () => setToggle(key, !CFG[key]),
    })),
    { id: "act:home", kind: "action", label: "camera",
      name: () => "Fit the whole system",
      desig: "heliopause", context: "fit whole system zoom out home camera",
      run: () => { closePanel(); cam.tz = baseZoom; zoomAnchor = null; } },
    { id: "act:release", kind: "action", label: "camera",
      name: () => "Release the camera",
      desig: "esc", context: "release camera unlock deselect",
      run: closePanel },
  ];

  /* Built once. Names do not change, and rebuilding this per keystroke is the
     easiest way to make a search feel slow on a roster this size. */
  const findIndex = [];
  for (const b of bodies) {
    const parent = b.parent ? byId[b.parent] : null;
    findIndex.push({
      id: b.id, kind: b.station ? "station" : b.kind, state: b.state,
      name: b.name, desig: b.desig || "", role: b.role || "",
      // prose, searchable but heavily outranked — "magnetosphere" finds Ganymede
      text: b.desc || "",
      context: b.station ? "station " + (b.shell || "") + " " + (parent ? parent.name : "")
             : parent ? "moon of " + parent.name
             : b.state === "reserved" ? "reserved name" : (b.kind || ""),
      label: b.station && parent ? "station · " + parent.name
           : parent ? "moon · " + parent.name
           : b.state === "reserved" ? "reserved" : (b.kind || "body"),
    });
  }
  for (const s of SHIPS) {
    const A = byId[s.from], B = byId[s.to];
    findIndex.push({
      id: "ship:" + s.id, kind: "transfer", state: "ok",
      name: s.label, desig: s.cadence || "",
      role: (A ? A.name : "") + " → " + (B ? B.name : ""),
      text: s.desc || "",
      context: "transfer " + (A ? A.name : "") + " " + (B ? B.name : ""),
      label: "transfer",
    });
  }

  /* Pluggable health/status polling. Configured via FLEET_META:
       statusAdapter: "auto" | "gatus" | "generic" | "static" | "none"
       statusUrl:     same-origin endpoint (default "/api/status", null disables)
       statusSelfId:  optional body id marked "ok" whenever the poll succeeds
       statusIntervalMs: polling cadence in ms (default 30000)

     Supports Gatus (/api/v1/endpoints/statuses) and generic JSON payloads
     ({ services: { id: "ok"|"degraded"|"down" } }, { id: "ok" }, or arrays of
     { id|name, host?, state|status|healthy }). A product may name several
     monitors: all passing is lit, a split verdict wavers, and all failing is
     dark. Unreachable status data leaves existing lights untouched rather than
     blacking out the whole chart. */
  const VALID_STATES = new Set(["ok", "degraded", "down", "fading", "reserved"]);
  const normalizeState = v => {
    if (typeof v === "boolean") return v ? "ok" : "down";
    if (v && typeof v === "object") {
      if (v.state !== undefined) return normalizeState(v.state);
      if (v.status !== undefined) return normalizeState(v.status);
      if (v.healthy !== undefined) return normalizeState(v.healthy);
      if (v.ok !== undefined) return normalizeState(v.ok);
      return null;
    }
    const s = String(v || "").trim().toLowerCase();
    if (VALID_STATES.has(s)) return s;
    if (s === "up" || s === "healthy" || s === "pass" || s === "passing" || s === "online") return "ok";
    if (s === "warn" || s === "warning" || s === "partial") return "degraded";
    if (s === "fail" || s === "failing" || s === "error" || s === "offline" || s === "unhealthy") return "down";
    return null;
  };
  const setBodyState = (b, next) => {
    if (!b || !next || b.state === next) return false;
    b.state = next;
    const indexed = findIndex.find(entry => entry.id === b.id);
    if (indexed) indexed.state = next;
    return true;
  };
  const statusKey = (group, name) => group + "\u0000" + name;
  const latestResult = endpoint => {
    if (!endpoint || !Array.isArray(endpoint.results) || !endpoint.results.length) return null;
    return endpoint.results.reduce((latest, result) =>
      !latest || String(result.timestamp || "") > String(latest.timestamp || "") ? result : latest, null);
  };
  const applyGatusStatus = endpoints => {
    const status = new Map(endpoints.map(endpoint =>
      [statusKey(endpoint.group || "", endpoint.name || ""), latestResult(endpoint)]));
    let changed = 0;
    for (const b of bodies) {
      if (!Array.isArray(b.health) || !b.health.length) continue;
      const verdicts = b.health.map(ref => status.get(statusKey(ref[0], ref[1])))
        .filter(Boolean).map(result => result.success === true);
      if (!verdicts.length) continue;
      const next = verdicts.every(Boolean) ? "ok" : verdicts.some(Boolean) ? "degraded" : "down";
      if (setBodyState(b, next)) changed++;
    }
    return changed;
  };
  const applyGenericStatus = payload => {
    const map = new Map();
    const put = (key, val) => {
      const st = normalizeState(val);
      if (key && st) map.set(String(key).toLowerCase(), st);
    };
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (!item || typeof item !== "object") continue;
        const st = normalizeState(item);
        if (!st) continue;
        if (item.id) put(item.id, st);
        if (item.host && (item.product || item.name)) put(`svc-${item.host}-${item.product || item.name}`, st);
        if (item.product) put(item.product, st);
        if (item.name) put(item.name, st);
      }
    } else if (payload && typeof payload === "object") {
      const table = (payload.services && typeof payload.services === "object" && !Array.isArray(payload.services))
        ? payload.services : payload;
      for (const [k, v] of Object.entries(table)) put(k, v);
      if (payload.hosts && typeof payload.hosts === "object") {
        for (const [k, v] of Object.entries(payload.hosts)) put(k, v);
      }
    }
    let changed = 0;
    for (const b of bodies) {
      const next = map.get(b.id.toLowerCase()) || map.get(b.name.toLowerCase());
      if (next && setBodyState(b, next)) changed++;
    }
    return changed;
  };
  const statusAdapter = String(META.statusAdapter || "auto").toLowerCase();
  const statusUrl = (statusAdapter === "none" || statusAdapter === "static")
    ? null
    : (META.statusUrl !== undefined ? META.statusUrl : "/api/status");
  const statusSelfId = META.statusSelfId || null;
  const statusIntervalMs = Math.max(5000, Number(META.statusIntervalMs) || 30000);
  const applyStatus = payload => {
    if (statusAdapter === "gatus") return Array.isArray(payload) ? applyGatusStatus(payload) : 0;
    if (statusAdapter === "generic") return applyGenericStatus(payload);
    if (Array.isArray(payload) && payload.some(x => x && Array.isArray(x.results)))
      return applyGatusStatus(payload);
    return applyGenericStatus(payload);
  };
  const refreshStatus = async () => {
    if (!statusUrl) return;
    try {
      const response = await fetch(statusUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("status API returned " + response.status);
      const payload = await response.json();
      applyStatus(payload);
      if (statusSelfId && byId[statusSelfId]) setBodyState(byId[statusSelfId], "ok");
    } catch (_) {
      // Keep the last known lights. One failed fetch must not masquerade as a
      // fleet-wide outage.
    }
  };
  if (statusUrl) {
    refreshStatus();
    const statusTimer = setInterval(refreshStatus, statusIntervalMs);
    if (statusTimer && statusTimer.unref) statusTimer.unref(); // headless Node smoke test
  }

  let findRows = [], findAt = 0;

  const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  const mark = (text, hits) => {
    if (!hits || !hits.length) return esc(text);
    const set = new Set(hits);
    let out = "";
    for (let i = 0; i < text.length; i++)
      out += set.has(i) ? "<b>" + esc(text[i]) + "</b>" : esc(text[i]);
    return out;
  };

  function runFind(q) {
    const query = q.trim().toLowerCase();
    const actions = ACTIONS.map(a => ({ ...a, name: a.name() }));

    if (!query) {
      /* Empty is not empty: it is the action list. That is what makes the
         commands discoverable at all now that they are not buttons. */
      findRows = actions.map(a => ({ entry: a, hits: null, field: "name" }));
    } else {
      const pool = findIndex.concat(actions);
      findRows = pool
        .map(entry => {
          const m = scoreEntry(query, entry);
          return m && { entry, hits: m.field === "name" ? m.hits : null,
                        field: m.field, score: m.weighted };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 9);
    }
    findAt = 0;
    paintFind();
  }

  function paintFind() {
    findEmpty.hidden = findRows.length > 0;
    findInput.setAttribute("aria-expanded", String(findRows.length > 0));
    findList.innerHTML = findRows.map((row, i) => {
      const e = row.entry;
      const dot = e.kind === "action" ? "action" : (e.state || "ok");
      /* When the hit was in a field the row does not show, say which field it
         was — otherwise the match looks arbitrary. */
      const why = row.field && row.field !== "name" && row.field !== "context"
        ? e[row.field] : "";
      return `<li role="option" aria-selected="${i === findAt}" data-i="${i}">` +
        `<button type="button" tabindex="-1">` +
          `<i class="dot ${esc(dot)}"></i>` +
          `<span class="n">${mark(e.name, row.hits)}` +
            (why ? ` <span class="why">${esc(trim(why, 34))}</span>` : "") +
          `</span>` +
          `<span class="c">${esc(e.label || e.context || "")}</span>` +
        `</button></li>`;
    }).join("");
    const sel = findList.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function chooseFind(i) {
    const row = findRows[i];
    if (!row) return;
    const e = row.entry;
    if (e.kind === "action") {
      e.run();
      // an action leaves the menu open: you often want a second one
      runFind(findInput.value);
    } else {
      toggleCmdk(false);
      select(e.id);
    }
  }

  findInput.addEventListener("input", () => runFind(findInput.value));
  findInput.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!findRows.length) return;
      findAt = (findAt + (e.key === "ArrowDown" ? 1 : -1) + findRows.length) % findRows.length;
      paintFind();
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); chooseFind(findAt); return; }
    if (e.key === "Escape") { e.preventDefault(); toggleCmdk(false); return; }
    /* Everything else is typing, and must not reach the chart — `space` would
       hold time and `u` would flip the ghosts mid-word. Shortcuts carrying a
       modifier are not typing, so those still get through. */
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
  });
  findList.addEventListener("click", e => {
    const li = e.target.closest("li[data-i]");
    if (li) chooseFind(Number(li.dataset.i));
  });
  findList.addEventListener("mousemove", e => {
    const li = e.target.closest("li[data-i]");
    if (li && Number(li.dataset.i) !== findAt) { findAt = Number(li.dataset.i); paintFind(); }
  });

  function toggleCmdk(force) {
    cmdkOpen = force === undefined ? !cmdkOpen : force;
    if (cmdkOpen) {
      cmdk.hidden = false;
      runFind("");
      requestAnimationFrame(() => {
        cmdk.classList.add("open");
        findInput.value = "";
        findInput.focus();
      });
    } else {
      cmdk.classList.remove("open");
      findInput.blur();
      setTimeout(() => { if (!cmdkOpen) cmdk.hidden = true; }, 170);
    }
  }

  let lastPanel = 0;
  function updateCmdk(now) {
    if (!cmdkOpen) return;
    const s = frames.stats();

    // sparkline every frame (cheap); numbers at 5Hz so they stay readable
    const w = fpsGraph.width, h = fpsGraph.height;
    fg.clearRect(0, 0, w, h);
    fg.beginPath();
    for (let k = 0; k < frames.n; k++) {
      const idx = (frames.i + k) % frames.buf.length;
      const f = Math.min(120, 1 / (frames.buf[idx] || 1));
      const x = (k / (frames.buf.length - 1)) * w;
      const y = h - (f / 120) * h;
      k ? fg.lineTo(x, y) : fg.moveTo(x, y);
    }
    fg.strokeStyle = s.fps < 45 ? "rgba(249,115,98,0.85)" : "rgba(56,189,248,0.75)";
    fg.lineWidth = 1; fg.stroke();
    // 60fps reference line
    fg.beginPath();
    fg.moveTo(0, h - (60 / 120) * h); fg.lineTo(w, h - (60 / 120) * h);
    fg.strokeStyle = "rgba(207,227,242,0.14)"; fg.stroke();

    if (now - lastPanel < 200) return;
    lastPanel = now;
    el("fpsNow").textContent = s.fps.toFixed(0);
    el("fpsMs").textContent = s.ms.toFixed(1) + " ms/frame";
    el("fpsLow").textContent = s.worstMs.toFixed(0) + " ms worst";
    el("stBodies").textContent = drawnBodies;
    el("stOrbits").textContent = drawnOrbits;
    el("stZoom").textContent = Math.round(cam.zoom) + "\u00d7";
    // where the frame actually went \u2014 the whole point of measuring per layer
    el("stCost").textContent =
      cost.back.toFixed(1) + " / " + cost.body.toFixed(1) +
      " / " + cost.over.toFixed(1) + " ms";
    el("stScale").textContent =
      DPR.toFixed(2) + "\u00d7" + (quality === "auto" ? " auto" : "");
  }

  /* ═══════════════════════════════════════════════════════════════════
     INTERACTION
     ═══════════════════════════════════════════════════════════════════ */

  let dragging = false, moved = false, px = 0, py = 0;

  stage.addEventListener("pointerdown", e => {
    if (e.target.closest(".readout") || e.target.closest(".cmdk") ||
        e.target.closest(".chrome")) return;
    zoomAnchor = null;                 // stop the wheel anchor overriding the drag
    dragging = true; moved = false; px = e.clientX; py = e.clientY;
    stage.classList.add("dragging"); stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", e => {
    if (dragging) {
      const dx = e.clientX - px, dy = e.clientY - py;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom;
      zoomAnchor = null; panQuietUntil = t + 1.5;
      px = e.clientX; py = e.clientY;
      if (moved) selected = null, closePanel();
    } else {
      hovered = pick(e.clientX, e.clientY);
      stage.style.cursor = hovered ? "pointer" : "grab";
    }
  });
  stage.addEventListener("pointerup", e => {
    dragging = false; stage.classList.remove("dragging");
    if (!moved) {
      const hit = pick(e.clientX, e.clientY);
      hit ? select(hit) : (selected = null, closePanel());
    }
  });
  /* Zoom toward the cursor, not the centre. The world point under the pointer
     is pinned for the whole easing run, not just the instant of the wheel tick. */
  stage.addEventListener("wheel", e => {
    if (e.target.closest(".readout") || e.target.closest(".cmdk")) return;  // let those scroll
    e.preventDefault();
    // With a body explicitly selected, the camera is already centring it, so
    // pinning the point under the cursor would fight that lock and drag the
    // selection off-frame. Zoom toward the selection instead: leave the anchor
    // clear and let the focus-follow hold it centred while the scale changes.
    // An auto-lock does NOT override the cursor — that is how you explore.
    if (!selected) {
      const r = stage.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      zoomAnchor = {
        sx, sy,
        u: (sx - W / 2) / cam.zoom + cam.x,
        v: (sy - H / 2) / cam.zoom + cam.y
      };
    } else {
      zoomAnchor = null;
    }
    const f = Math.exp(-e.deltaY * 0.0014);
    cam.tz = Math.min(MAX_ZOOM, Math.max(22, cam.tz * f));
  }, { passive:false });

  function pick(cx, cy) {
    const r = stage.getBoundingClientRect();
    const x = cx - r.left, y = cy - r.top;
    let best = null, bd = 1e9;
    for (const sh of SHIPS) {                        // craft sit on top
      if (!sh._scr) continue;
      const d = Math.hypot(sh._scr.x - x, sh._scr.y - y);
      if (d < 13 && d < bd) { bd = d; best = "ship:" + sh.id; }
    }
    if (best) return best;
    for (const b of bodies) {
      if (b.station && cam.zoom < baseZoom * 6.8) continue;
      if (b.kind === "reserved" && cam.zoom < 55) continue;
      if (hiddenGhost(b)) continue;
      const d = Math.hypot(b.scr.x - x, b.scr.y - y);
      if (d < Math.max(b.scr.r + 9, 13) && d < bd) { bd = d; best = b.id; }
    }
    return best;
  }

  const readout = document.getElementById("readout");

  const esc = v => String(v).replace(/[&<>"]/g, c =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

  const specList = rows => `<dl class="spec">` +
    rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") + `</dl>`;

  /* A clickable row. Selecting from here re-centres the camera on the target,
     so the readout doubles as the map's navigation. */
  const relRow = (id, name, note, state) =>
    `<li><button type="button" data-goto="${esc(id)}">` +
      `<i class="dot ${esc(state || "ok")}"></i>` +
      `<span class="n">${esc(name)}</span>` +
      `<span class="d">${esc(note || "")}</span>` +
    `</button></li>`;

  function select(id) {
    selected = id;
    const ship = id.startsWith("ship:") ? SHIPS.find(z => "ship:" + z.id === id) : null;
    let colA = "", colB = "", relCount = 0;

    if (ship) {
      const A = byId[ship.from], B = byId[ship.to];
      colA =
        `<div class="eyebrow">scheduled transfer</div>` +
        `<h2>${esc(ship.label)}</h2>` +
        `<div class="role">${esc(A.name)} &rarr; ${esc(B.name)} &middot; ${esc(ship.cadence || "")}</div>` +
        `<div class="rule-t"></div>` +
        `<p class="desc">${esc(ship.desc || "")}</p>` +
        (ship.spec ? specList(ship.spec) : "");
      colB =
        `<div class="eyebrow">endpoints</div><ul class="rel">` +
          relRow(A.id, A.name, A.desig, A.state) +
          relRow(B.id, B.name, B.desig, B.state) +
        `</ul>`;
      relCount = 2;
    } else {
      const b = byId[id];
      if (!b) return;
      const kids = bodies.filter(x => x.parent === b.id);
      const moons = kids.filter(x => !x.station);
      const stations = kids.filter(x => x.station);
      const parent = b.parent ? byId[b.parent] : null;

      const context = b.state === "reserved" ? "reserved name"
        : b.station ? "station &middot; " + esc(parent ? parent.name : "")
        : parent ? "moon of " + esc(parent.name)
        : b.kind === "star" ? "beyond the heliopause" : "body";

      const stateLabel = Object.assign(Object.create(null), {
        ok: "lit · healthy",
        degraded: "wavering · degraded",
        down: "dark · down",
        fading: "fading · decommissioning",
        reserved: "unlit · name held",
      });

      colA =
        `<div class="eyebrow">${context}</div>` +
        `<h2>${esc(b.name)}</h2>` +
        `<div class="desig">${esc(b.desig)}</div>` +
        `<div class="role">${esc(b.role)}</div>` +
        `<div class="rule-t"></div>` +
        `<p class="desc">${esc(b.desc)}</p>` +
        (b.pending ? `<div class="note"><b>Pending rename.</b> ${esc(b.pending)}</div>` : "") +
        (b.spec ? specList(b.spec) : "") +
        `<div class="rule-t"></div><dl class="spec">` +
          `<dt>state</dt><dd>${esc(stateLabel[b.state] || b.state)}</dd>` +
          (b.a ? `<dt>orbit</dt><dd>${b.a.toFixed(3)} AU${parent ? " &middot; from " + esc(parent.name) : ""}</dd>` : "") +
        `</dl>`;

      const groups = [];
      if (parent)
        groups.push(`<div class="relgroup"><div class="eyebrow">orbits</div><ul class="rel">` +
          relRow(parent.id, parent.name, parent.desig, parent.state) + `</ul></div>`);
      if (moons.length)
        groups.push(`<div class="relgroup"><div class="eyebrow">bodies in orbit</div><ul class="rel">` +
          moons.map(m => relRow(m.id, m.name, m.desig, m.state)).join("") + `</ul></div>`);
      if (stations.length) {
        const shells = [...new Set(stations.map(x => x.shell))];
        for (const sh of shells) {
          const inShell = stations.filter(x => x.shell === sh);
          groups.push(`<div class="relgroup">` +
            `<div class="eyebrow">${esc(sh || "stations")} &middot; ${inShell.length}</div><ul class="rel">` +
            inShell.map(x => relRow(x.id, x.name,
              x.state === "ok" ? "" : x.state, x.state)).join("") +
            `</ul></div>`);
        }
      }
      relCount = (parent ? 1 : 0) + moons.length + stations.length;
      if (groups.length) colB = `<div class="relgroups">` + groups.join("") + `</div>`;
    }

    /* Europa alone carries 28 stations across 7 shells. Stacked in one narrow
       column that readout is taller than the viewport, so past a threshold it
       goes two-up: identity on the left, everything in orbit on the right, with
       the shell groups themselves flowing into sub-columns. */
    const wide = relCount > 8;
    readout.className = "readout" + (wide ? " wide" : "");
    readout.innerHTML =
      `<div class="col-a">${colA}</div>` +
      (colB ? `<div class="col-b">${colB}</div>` : "") +
      `<button class="dismiss" type="button" id="dismiss">esc &middot; release</button>`;
    readout.scrollTop = 0;
    readout.hidden = false;
    fitPending = true;
    if (location.hash.replace(/^#/, "") !== encodeURIComponent(id))
      history.replaceState(null, "", "#" + encodeURIComponent(id));
    requestAnimationFrame(() => readout.classList.add("open"));
    const d = document.getElementById("dismiss");
    if (d) d.addEventListener("click", closePanel);
    readout.querySelectorAll("[data-goto]").forEach(btn =>
      btn.addEventListener("click", () => select(btn.getAttribute("data-goto"))));
  }

  function closePanel() {
    readout.classList.remove("open");
    selected = null;
    if (location.hash) history.replaceState(null, "", location.pathname);
    setTimeout(() => { if (!selected) readout.hidden = true; }, 240);
  }

  /* Arrow keys and WASD pan. Held keys accumulate per frame rather than
     firing on key-repeat, so motion is smooth and speed is independent of the
     OS repeat rate. Panning releases any lock — you are driving now. */
  const held = {};
  const PAN_KEYS = {
    ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1],
    a:[-1,0], d:[1,0], w:[0,-1], s:[0,1],
  };
  addEventListener("keyup", e => { delete held[e.key]; });
  addEventListener("blur", () => { for (const k in held) delete held[k]; });

  function panStep(dt) {
    let dx = 0, dy = 0;
    for (const k in held) {
      const v = PAN_KEYS[k];
      if (v) { dx += v[0]; dy += v[1]; }
    }
    if (!dx && !dy) return;
    zoomAnchor = null;
    const m = Math.hypot(dx, dy) || 1;
    const speed = 620 * dt / cam.zoom;      // constant screen-space pace at any zoom
    cam.x += (dx / m) * speed;
    cam.y += (dy / m) * speed;
    if (selected) closePanel();
    focus = null;
    panQuietUntil = t + 1.5;
  }

  addEventListener("keydown", e => {
    if (PAN_KEYS[e.key] && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.target.closest && e.target.closest("input, button, select, textarea")) return;
      e.preventDefault();
      held[e.key] = true;
      return;
    }
    /* ⌘K and ⌘F are the same menu. Find is what it is mostly for, and ⌘F is
       the reflex for finding a thing on a page, so it is worth taking over the
       browser's own — this chart is a canvas and the native find has nothing to
       look at. ⌘F always lands you in the field ready to type. */
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && (key === "k" || key === "f")) {
      e.preventDefault();
      if (cmdkOpen && key === "f") { findInput.select(); findInput.focus(); }
      else toggleCmdk(key === "f" ? true : undefined);
      return;
    }
    if ((e.key === "u" || e.key === "U") && !e.metaKey && !e.ctrlKey) {
      if (e.target.closest && e.target.closest("input, button, select, textarea")) return;
      setToggle("ghosts", !CFG.ghosts);
      return;
    }
    if (e.key === " " || e.code === "Space") {
      if (e.target.closest && e.target.closest("input, button, select, textarea")) return;
      e.preventDefault(); setPaused(!CFG.paused); return;
    }
    if (e.key === "Escape") { cmdkOpen ? toggleCmdk(false) : closePanel(); }
  });

  /* ═══════════════════════════════════════════════════════════════════
     GO
     ═══════════════════════════════════════════════════════════════════ */

  /* Deep links: #jupiter, #svc-europa-traefik, #ship:backup-sync. Makes any body in
     the fleet a shareable URL, and means the chart can be opened already framed
     on the thing you wanted to show someone. */
  function applyHash() {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!id) return;
    if (byId[id] || (id.startsWith("ship:") && SHIPS.some(z => "ship:" + z.id === id)))
      select(id);
  }
  addEventListener("hashchange", applyHash);

  addEventListener("resize", resize);
  resize(); fit(); started = true;
  requestAnimationFrame(frame);
  applyHash();
})();
