#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   bake.js — turn dev/hulls.js into the atlases the chart samples.

     node dev/bake.js            # write src/hulls-*.png + src/hulls.json
     node dev/bake.js --check    # verify they are up to date, write nothing

   WHY THIS IS A BAKE AND NOT A RUNTIME SHADER

   The chart's camera never moves. Every hull is seen from the same 24° above
   the orbital plane for all time, which is exactly the condition that makes a
   pre-rendered sprite the correct answer rather than a compromise — you are
   not throwing away angles you were ever going to use.

   What is baked is not a picture. It is albedo, a VIEW-SPACE NORMAL and an
   emissive mask, so the hull is still lit at runtime by the same sun direction
   that lights the planets. Move the sun and the shadows on the hulls move with
   it. That is the whole reason this beats drawing sprites.

   Structures bake once. Craft point where they are going, so they bake at
   HEADINGS steps around the plane — rotating the finished sprite would be
   wrong, because a hull pointing across the plane is foreshortened by the
   viewing angle and one pointing along it is not.

   Zero dependencies: the rasteriser is below and PNG is zlib, which ships with
   node. Nothing here needs a GPU, so it runs anywhere the other dev tools do.
   ───────────────────────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { FAMILIES, CRAFT, rng } = require("../src/hulls.js");

const OUT = path.join(__dirname, "..", "src");

/* The chart's viewing geometry, and it must agree with orrery.js:
     TILT = 0.40 = sin(24°), the squash applied to the orbital plane. */
const TILT = 0.40;
const COS  = Math.sqrt(1 - TILT * TILT);      // 0.9165

/* Inspection mode. Judging a hull from a 160px thumbnail in a grid of a
   hundred does not work — you cannot see what is wrong, so you tune blind and
   ship things that are obviously ugly the moment you look properly. This bakes
   ONE family at whatever resolution you want, into its own atlas:

     node dev/bake.js --only relay --cell 420

   and dev/hull-sheet.html?only=relay reads it. Work on one breed at a time. */
const ARG = (k, d) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ONLY = ARG("only", null);
/* 256, because the chart FRAMES a body when you select it — clicking a station
   fills a good part of the screen with it, so the sprite is magnified hard in
   the one situation where anybody is actually looking at a hull. At 160 that
   was visibly soft. The cost is real and was measured rather than guessed: the
   pair of atlases goes from 2.7 MB to 5.8 MB. */
const CELL = Number(ARG("cell", 256));   // baked pixels per hull
const SS       = 3;     // supersample factor, downsampled for the edges
const VARIANTS = 4;     // seeded variants per station family
const HEADINGS = 24;    // heading frames per craft, 15° apart

/* Albedo is stored NEUTRAL. The runtime multiplies by the body's own tint, so
   baking colour in here would tint everything twice and lose the fleet's
   palette. Materials differ in value, not in hue. */
const ALBEDO = { 0: 0.86, 1: 0.50, 2: 0.68, 3: 1.00, 4: 0.30, 5: 0.80,
                 6: 0.12, 7: 0.95, 8: 0.20, 9: 0.62,
                 10: 0.72, 11: 0.20, 12: 0.90 };  // livery / ion / plume

/* Each breed's trademark is a colour of light, and the colour is an ACCENT ID
   rather than an RGB value, because albedo is stored neutral so the runtime can
   tint hulls by their body colour. The id says WHICH colour; the emissive mask
   says how much it glows. Solar cells use an id with no glow at all, which is
   how a material gets a hue without becoming a light. */
/* Id 6 is not a colour: it means USE THE FAMILY'S LIVERY, which the runtime
   supplies as a uniform. It is how one baked material can be terracotta on a
   hab and hazard yellow on a truss — and how the tender's plume comes out
   amber while the courier's comes out ion blue from the same geometry. */
const ACCENT = { 4: 1, 6: 5, 7: 2, 8: 2, 9: 2, 10: 6, 11: 6, 12: 6 };
/* The radiator's is deliberately a tenth of a window's. It is rejecting heat,
   which is the ship working — a radiator that reads as a light source reads as
   a fire instead. */
const EMIT_STRENGTH = { 4: 1.0, 7: 0.04, 8: 1.0, 9: 0.10, 11: 1.0, 12: 0.85 };

/* Per-plate tonal variation, hashed off the triangle's own position so it is
   stable across rebakes. A real hull is hundreds of plates that do not match —
   different batches, different ages, different sun — and one flat value across
   a whole material is most of what makes an untextured mesh read as moulded.
   Narrow on purpose: wider stops reading as plating and starts reading as
   damage. Must stay in step with the same hash in dev/forge.html. */
function plateTone(v) {
  let h = Math.imul(Math.round(v[0] * 5000) ^ 0x9e37, 0x85eb);
  h = Math.imul(h ^ Math.round(v[1] * 5000), 0xc2b2);
  h = Math.imul(h ^ Math.round(v[2] * 5000), 0x27d4);
  h = (h ^ (h >>> 15)) >>> 0;
  return 0.88 + (h / 4294967296) * 0.24;
}

/* ── projection ─────────────────────────────────────────────────────────── */

/* World → screen, matching orrery.js: +y goes DOWN the screen squashed by
   TILT, +z (out of the plane) goes up. `key` is nearness for the z-buffer:
   both +y and +z point toward the viewer. */
const project = (p) => ({
  x: p[0],
  y: p[1] * TILT - p[2] * COS,
  key: p[1] * COS + p[2] * TILT,
});

/* A normal in the same view basis. z is toward the viewer, which is what the
   fragment shader needs to light it against a screen-space sun. */
const projectN = (n) => {
  const x = n[0], y = n[1] * TILT - n[2] * COS, z = n[1] * COS + n[2] * TILT;
  const L = Math.hypot(x, y, z) || 1;
  return [x / L, y / L, z / L];
};

function rotZ(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

function triNormal(a, b, c) {
  const u = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
  const v = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
  return [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
}

/* ── rasteriser ─────────────────────────────────────────────────────────── */

/* Flat-shaded, z-buffered, supersampled. Flat is deliberate: these are hard
   surfaces a few dozen pixels across, and faceting reads as machined where
   smooth shading reads as melted. */
function raster(m, heading) {
  const W = CELL * SS;
  const verts = m.verts.map(p => rotZ(p, heading));

  // Frame the hull: fit its projected bounds with a small margin, so a long
  // courier and a fat hab both fill their cell.
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of verts) {
    const s = project(p);
    if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
  }
  const span = Math.max(maxX - minX, maxY - minY) * 1.06 || 1;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const scale = W / span;
  const toPx = (s) => ({ x: (s.x - cx) * scale + W / 2, y: (s.y - cy) * scale + W / 2 });

  const albedo = new Float32Array(W * W);
  const accent = new Float32Array(W * W);
  const nx = new Float32Array(W * W), ny = new Float32Array(W * W), nz = new Float32Array(W * W);
  const emit = new Float32Array(W * W);
  const cov  = new Float32Array(W * W);
  const zbuf = new Float32Array(W * W).fill(-1e9);

  for (const tri of m.tris) {
    const [i0, i1, i2, mat] = tri;
    const a = verts[i0], b = verts[i1], c = verts[i2];
    const nrm = projectN(triNormal(a, b, c));
    if (nrm[2] <= 0) continue;                       // backface: away from viewer
    const pa = project(a), pb = project(b), pc = project(c);
    const A = toPx(pa), B = toPx(pb), C = toPx(pc);

    const x0 = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
    const y0 = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y)));
    const y1 = Math.min(W - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
    const den = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    if (Math.abs(den) < 1e-12) continue;

    /* A plume carries its own fade instead of a plate tone — it has no
       plating, and without this the baked exhaust is a solid bright cone. */
    const alb = (ALBEDO[mat] ?? 0.7) *
      (tri.fade ? (tri.fade[0] + tri.fade[1] + tri.fade[2]) / 3 : plateTone(a));
    const em  = EMIT_STRENGTH[mat] ?? 0;
    const acc = ACCENT[mat] ?? 0;

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const sx = px + 0.5, sy = py + 0.5;
        const w0 = ((B.y - C.y) * (sx - C.x) + (C.x - B.x) * (sy - C.y)) / den;
        const w1 = ((C.y - A.y) * (sx - C.x) + (A.x - C.x) * (sy - C.y)) / den;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const key = w0 * pa.key + w1 * pb.key + w2 * pc.key;
        const k = py * W + px;
        if (key <= zbuf[k]) continue;                // something nearer is there
        zbuf[k] = key;
        albedo[k] = alb; emit[k] = em; cov[k] = 1; accent[k] = acc;
        nx[k] = nrm[0]; ny[k] = nrm[1]; nz[k] = nrm[2];
      }
    }
  }

  /* ── ambient occlusion ────────────────────────────────────────────────
     The thing that was making these read as cut paper. Flat shading gives a
     box three uniform tones and nothing else, so a greeble sitting on a hull
     has no darkening where it meets it and reads as pasted on rather than
     attached. AO puts the contact shadows back.

     It is baked rather than done at runtime because it does not depend on
     where the sun is — occlusion is a property of the shape. Horizon sampling
     over the depth buffer we already have: step out along a few directions and
     ask whether anything nearer is in the way. */
  const AO_DIRS = 12, AO_STEPS = 5, AO_RADIUS = W * 0.020;
  const ao = new Float32Array(W * W).fill(1);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (!cov[k]) continue;
      let occ = 0, n = 0;
      for (let d = 0; d < AO_DIRS; d++) {
        const a = (d / AO_DIRS) * Math.PI * 2;
        const dx = Math.cos(a), dy = Math.sin(a);
        for (let s = 1; s <= AO_STEPS; s++) {
          const t = (s / AO_STEPS) * AO_RADIUS;
          const sx = Math.round(x + dx * t), sy = Math.round(y + dy * t);
          n++;
          if (sx < 0 || sy < 0 || sx >= W || sy >= W) continue;
          const sk = sy * W + sx;
          if (!cov[sk]) continue;
          // nearer than us by enough to be a separate surface, not the same face
          const diff = zbuf[sk] - zbuf[k];
          if (diff > 0.004) occ += Math.min(1, diff * 14) * (1 - (s - 1) / AO_STEPS);
        }
      }
      ao[k] = Math.max(0.18, 1 - (occ / n) * 2.6);
    }
  }

  // downsample the supersampled buffers into the cell
  const out = { albedo: new Float32Array(CELL * CELL), emit: new Float32Array(CELL * CELL),
                nx: new Float32Array(CELL * CELL), ny: new Float32Array(CELL * CELL),
                nz: new Float32Array(CELL * CELL), cov: new Float32Array(CELL * CELL),
                ao: new Float32Array(CELL * CELL), accent: new Float32Array(CELL * CELL) };
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      let sa = 0, se = 0, sx2 = 0, sy2 = 0, sz2 = 0, sc = 0, sao = 0, sacc = 0, sn = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const k = (y * SS + j) * W + (x * SS + i);
          if (!cov[k]) continue;
          sa += albedo[k]; se += emit[k]; sao += ao[k];
          if (accent[k]) { sacc += accent[k]; sn++; }
          sx2 += nx[k]; sy2 += ny[k]; sz2 += nz[k]; sc++;
        }
      }
      const o = y * CELL + x;
      const n = SS * SS;
      out.cov[o] = sc / n;
      if (!sc) { out.nz[o] = 1; out.ao[o] = 1; continue; }
      // accent is an ID, so take the dominant one rather than a blur of two
      out.accent[o] = sn ? Math.round(sacc / sn) : 0;
      out.albedo[o] = sa / sc; out.emit[o] = se / sc; out.ao[o] = sao / sc;
      const L = Math.hypot(sx2, sy2, sz2) || 1;
      out.nx[o] = sx2 / L; out.ny[o] = sy2 / L; out.nz[o] = sz2 / L;
    }
  }
  return out;
}

/* ── PNG ────────────────────────────────────────────────────────────────── */

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                     // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRCT = null;
function crc32(buf) {
  if (!CRCT) {
    CRCT = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRCT[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRCT[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/* ── atlas ──────────────────────────────────────────────────────────────── */

function build() {
  /* Every cell the chart can ask for. Structures get VARIANTS seeded builds so
     two Ollama stations are siblings rather than the same object twice; craft
     get HEADINGS frames instead, since what varies for them is where they
     point. */
  const cells = [];
  const names = ONLY ? [ONLY] : Object.keys(FAMILIES);
  if (ONLY && !FAMILIES[ONLY]) { console.error(`no family '${ONLY}'`); process.exit(1); }
  for (const name of names) {
    if (CRAFT.has(name)) {
      for (let h = 0; h < HEADINGS; h++)
        cells.push({ family: name, variant: 0, heading: h });
    } else {
      for (let v = 0; v < VARIANTS; v++)
        cells.push({ family: name, variant: v, heading: 0 });
    }
  }

  const cols = Math.ceil(Math.sqrt(cells.length));
  const rows = Math.ceil(cells.length / cols);
  const W = cols * CELL, H = rows * CELL;
  const albedoBuf = Buffer.alloc(W * H * 4);
  const normalBuf = Buffer.alloc(W * H * 4);

  cells.forEach((cell, i) => {
    const seed = cell.family.length * 977 + cell.variant * 7919 + 13;
    const m = FAMILIES[cell.family](rng(seed));
    const r = raster(m, (cell.heading / HEADINGS) * Math.PI * 2);
    const ox = (i % cols) * CELL, oy = Math.floor(i / cols) * CELL;
    cell.col = i % cols; cell.row = Math.floor(i / cols);

    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const s = y * CELL + x;
        const d = ((oy + y) * W + (ox + x)) * 4;
        /* R albedo · G ambient occlusion · B spare · A coverage.
           Albedo is neutral so the runtime can tint it, which leaves two whole
           channels going spare — AO rides in one of them rather than needing a
           third texture. */
        albedoBuf[d]   = Math.round(Math.min(1, r.albedo[s]) * 255);
        albedoBuf[d+1] = Math.round(Math.min(1, r.ao[s]) * 255);
        albedoBuf[d+2] = Math.round(r.accent[s]) * 24;   // accent id, x24 to survive 8-bit
        albedoBuf[d+3] = Math.round(r.cov[s] * 255);
        normalBuf[d]   = Math.round((r.nx[s] * 0.5 + 0.5) * 255);
        normalBuf[d+1] = Math.round((r.ny[s] * 0.5 + 0.5) * 255);
        normalBuf[d+2] = Math.round((r.nz[s] * 0.5 + 0.5) * 255);
        normalBuf[d+3] = Math.round(Math.min(1, r.emit[s]) * 255);
      }
    }
  });

  const manifest = {
    cell: CELL, cols, rows, width: W, height: H,
    variants: VARIANTS, headings: HEADINGS,
    families: Object.keys(FAMILIES),
    craft: [...CRAFT],
    cells: cells.map(c => ({ f: c.family, v: c.variant, h: c.heading, c: c.col, r: c.row })),
  };

  const tag = ONLY ? `hulls-${ONLY}` : "hulls";
  const out = {
    [`${tag}-albedo.png`]: png(W, H, albedoBuf),
    [`${tag}-normal.png`]: png(W, H, normalBuf),
    [`${tag}.json`]: Buffer.from(JSON.stringify(manifest, null, 1) + "\n"),
  };

  /* The manifest again, as a SCRIPT rather than as data to fetch.
     The chart ships two ways — src/index.html and the single-file
     orrery.html at the repo root — and those two sit at different depths, so
     any path the chart fetches at runtime is right for one of them and wrong
     for the other. A script is not fetched: index.html lists it and the
     bundler inlines it, so the layout travels with whichever build you are
     looking at and there is one less thing that can fail after first paint.
     (The PNGs still have to be fetched, and probe both paths.) */
  if (!ONLY) {
    out["hulls-atlas.js"] = Buffer.from(
      "/* GENERATED by dev/bake.js — do not edit. Layout of the hull atlas.\n" +
      "   See the header there for what the channels mean. */\n" +
      "const HULL_ATLAS = " + JSON.stringify(manifest) + ";\n");
  }
  return out;
}

const files = build();
const check = process.argv.includes("--check");
let stale = false;
for (const [name, data] of Object.entries(files)) {
  const p = path.join(OUT, name);
  const cur = fs.existsSync(p) ? fs.readFileSync(p) : null;
  if (cur && cur.equals(data)) continue;
  if (check) { console.log(`${name} is STALE — run: node dev/bake.js`); stale = true; continue; }
  fs.writeFileSync(p, data);
  console.log(`wrote ${name} · ${(data.length / 1024).toFixed(0)} kB`);
}
if (check) {
  if (stale) process.exit(1);
  console.log("hull atlases are up to date");
}
