#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   layout.js — solve the orbit layout so nothing collides, then write it back.

     node dev/layout.js            # solve and print, change nothing
     node dev/layout.js --write    # solve and patch src/fleet.js in place
     node dev/clearance.js         # verify (run this after --write)

   Also exported as a pure library for `orrery sync` and `orrery import`:
     const { solveLayout } = require("./dev/layout");

   ── the geometry ────────────────────────────────────────────────────────
   A body's drawn radius is `rad` screen-px at zoom 100, i.e. rad/100 AU, and
   an orbit is AU × zoom, so clearance is zoom-invariant: solve it once and it
   holds at every zoom.

   The constraint is NESTING. Every orbit is drawn from the same conic with no
   argument of periapsis (orrery.js orbitPoint: r = a(1-e²)/(1+e·cosA)), so all
   ellipses share a focus AND an orientation, and confocal co-oriented ellipses
   nest. An outer orbit does not have to clear the inner one's aphelion — it
   only has to stay outside it at every angle:

       for all θ:   r_j(θ) - R_j  ≥  F(θ) + clearance

   where F(θ) is the outer envelope of everything already placed and R is a
   body's full system reach — its disc, its rings, its moons, and its moons'
   station shells, recursively.
   ───────────────────────────────────────────────────────────────────────── */
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_PARAMS = {
  shell0: 1.45,   // first station shell, × host radius — matches ringRadius()
  shellK: 0.14,   // shell spacing, × first             — matches ringRadius()
  gapK:   0.45,   // clearance between neighbours, × their combined reach
};

const N = 181;                                   // θ samples over [0, π]
const COS = Array.from({ length: N }, (_, i) => Math.cos((i / (N - 1)) * Math.PI));
const rAt = (a, e, c) => a * (1 - e * e) / (1 + e * c);

function cloneFleetInput(fleetData, P) {
  const rings = (fleetData.RINGS || fleetData.rings || []).map(r => ({
    ...r,
    bands: (r.bands || []).map(b => ({ ...b })),
  }));
  const shells = [...(fleetData.SHELLS || fleetData.shells || [])];
  const belts = (fleetData.BELTS || fleetData.belts || []).map(b => ({
    ...b,
    gaps: (b.gaps || []).map(g => [...g]),
    spanIds: b.spanIds ? [...b.spanIds] : undefined,
    resonances: b.resonances ? b.resonances.map(g => [...g]) : undefined,
    bandResonance: b.bandResonance ? [...b.bandResonance] : undefined,
  }));
  const reserved = (fleetData.RESERVED || fleetData.reserved || []).map(r =>
    Array.isArray(r) ? [...r] : { ...r }
  );

  let fleet;
  if (Array.isArray(fleetData.FLEET || fleetData.fleet)) {
    fleet = (fleetData.FLEET || fleetData.fleet).map(b => ({ ...b }));
  } else {
    const hosts = (fleetData.SYS || fleetData.hosts || []).map(b => ({ ...b }));
    const services = fleetData.SERVICES || fleetData.services || [];
    fleet = hosts.slice();
    const hostById = Object.fromEntries(hosts.map(b => [b.id, b]));
    const hostIds = [...new Set(services.map(s => s.host))];
    for (const hostId of hostIds) {
      const parent = hostById[hostId];
      if (!parent) continue;
      const mine = services.filter(s => s.host === hostId);
      const used = shells.filter(id => mine.some(s => s.shell === id));
      const extraShells = [...new Set(mine.map(s => s.shell).filter(Boolean))]
        .filter(id => !used.includes(id));
      const ringList = used.length || extraShells.length ? [...used, ...extraShells] : [null];
      const bodyAU = (parent.rad || 10) / 100;
      const first = bodyAU * P.shell0;
      ringList.forEach((ringId, ri) => {
        const members = mine.filter(s => (s.shell || null) === ringId);
        const a = first + ri * (first * P.shellK);
        members.forEach(s => {
          fleet.push({
            id: `svc-${hostId}-${s.name}`,
            name: s.name,
            kind: "station",
            parent: hostId,
            a,
            e: 0,
            rad: 0.42,
            station: true,
            shell: ringId,
          });
        });
      });
    }
    for (const r of reserved) {
      const name = Array.isArray(r) ? r[0] : r.name;
      const a = Array.isArray(r) ? r[1] : r.a;
      const e = Array.isArray(r) ? (r[2] || 0) : (r.e || 0);
      const id = "res-" + String(name).toLowerCase();
      if (!fleet.some(b => b.id === id)) {
        fleet.push({ id, name, kind: "reserved", a, e, rad: 3.4, state: "reserved", tier: 3 });
      }
    }
  }

  const byId = Object.fromEntries(fleet.map(b => [b.id, b]));
  const byHost = {};
  for (const b of fleet) if (b.station) (byHost[b.parent] ||= []).push(b);
  for (const list of Object.values(byHost)) {
    const usedShells = [...new Set(list.map(s => s.shell))].sort((a, z) => {
      const ia = shells.indexOf(a), iz = shells.indexOf(z);
      if (ia < 0 && iz < 0) return String(a || "").localeCompare(String(z || ""));
      if (ia < 0) return 1;
      if (iz < 0) return -1;
      return ia - iz;
    });
    for (const s of list) s._ri = Math.max(0, usedShells.indexOf(s.shell));
  }
  for (const b of fleet) {
    b._a0 = b.a || 0;
    b._e0 = b.e || 0;
  }
  return { FLEET: fleet, RINGS: rings, SHELLS: shells, BELTS: belts, RESERVED: reserved, byId };
}

function runPass(fleetData, P, eScale = {}) {
  const { FLEET, RINGS, BELTS, RESERVED, byId } = cloneFleetInput(fleetData, P);
  const kids = p => FLEET.filter(b => b.parent === p);
  const AU = b => (b.rad || 4) / 100;

  /* Quantise to the precision written to disk INSIDE the solve so repeated
     runs are strictly idempotent. Axes round outward and eccentricities round
     inward, so clearance on disk is always at least as generous as solved. */
  const qA = x => Math.ceil(x * 1000) / 1000;
  const qE = x => Math.floor(x * 1000) / 1000;

  for (const b of FLEET) b.e = b.station ? 0 : qE(b._e0 * (eScale[b.id] ?? 1));
  for (const b of FLEET) {
    if (!b.station || !byId[b.parent]) continue;
    const first = AU(byId[b.parent]) * P.shell0;
    b.a = first + b._ri * (first * P.shellK);
  }

  const reach = b => {
    let m = AU(b);
    for (const k of kids(b.id)) m = Math.max(m, k.a * (1 + (k.e || 0)) + reach(k));
    const rs = RINGS.find(r => r.host === b.id);
    if (rs) for (const band of rs.bands) m = Math.max(m, AU(b) * band.to);
    return m;
  };

  /* A host's satellites start outside its RINGS, not its disc. */
  const seedOf = b => {
    if (!b) return 0.38;
    const rs = RINGS.find(r => r.host === b.id);
    return rs ? Math.max(AU(b), ...rs.bands.map(x => AU(b) * x.to)) : AU(b);
  };

  function pack(parentId, seed, compact) {
    const list = FLEET.filter(b => (b.parent || null) === parentId &&
                                   b.a && !b.fixed && !b.station)
                      .sort((x, y) => x.a - y.a);
    for (const b of list) pack(b.id, seedOf(b), true);

    const F = new Float64Array(N).fill(seed);
    for (const b of list) {
      const R = reach(b), e = b.e || 0;
      let aMin = 0;
      for (let i = 0; i < N; i++)
        aMin = Math.max(aMin, (F[i] + P.gapK * R + R) * (1 + e * COS[i]) / (1 - e * e));
      b.a = qA(compact ? aMin : Math.max(b.a, aMin));
      b._R = R;
      for (let i = 0; i < N; i++)
        F[i] = Math.max(F[i], rAt(b.a, e, COS[i]) + R + P.gapK * R);
    }
    let outer = seed;
    for (let i = 0; i < N; i++) outer = Math.max(outer, F[i]);
    return outer;
  }

  const center = FLEET.find(b => !b.parent && !b.fixed && !b.a) || null;
  const outer = pack(null, seedOf(center), false);
  return { outer, FLEET, RINGS, BELTS, RESERVED, byId, reach, AU };
}

/**
 * Pure reusable orbit solver. Accepts any fleet topology with zero hardcoded
 * planet IDs or reserved names.
 */
function solveLayout(fleetData, options = {}) {
  const P = {
    shell0: options.shell0 ?? DEFAULT_PARAMS.shell0,
    shellK: options.shellK ?? DEFAULT_PARAMS.shellK,
    gapK:   options.gapK   ?? DEFAULT_PARAMS.gapK,
  };
  const budget = Number(options.target ?? 20.0);

  const eScale = {};
  let R = null;
  let failed = true;
  for (let round = 0; round < 900; round++) {
    R = runPass(fleetData, P, eScale);
    if (R.outer <= budget) { failed = false; break; }
    let worst = null, worstCost = 0;
    for (const b of R.FLEET) {
      if (b.station || b.fixed || !b.a || !b._e0) continue;
      if ((eScale[b.id] ?? 1) <= 0.02) continue;
      const cost = b.a * (b.e || 0);
      if (cost > worstCost) { worstCost = cost; worst = b.id; }
    }
    if (!worst) { failed = true; break; }
    eScale[worst] = (eScale[worst] ?? 1) * 0.75;
  }
  if (!R) R = runPass(fleetData, P, eScale);

  const spanOf = ids => {
    const bs = ids.map(id => R.byId[id]).filter(b => b && b.a && b._R !== undefined);
    if (!bs.length) return null;
    return [
      Math.min(...bs.map(b => b.a * (1 - (b.e || 0)) - b._R)),
      Math.max(...bs.map(b => b.a * (1 + (b.e || 0)) + b._R)),
    ];
  };

  /* Derive belt geometry generically from optional belt hints (spanIds,
     resonanceHost, resonances, bandResonance). Zero hardcoded planet IDs. */
  const beltsOut = {};
  let maxBeltTo = 0;
  for (const belt of R.BELTS) {
    const next = { from: belt.from, to: belt.to };
    if (Array.isArray(belt.spanIds) && belt.spanIds.length) {
      const sp = spanOf(belt.spanIds);
      if (sp) { next.from = +sp[0].toFixed(2); next.to = +sp[1].toFixed(2); }
    }
    const anchor = belt.resonanceHost ? R.byId[belt.resonanceHost] : null;
    if (anchor && anchor.a) {
      const res = (p, q) => anchor.a * Math.pow(p / q, 2 / 3);
      if (Array.isArray(belt.bandResonance) && belt.bandResonance.length === 2) {
        const h = res(belt.bandResonance[0], belt.bandResonance[1]);
        next.from = +(h * 0.966).toFixed(2);
        next.to = +(h * 1.034).toFixed(2);
      }
      if (Array.isArray(belt.resonances) && belt.resonances.length) {
        next.gaps = belt.resonances.map(([p, q]) => [
          +(res(p, q) * 0.988).toFixed(2),
          +(res(p, q) * 1.012).toFixed(2),
        ]);
      }
    }
    if (typeof next.to === "number") maxBeltTo = Math.max(maxBeltTo, next.to);
    if (belt.id) beltsOut[belt.id] = next;
  }

  let trueOuter = R.outer;
  for (const b of R.FLEET) {
    if (b.parent || b.fixed || !b.a) continue;
    const ap = Math.max(...COS.map(c => rAt(b.a, b.e || 0, c))) + R.reach(b);
    if (ap > trueOuter) trueOuter = ap;
  }
  const heliopause = +(Math.max(trueOuter, maxBeltTo) * 1.045).toFixed(1);

  const bodies = Object.fromEntries(
    R.FLEET
      .filter(b => !b.station && !b.fixed && b.a)
      .map(b => [b.id, { a: +b.a.toFixed(3), e: +(b.e || 0).toFixed(3) }])
  );

  const reservedNames = R.RESERVED.map(r => (Array.isArray(r) ? r[0] : r.name)).filter(Boolean);

  return {
    outer: R.outer,
    heliopause,
    bodies,
    belts: beltsOut,
    reservedNames,
    failed,
    fleet: R.FLEET,
    byId: R.byId,
    params: P,
    target: budget,
  };
}

function loadFleetData(fleetPath, servicesPath) {
  const fleetSrc = fs.readFileSync(fleetPath, "utf8");
  const servicesSrc = servicesPath && fs.existsSync(servicesPath)
    ? fs.readFileSync(servicesPath, "utf8")
    : "const SERVICES = [];";
  const G = new Function(
    servicesSrc + "\n" + fleetSrc +
    "\nreturn { FLEET, RINGS, SHELLS, BELTS, RESERVED: typeof RESERVED !== 'undefined' ? RESERVED : [], HELIOPAUSE };"
  )();
  return { ...G, SRC: fleetSrc };
}

function patchFleetSource(src, solved) {
  let out = src;
  const num = "-?\\d+(?:\\.\\d+)?";

  function literal(s, id) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = s.match(new RegExp(`id\\s*:\\s*["']${escaped}["']`));
    if (!m) return null;
    const at = m.index;
    const start = s.lastIndexOf("{", at);
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && !--depth) return [start, i + 1];
    }
    return null;
  }

  let patched = 0;
  const missing = [];
  const reservedIds = new Set(solved.reservedNames.map(n => "res-" + n.toLowerCase()));

  for (const [id, v] of Object.entries(solved.bodies)) {
    if (reservedIds.has(id)) continue;
    const span = literal(out, id);
    if (!span) { missing.push(id); continue; }
    const [s, e] = span;
    let body = out.slice(s, e);
    body = body.replace(new RegExp(`([{,]\\s*)a:\\s*${num}`), `$1a:${v.a}`);
    if (v.e > 0)
      body = new RegExp(`[{,]\\s*e:\\s*${num}`).test(body)
        ? body.replace(new RegExp(`([{,]\\s*)e:\\s*${num}`), `$1e:${v.e}`)
        : body.replace(new RegExp(`([{,]\\s*a:${num})`), `$1, e:${v.e}`);
    else
      body = body.replace(new RegExp(`,\\s*e:\\s*${num}`), "");
    out = out.slice(0, s) + body + out.slice(e);
    patched++;
  }

  if (solved.reservedNames.length) {
    const rows = solved.reservedNames.map(n => {
      const v = solved.bodies["res-" + n.toLowerCase()];
      return v && `["${n}", ${v.a}, ${v.e}]`;
    });
    if (rows.every(Boolean)) {
      const lines = [];
      for (let i = 0; i < rows.length; i += 3) lines.push("  " + rows.slice(i, i + 3).join(", "));
      out = out.replace(
        /(const RESERVED = (?:\([^;]*?\)\s*\?\s*\[\]\s*:\s*)?)\[[\s\S]*?\];/,
        `$1[\n${lines.join(",\n")},\n];`
      );
      patched += rows.length;
    } else {
      missing.push("RESERVED");
    }
  }

  for (const [id, belt] of Object.entries(solved.belts)) {
    const escId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(
      new RegExp(`(\\{\\s*id:\\s*["']${escId}["'],\\s+from:\\s*)[\\d.]+(,\\s*to:\\s*)[\\d.]+`),
      `$1${belt.from}$2${belt.to}`
    );
    if (Array.isArray(belt.gaps)) {
      out = out.replace(
        new RegExp(`(id:\\s*["']${escId}["'][\\s\\S]*?gaps:\\s*)\\[\\[[\\d.,\\s\\[\\]]*\\]\\]`),
        `$1[${belt.gaps.map(g => `[${g[0]}, ${g[1]}]`).join(", ")}]`
      );
    }
  }

  out = out.replace(/((?:const|let) HELIOPAUSE = )[\d.]+/, `$1${solved.heliopause}`);
  return { src: out, patched, missing };
}

function cli(argv = process.argv.slice(2)) {
  const flagVal = name => {
    const i = argv.indexOf(name);
    return i < 0 ? null : argv[i + 1];
  };
  const FLEET_JS = path.resolve(flagVal("--fleet") || path.join(__dirname, "..", "src", "fleet.js"));
  const SERVICES_JS = path.resolve(flagVal("--services") || path.join(path.dirname(FLEET_JS), "services.generated.js"));
  const WRITE = argv.includes("--write");
  const TARGET = Number(flagVal("--target") ?? process.env.TARGET ?? 20.0);

  const loaded = loadFleetData(FLEET_JS, SERVICES_JS);
  const solved = solveLayout(loaded, { target: TARGET });

  if (solved.failed)
    console.log(`⚠ could not fit ${TARGET} AU even with every oval flattened — raise TARGET or shrink a body\n`);

  console.log(`outer edge ${solved.outer.toFixed(2)} AU / target ${TARGET} · gapK ${solved.params.gapK}\n`);
  console.log("body                    a AU              e");
  for (const b of solved.fleet) {
    if (b.station || b.fixed || !b.a) continue;
    const e = b.e || 0, moved = Math.abs(b.a - b._a0) > 0.005;
    console.log(`${((b.parent ? "  ↳ " : "") + b.name + "                    ").slice(0, 20)}` +
      ` ${b._a0.toFixed(2).padStart(6)}→${b.a.toFixed(3).padStart(7)}` +
      ` ${b._e0.toFixed(3)}→${e.toFixed(3)}${moved ? "" : "   (held)"}`);
  }

  console.log(`\n── derived minor bodies ──`);
  for (const [id, b] of Object.entries(solved.belts)) {
    const gapStr = b.gaps ? `   gaps ${b.gaps.map(g => g.join("–")).join("  ")}` : "";
    console.log(`${id.padEnd(10)} ${b.from} .. ${b.to}${gapStr}`);
  }
  console.log(`heliopause ${solved.heliopause}`);

  if (!WRITE) {
    console.log(`\n(nothing written — pass --write to patch ${path.relative(process.cwd(), FLEET_JS)})`);
    return solved;
  }

  const res = patchFleetSource(loaded.SRC, solved);
  fs.writeFileSync(FLEET_JS, res.src);
  console.log(`\npatched ${res.patched} bodies in ${path.relative(process.cwd(), FLEET_JS)}` +
              (res.missing.length ? `  ✗ MISSING: ${res.missing.join(", ")}` : ""));
  console.log(`now run:  node dev/clearance.js`);
  return solved;
}

if (require.main === module) cli();

module.exports = {
  DEFAULT_PARAMS,
  solveLayout,
  loadFleetData,
  patchFleetSource,
  cli,
};
