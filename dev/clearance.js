#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   clearance.js — does anything in the chart collide with anything else?

   Run it after touching fleet.js:   node dev/clearance.js

   Why this can be checked statically at all: a body's drawn radius is `rad`
   screen-px at zoom 100, i.e. rad/100 AU, and an orbit is AU × zoom. Both
   scale with zoom identically, so clearance is zoom-INVARIANT — one pass
   covers every zoom level there is.

   The test is nesting, not aphelion-vs-perihelion. Every orbit here is drawn
   from the same conic with no argument of periapsis (orrery.js orbitPoint:
   r = a(1-e²)/(1+e·cosA)), so all ellipses share a focus AND an orientation
   and therefore nest. Two orbits clear each other when the outer one stays
   outside the inner one at EVERY angle — which is a far weaker, and correct,
   condition than making the outer perihelion clear the inner aphelion.

   What is deliberately NOT a collision:
     · belt and swarm dust crossing a body — Ceres really is in the main belt,
       and the Trojans really do share Jupiter's orbit 60° away
     · comets — crossing everything is the entire job of a comet
     · stations sharing one ring — they differ in phase, not radius
   ───────────────────────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");

const FLEET_JS = process.argv[2] ||
  path.join(__dirname, "..", "src", "fleet.js");
const SERVICES_JS = path.join(path.dirname(FLEET_JS), "services.generated.js");
const G = new Function(fs.readFileSync(SERVICES_JS, "utf8") + "\n" +
  fs.readFileSync(FLEET_JS, "utf8") +
  `return {FLEET,RINGS,BELTS,SWARMS,SHELLS,HELIOPAUSE};`)();
const { FLEET, RINGS, BELTS, SWARMS, HELIOPAUSE } = G;

const byId = Object.fromEntries(FLEET.map(b => [b.id, b]));
const kids = p => FLEET.filter(b => b.parent === p);
const AU = b => b.rad / 100;

const N = 361;
const COS = Array.from({ length: N }, (_, i) => Math.cos((i / (N - 1)) * Math.PI));
const rAt = (b, c) => {
  const e = b.e || 0;
  return b.a * (1 - e * e) / (1 + e * c);
};

/* reach = how far a body's whole system extends from its own centre: its
   disc, its rings, its moons, and its moons' station shells, recursively. */
function reach(b) {
  let m = AU(b);
  for (const k of kids(b.id)) m = Math.max(m, k.a * (1 + (k.e || 0)) + reach(k));
  const rs = RINGS.find(r => r.host === b.id);
  if (rs) for (const band of rs.bands) m = Math.max(m, AU(b) * band.to);
  return m;
}

const problems = [];
const notes = [];
const fail = (where, msg) => problems.push(`${where}: ${msg}`);

/* ── 1. body vs body, per gravitational frame ─────────────────────────── */
const frames = [null, ...FLEET.filter(b => kids(b.id).length).map(b => b.id)];

for (const parentId of frames) {
  const parent = parentId ? byId[parentId] : null;
  const label = parent ? parent.name : "heliocentric";

  const list = FLEET.filter(b => (b.parent || null) === parentId &&
                                 b.a && !b.fixed)
                    .sort((x, y) => x.a - y.a);

  // stations on one ring share a radius by design — collapse them to the ring
  const seen = new Set();
  const items = [];
  for (const b of list) {
    if (b.station) {
      const key = b.a.toFixed(6);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    items.push({ b, R: b.station ? AU(b) : reach(b) });
  }

  // every body must clear the host's own surface (and rings)
  if (parent) {
    const rs = RINGS.find(r => r.host === parent.id);
    const surface = rs
      ? Math.max(AU(parent), ...rs.bands.map(x => AU(parent) * x.to))
      : AU(parent);
    for (const { b, R } of items) {
      const peri = Math.min(...COS.map(c => rAt(b, c)));
      if (peri - R < surface)
        fail(label, `${b.name} cuts into the ${rs ? "ring system" : "surface"}` +
          ` — inner edge ${(peri - R).toFixed(4)} < ${surface.toFixed(4)} AU`);
    }
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      let worst = Infinity, atC = 0;
      for (let k = 0; k < N; k++) {
        const gap = Math.abs(rAt(B.b, COS[k]) - rAt(A.b, COS[k])) - A.R - B.R;
        if (gap < worst) { worst = gap; atC = COS[k]; }
      }
      if (worst < 0)
        fail(label, `${A.b.name} × ${B.b.name} overlap by ` +
          `${(-worst).toFixed(4)} AU at θ=${(Math.acos(atC) * 180 / Math.PI).toFixed(0)}°`);
      else if (worst < 0.004 && !(A.b.station && B.b.station))
        notes.push(`${label}: ${A.b.name} × ${B.b.name} clear by only ` +
          `${worst.toFixed(4)} AU`);
    }
  }
}

/* ── 2. station shells vs each other and vs their host ────────────────── */
{
  const hosts = [...new Set(FLEET.filter(b => b.station).map(b => b.parent))];
  for (const h of hosts) {
    const host = byId[h];
    const rings = [...new Set(FLEET.filter(b => b.station && b.parent === h)
                                   .map(b => b.a))].sort((x, y) => x - y);
    const sr = AU(FLEET.find(b => b.station && b.parent === h));
    if (rings[0] - sr < AU(host))
      fail(host.name, `innermost station ring sits inside the body ` +
        `(${(rings[0] - sr).toFixed(4)} < ${AU(host).toFixed(4)} AU)`);
    for (let i = 1; i < rings.length; i++) {
      const gap = rings[i] - rings[i - 1] - 2 * sr;
      if (gap < 0)
        fail(host.name, `station rings ${i} and ${i + 1} overlap by ${(-gap).toFixed(4)} AU`);
      else if (gap < sr)
        notes.push(`${host.name}: station rings ${i}/${i + 1} clear by ` +
          `${gap.toFixed(4)} AU — under one station radius`);
    }
  }
}

/* ── 3. the drawn boundary has to contain the system ──────────────────── */
{
  let outer = 0, who = "";
  for (const b of FLEET) {
    if (b.parent || b.fixed || !b.a) continue;
    const ap = Math.max(...COS.map(c => rAt(b, c))) + reach(b);
    if (ap > outer) { outer = ap; who = b.name; }
  }
  for (const belt of BELTS) outer = Math.max(outer, belt.to);
  if (HELIOPAUSE < outer)
    fail("heliopause", `drawn at ${HELIOPAUSE} AU but the system reaches ` +
      `${outer.toFixed(2)} AU (${who})`);
  else
    notes.push(`heliopause ${HELIOPAUSE} AU · system reaches ${outer.toFixed(2)} AU (${who})`);
}

/* ── report ───────────────────────────────────────────────────────────── */
for (const n of notes) console.log(`  · ${n}`);
if (problems.length) {
  console.log("");
  for (const p of problems) console.log(`  ✗ ${p}`);
  console.log(`\n${problems.length} collision(s).`);
  process.exit(1);
}
console.log(`\nNo collisions. Checked ${frames.length} gravitational frames.`);
