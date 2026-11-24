#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   sync.js — Orrery drop-in homelab auto-importer & watch worker (v2).

   Runtime (networkless container):
     orrery sync --config /config/orrery.config.json \
       --root /config --output /generated/services.js --watch

   Direct invocation:
     node dev/sync.js --config orrery.config.json --output src/services.generated.js
     node dev/sync.js --check

   No Docker socket and no .env files are ever read. Supporting containers do
   not become stations: services collapse by `product`, while multi-compose
   files support Traefik labels, Caddy/Homepage/Orrery labels, or `mode: "all"`.
   `dynamicTraefikFile` and `gatusFile` are strictly optional.
   ───────────────────────────────────────────────────────────────────────── */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { solveLayout, loadFleetData } = require("./layout");

function stripQuotes(val) {
  const s = String(val ?? "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  return s;
}

function unquoteYamlScalar(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  // strip inline comment on unquoted value
  const hash = s.indexOf(" #");
  if (hash >= 0) s = s.slice(0, hash).trim();
  return s;
}

/**
 * Parse services and labels from a docker-compose YAML file without external deps.
 * Supports:
 *   - Traefik labels (traefik.http.routers.<name>.rule=...)
 *   - Caddy Docker Proxy labels (caddy, caddy_<n>, caddy.reverse_proxy)
 *   - Homepage labels (homepage.name, homepage.href, homepage.group)
 *   - Orrery native labels (orrery.enable, orrery.ignore, orrery.product, orrery.name, orrery.host, orrery.shell, orrery.state)
 *   - mode: "routed" (default) | "all"
 */
function parseComposeServices(text, options = {}) {
  const mode = options.mode === "all" ? "all" : "routed";
  const lines = String(text || "").split(/\r?\n/);
  const services = [];

  let inServices = false;
  let serviceIndent = null;
  let current = null;
  let inLabels = false;
  let labelsIndent = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = rawLine.match(/^(\s*)/)[1].length;

    if (!inServices) {
      if (indent === 0 && /^services:\s*(?:#.*)?$/.test(trimmed)) inServices = true;
      continue;
    }

    if (indent === 0) break; // exited top-level `services:` section

    if (serviceIndent === null) serviceIndent = indent;

    if (indent === serviceIndent) {
      const m = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (m) {
        current = { service: m[1], labels: {} };
        services.push(current);
        inLabels = false;
        labelsIndent = null;
      }
      continue;
    }

    if (!current) continue;

    if (indent > serviceIndent && !inLabels) {
      if (/^labels:\s*(?:#.*)?$/.test(trimmed)) {
        inLabels = true;
        labelsIndent = indent;
      }
      continue;
    }

    if (inLabels) {
      if (indent <= labelsIndent) {
        inLabels = false;
        labelsIndent = null;
        if (/^labels:\s*(?:#.*)?$/.test(trimmed)) {
          inLabels = true;
          labelsIndent = indent;
        }
        continue;
      }

      // List form: - "key=value" or - key=value
      const listMatch = trimmed.match(/^-\s+(.+)$/);
      if (listMatch) {
        const entry = stripQuotes(unquoteYamlScalar(listMatch[1]));
        const eq = entry.indexOf("=");
        if (eq > 0) {
          const k = stripQuotes(entry.slice(0, eq).trim());
          const v = stripQuotes(entry.slice(eq + 1).trim());
          current.labels[k] = v;
        }
        continue;
      }

      // Map form: key: value or "key": "value"
      const mapMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (mapMatch) {
        const k = stripQuotes(mapMatch[1].trim());
        const v = unquoteYamlScalar(mapMatch[2]);
        current.labels[k] = v;
      }
    }
  }

  const found = [];
  for (const svc of services) {
    const labels = svc.labels;
    if (String(labels["orrery.ignore"] || "").toLowerCase() === "true") continue;

    const traefikDisabled = String(labels["traefik.enable"] || "").toLowerCase() === "false";
    let traefikRouter = null;
    let caddyRouted = false;
    let homepageRouted = false;
    let orreryEnabled = String(labels["orrery.enable"] || "").toLowerCase() === "true" ||
                        Boolean(labels["orrery.product"]);

    for (const [k, v] of Object.entries(labels)) {
      if (!traefikDisabled && !traefikRouter) {
        const rm = k.match(/^traefik\.http\.routers\.([^.]+)\.rule$/);
        if (rm) traefikRouter = rm[1];
      }
      if (/^caddy(?:_\d+)?(?:\.reverse_proxy)?$/.test(k) && v) caddyRouted = true;
      if (/^homepage\.(?:name|href|group)$/.test(k) && v) homepageRouted = true;
    }

    const routed = Boolean(traefikRouter || caddyRouted || homepageRouted || orreryEnabled);
    if (mode === "routed" && !routed) continue;

    found.push({
      service: svc.service,
      router: traefikRouter || (caddyRouted ? "caddy" : homepageRouted ? "homepage" : null),
      labels,
    });
  }
  return found;
}

/**
 * Parse Traefik file-provider dynamic routers (http.routers.*).
 */
function parseDynamicRouters(text) {
  const found = [];
  const lines = String(text || "").split(/\r?\n/);
  let inRouters = false;
  let routersIndent = null;
  let entryIndent = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.match(/^(\s*)/)[1].length;

    if (!inRouters) {
      if (/^routers:\s*(?:#.*)?$/.test(trimmed)) {
        inRouters = true;
        routersIndent = indent;
        entryIndent = null;
      }
      continue;
    }

    if (indent <= routersIndent) {
      inRouters = false;
      continue;
    }
    if (entryIndent === null) entryIndent = indent;
    if (indent === entryIndent) {
      const m = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
      if (m) found.push(m[1]);
    }
  }
  return found;
}

/**
 * Parse Gatus config.yaml endpoints (`group` + `name`).
 */
function parseGatusEndpoints(text) {
  const found = new Set();
  const lines = String(text || "").split(/\r?\n/);
  let name = null, group = null;
  const flush = () => {
    if (name && group) found.add(`${group}\u0000${name}`);
    name = group = null;
  };
  for (const line of lines) {
    const item = line.match(/^\s*-\s+name:\s*(.+?)\s*$/);
    if (item) { flush(); name = unquoteYamlScalar(item[1]); continue; }
    const gItem = line.match(/^\s*-\s+group:\s*(.+?)\s*$/);
    if (gItem) { flush(); group = unquoteYamlScalar(gItem[1]); continue; }
    const n = line.match(/^\s+name:\s*(.+?)\s*$/);
    if (n && !name) { name = unquoteYamlScalar(n[1]); continue; }
    const g = line.match(/^\s+group:\s*(.+?)\s*$/);
    if (g && !group) { group = unquoteYamlScalar(g[1]); continue; }
  }
  flush();
  return found;
}

function parseComposeIncludes(text) {
  const found = [];
  let inInclude = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^include:\s*(?:#.*)?$/.test(line)) { inInclude = true; continue; }
    if (inInclude && /^\S/.test(line) && line.trim() && !line.startsWith("#")) break;
    const item = line.match(/^\s+-\s+(?:path:\s*)?['"]?(?:\.\/)?([^'"\s#]+\.ya?ml)['"]?\s*(?:#.*)?$/);
    if (inInclude && item) found.push(item[1]);
  }
  return found;
}

function normalizeConfig(raw) {
  const version = raw.version ?? 2;
  if (version !== 1 && version !== 2)
    throw new Error(`unsupported config version ${version}`);

  const discovery = raw.discovery || {};
  const composeFiles = discovery.composeFiles || raw.composeFiles || [];
  const composeInclude = discovery.composeInclude !== undefined
    ? discovery.composeInclude : (raw.composeInclude ?? null);
  const defaultComposeShell = discovery.defaultComposeShell !== undefined
    ? discovery.defaultComposeShell : (raw.defaultComposeShell ?? null);
  const tolerant = Boolean(discovery.tolerant ?? raw.tolerant ?? false);
  const defaultMode = discovery.mode || raw.mode || "routed";
  const dynamicTraefikFile = discovery.dynamicTraefikFile !== undefined
    ? discovery.dynamicTraefikFile : (raw.dynamicTraefikFile ?? null);
  const gatusFile = discovery.gatusFile !== undefined
    ? discovery.gatusFile : (raw.gatusFile ?? null);

  const hosts = Array.isArray(raw.hosts) ? raw.hosts : [];
  const firstAllocatedHost = hosts.find(h => h && h.id && h.kind !== "star" && !h.fixed);
  const defaultHost = raw.defaultHost || discovery.defaultHost ||
    (firstAllocatedHost ? firstAllocatedHost.id : (version === 1 ? "homelab" : null));

  const fleet = raw.fleet || {};
  const status = fleet.status || raw.status || {};

  return {
    version,
    defaultHost,
    defaultMode,
    composeFiles,
    composeInclude,
    defaultComposeShell,
    tolerant,
    dynamicTraefikFile,
    gatusFile,
    fleet,
    status,
    shells: Array.isArray(raw.shells) ? raw.shells : null,
    hosts,
    rings: Array.isArray(raw.rings) ? raw.rings : [],
    belts: Array.isArray(raw.belts) ? raw.belts : [],
    reserved: Array.isArray(raw.reserved) ? raw.reserved : [],
    layout: raw.layout || {},
    excludeSources: new Set(raw.excludeSources || []),
    excludeServices: new Set(raw.excludeServices || []),
    sourceOverrides: raw.sourceOverrides || {},
    productOverrides: raw.productOverrides || {},
    extraProducts: raw.extraProducts || [],
  };
}

function readOptionalFile(rootDir, relPath) {
  if (!relPath) return null;
  const full = path.isAbsolute(relPath) ? relPath : path.join(rootDir, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

function resolveComposeFiles(config, rootDir, warnings) {
  const listed = config.composeFiles || [];
  if (!config.composeInclude) return listed;
  const text = readOptionalFile(rootDir, config.composeInclude);
  if (text === null) {
    warnings.push(`${config.composeInclude} is not mounted or does not exist; falling back to composeFiles`);
    return listed;
  }
  const byPath = new Map(listed.map(entry => {
    const filePath = typeof entry === "string" ? entry : entry.path;
    return [filePath, typeof entry === "string" ? { path: entry } : entry];
  }));
  const included = parseComposeIncludes(text);
  const fallbackShell = config.defaultComposeShell || null;
  const resolved = included.map(filePath => {
    if (byPath.has(filePath)) return byPath.get(filePath);
    warnings.push(`${filePath} has no entry in composeFiles; using ${fallbackShell || "no shell"}`);
    return { path: filePath, shell: fallbackShell };
  });
  for (const filePath of byPath.keys()) {
    if (!included.includes(filePath)) {
      warnings.push(`composeFiles lists ${filePath}, which ${config.composeInclude} does not include`);
    }
  }
  return resolved;
}

/**
 * Generate the logical product roster and optional solved layout metadata.
 */
function generateRoster(rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig);
  const tolerant = Boolean(options.tolerant ?? config.tolerant);
  const rootDir = path.resolve(options.root || process.cwd());
  const warnings = [];
  const sources = [];

  for (const entry of resolveComposeFiles(config, rootDir, warnings)) {
    const filePath = typeof entry === "string" ? entry : entry.path;
    const host = (typeof entry === "object" && entry.host) || config.defaultHost;
    const shell = (typeof entry === "object" && entry.shell) || null;
    const mode = (typeof entry === "object" && entry.mode) || config.defaultMode;
    const optional = Boolean(typeof entry === "object" && entry.optional);
    const full = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);

    if (!fs.existsSync(full)) {
      if (optional) continue;
      if (tolerant) {
        warnings.push(`${filePath} is not mounted or does not exist; its services are missing`);
        continue;
      }
      throw new Error(`compose file not found: ${full}`);
    }
    const text = fs.readFileSync(full, "utf8");
    for (const item of parseComposeServices(text, { mode })) {
      if (config.excludeServices.has(item.service)) continue;
      const lbl = item.labels || {};
      const product = lbl["orrery.product"] || item.service;
      const name = lbl["orrery.name"] || lbl["homepage.name"] || product;
      sources.push({
        source: `compose:${item.service}`,
        product,
        name,
        host: lbl["orrery.host"] || host,
        shell: lbl["orrery.shell"] || shell,
        state: lbl["orrery.state"] || undefined,
        router: item.router,
      });
    }
  }

  // Strictly optional dynamic Traefik file — never throws ENOENT if absent.
  const dynamicText = readOptionalFile(rootDir, config.dynamicTraefikFile);
  if (dynamicText !== null) {
    for (const router of parseDynamicRouters(dynamicText)) {
      sources.push({
        source: `dynamic:${router}`,
        product: router,
        name: router,
        host: null,
        shell: null,
        router,
      });
    }
  }

  const products = new Map();
  for (const source of sources) {
    if (config.excludeSources.has(source.source)) continue;
    const override = config.sourceOverrides[source.source] || {};
    const item = { ...source, ...override };
    if (!item.host) {
      if (tolerant) {
        warnings.push(`${source.source} has no host; set composeFiles[].host, defaultHost, or add a sourceOverride / exclude it (skipped)`);
        continue;
      }
      throw new Error(`${source.source} has no host; set composeFiles[].host, defaultHost, or add a sourceOverride / exclude it`);
    }
    const existing = products.get(item.product);
    if (existing) {
      if (existing.host !== item.host || (existing.shell || null) !== (item.shell || null)) {
        if (tolerant) {
          warnings.push(`${item.source} disagrees with ${existing.sources[0]} on host or shell for ${item.product} (skipped)`);
          continue;
        }
        throw new Error(`${item.product} sources disagree on host or shell`);
      }
      if (!existing.sources.includes(item.source)) existing.sources.push(item.source);
      if (item.router && !existing.routers.includes(item.router)) existing.routers.push(item.router);
    } else {
      products.set(item.product, {
        product: item.product,
        name: item.name,
        host: item.host,
        shell: item.shell || null,
        state: item.state,
        sources: [item.source],
        routers: item.router ? [item.router] : [],
      });
    }
  }

  for (const extra of config.extraProducts) {
    if (products.has(extra.product)) {
      if (tolerant) {
        warnings.push(`extra product ${extra.product} is already discovered (skipped)`);
        continue;
      }
      throw new Error(`extra product ${extra.product} is already discovered`);
    }
    products.set(extra.product, {
      ...extra,
      name: extra.name || extra.product,
      host: extra.host || config.defaultHost,
      shell: extra.shell || null,
      sources: ["catalog:extra"],
      routers: [],
    });
  }

  // Strictly optional Gatus config — validates refs when present, never ENOENT when absent.
  const gatusText = readOptionalFile(rootDir, config.gatusFile);
  const knownHealth = gatusText !== null ? parseGatusEndpoints(gatusText) : null;
  const unknownHealth = [];

  const services = [...products.values()].map(item => {
    const override = config.productOverrides[item.product] || {};
    const row = { ...item, ...override };
    row.health = (row.health || []).filter(ref => {
      if (!knownHealth || knownHealth.has(`${ref[0]}\u0000${ref[1]}`)) return true;
      if (tolerant) {
        warnings.push(`${item.product} references missing Gatus endpoint ${ref[0]} / ${ref[1]} (dropped)`);
        return false;
      }
      unknownHealth.push(`${item.product}: ${ref[0]} / ${ref[1]}`);
      return true;
    });
    return row;
  });

  if (unknownHealth.length) {
    throw new Error("config references missing Gatus endpoints:\n  " + unknownHealth.join("\n  "));
  }

  // Solve collision-free orbits via solveLayout() when hosts or a fleet file are available.
  let layoutResult = null;
  const shouldSolve = config.layout.solve !== false && (config.hosts.length > 0 || options.solveFleet);
  if (shouldSolve) {
    if (config.hosts.length > 0) {
      layoutResult = solveLayout(
        {
          hosts: config.hosts,
          services,
          shells: config.shells || [],
          rings: config.rings,
          belts: config.belts,
          reserved: config.reserved,
        },
        {
          target: config.layout.target ?? 20.0,
          gapK: config.layout.gapK,
        }
      );
    } else if (options.fleetPath && fs.existsSync(options.fleetPath)) {
      const base = loadFleetData(options.fleetPath, null);
      const nonStations = base.FLEET.filter(b => !b.station);
      layoutResult = solveLayout(
        {
          hosts: nonStations,
          services,
          shells: config.shells || base.SHELLS,
          rings: base.RINGS,
          belts: base.BELTS,
          reserved: base.RESERVED,
        },
        {
          target: config.layout.target ?? 20.0,
          gapK: config.layout.gapK,
        }
      );
    }
  }

  // Build optional FLEET_META sync payload for status adapter & plate headers.
  const meta = {};
  if (config.fleet.name) meta.name = config.fleet.name;
  if (config.fleet.title) meta.title = config.fleet.title;
  if (config.fleet.heading) meta.heading = config.fleet.heading;
  if (config.fleet.chart) meta.chart = config.fleet.chart;
  if (config.status.adapter) meta.statusAdapter = config.status.adapter;
  if (config.status.url !== undefined) meta.statusUrl = config.status.url;
  if (config.status.selfId !== undefined) meta.statusSelfId = config.status.selfId;
  if (config.status.intervalMs !== undefined) meta.statusIntervalMs = config.status.intervalMs;

  const syncPayload = {};
  if (Object.keys(meta).length) syncPayload.meta = meta;
  if (config.shells) syncPayload.shells = config.shells;
  if (config.hosts.length) {
    syncPayload.hosts = config.hosts.map(h => {
      const solved = layoutResult && layoutResult.bodies[h.id];
      if (!solved) return h;
      const copy = { ...h, a: solved.a };
      if (solved.e > 0) copy.e = solved.e;
      else delete copy.e;
      return copy;
    });
  }
  if (layoutResult) {
    syncPayload.orbits = layoutResult.bodies;
    syncPayload.heliopause = layoutResult.heliopause;
  }

  const body = services.map(row => {
    const fields = [`host: ${JSON.stringify(row.host)}`, `name: ${JSON.stringify(row.name)}`];
    if (row.shell) fields.push(`shell: ${JSON.stringify(row.shell)}`);
    if (row.state) fields.push(`state: ${JSON.stringify(row.state)}`);
    if (row.health.length) fields.push(`health: ${JSON.stringify(row.health)}`);
    fields.push(`sources: ${JSON.stringify(row.sources)}`);
    return `  { ${fields.join(", ")} },`;
  }).join("\n");

  const hasSyncMeta = Object.keys(syncPayload).length > 0;
  const code =
    `/* GENERATED by orrery sync (dev/sync.js). Do not edit by hand.\n` +
    `   ${services.length} logical products from ${sources.length} discovered sources` +
    (config.extraProducts.length ? ` plus ${config.extraProducts.length} explicit products` : "") +
    `. */\n` +
    `const SERVICES = [\n${body}\n];\n` +
    (hasSyncMeta ? `const ORRERY_SYNC = ${JSON.stringify(syncPayload, null, 2)};\n` : "");

  return { services, sources, layout: layoutResult, syncPayload, code, warnings };
}

/**
 * Bootstrap SYS hosts + trust rings from `tailscale status --json` output.
 */
function importTailscale(statusInput, options = {}) {
  const data = typeof statusInput === "string" ? JSON.parse(statusInput) : statusInput;
  if (!data || typeof data !== "object") throw new Error("invalid tailscale status JSON");

  const rawNodes = [];
  if (data.Self) rawNodes.push({ ...data.Self, _isSelf: true });
  if (data.Peer && typeof data.Peer === "object") {
    for (const peer of Object.values(data.Peer)) {
      if (!peer || typeof peer !== "object") continue;
      rawNodes.push(peer);
    }
  }

  const slugify = str => String(str || "node")
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "node";

  const hasSegment = (str, words) =>
    new RegExp(`(?:^|[-_.\\s:/])(?:${words.join("|")})\\d*(?:$|[-_.\\s:/])`).test(str);

  const classify = node => {
    const tags = (node.Tags || []).map(t => String(t).toLowerCase().replace(/^tag:/, ""));
    const name = String(node.HostName || "").toLowerCase();
    const nodeOs = String(node.OS || "").toLowerCase();
    const hasTag = words => tags.some(t => hasSegment(t, words));
    const hasName = words => hasSegment(name, words);

    if (hasTag(["edge", "vps", "dmz", "untrusted", "agent", "relay"]) || node.ExitNodeOption || hasName(["vps", "edge", "dmz"])) {
      return { ring: "edge", a: 16.5, e: 0.02, rad: 8.5, kind: "rock", surface: "cratered", tint: [0.42, 0.46, 0.58], tier: 1 };
    }
    if (hasTag(["gpu", "ai", "llm", "ml", "compute"]) || hasName(["gpu", "ollama", "llm", "ml", "ai", "compute"])) {
      return { ring: "compute", a: 1.2, e: 0.04, rad: 13, kind: "rock", surface: "cratered", tint: [0.74, 0.66, 0.58], tier: 1 };
    }
    if (hasTag(["nas", "storage", "backup"]) || hasName(["nas", "synology", "truenas", "storage"])) {
      return { ring: "storage", a: 5.2, e: 0.04, rad: 10, kind: "rock", surface: "regolith", tint: [0.64, 0.62, 0.58], tier: 1 };
    }
    if (hasTag(["iot", "home", "pi", "sensor"]) || hasName(["pi", "home", "ha", "zigbee", "sensor"])) {
      return { ring: "iot", a: 6.1, e: 0.03, rad: 5.0, kind: "craft", craft: "tender", surface: "regolith", tint: [0.55, 0.64, 0.72], tier: 2 };
    }
    if (hasTag(["server", "core", "docker", "proxmox", "hypervisor", "infra"]) || nodeOs === "linux") {
      return { ring: "core", a: 8.5, e: 0.02, rad: 15, kind: "ice", surface: "icy", tint: [0.78, 0.84, 0.90], tier: 1 };
    }
    return { ring: "workstation", a: 3.1, e: 0.015, rad: 11, kind: "rock", surface: "terran", atmo: 0.75, tint: [0.44, 0.62, 0.80], tier: 1 };
  };

  const usedIds = new Set(["sol"]);
  const hosts = [
    {
      id: "sol",
      name: options.coreName || "the core",
      desig: options.tailnetLabel ||
        (options.useTailnetName && data.CurrentTailnet && data.CurrentTailnet.Name) ||
        "tailnet",
      kind: "star",
      a: 0,
      rad: 38,
      tint: [1.0, 0.84, 0.6],
      state: "ok",
      tier: 0,
      role: "tailnet · centre of the system",
      desc: "Bootstrapped from Tailscale status. Orbital radius reflects trust ring.",
      spec: [["network", "Tailscale mesh"]],
    },
  ];

  // Spread nodes within each ring slightly so sorting is deterministic before solveLayout.
  const ringCounts = {};
  for (const node of rawNodes) {
    const tags = (node.Tags || []).map(t => String(t).toLowerCase());
    const dnsName = String(node.DNSName || "").toLowerCase();
    const isMullvad =
      tags.some(t => t.includes("mullvad")) ||
      /\.mullvad\.ts\.net\.?$/.test(dnsName) ||
      Boolean(node.Location && typeof node.Location === "object" && !Array.isArray(node.Location));
    if (!options.includeAll && isMullvad) continue;
    const dnsShort = String(node.DNSName || "").split(".")[0];
    const baseName = node.HostName || dnsShort || "node";
    let id = slugify(baseName);
    let suffix = 2;
    while (usedIds.has(id)) id = `${slugify(baseName)}-${suffix++}`;
    usedIds.add(id);

    const cls = classify(node);
    const idx = ringCounts[cls.ring] = (ringCounts[cls.ring] || 0) + 1;
    const online = node.Online !== false;
    const spec = [
      ["os", node.OS || "unknown"],
      ["trust ring", cls.ring],
    ];
    if (tags.length) spec.push(["tags", tags.map(t => t.replace(/^tag:/, "")).join(" · ")]);
    if (options.includeIps && Array.isArray(node.TailscaleIPs) && node.TailscaleIPs[0]) {
      spec.push(["tailnet", node.TailscaleIPs[0]]);
    }

    const host = {
      id,
      name: baseName,
      desig: `${node.OS || "host"} · ${cls.ring}`,
      kind: cls.kind,
      surface: cls.surface,
      a: +(cls.a + (idx - 1) * 0.65).toFixed(3),
      e: cls.e,
      rad: cls.rad,
      tint: cls.tint,
      state: online ? "ok" : "down",
      tier: cls.tier,
      role: tags.length ? tags.map(t => t.replace(/^tag:/, "")).join(" · ") : `${cls.ring} node`,
      desc: `Imported from Tailscale (${cls.ring} trust ring).`,
      spec,
    };
    if (cls.craft) host.craft = cls.craft;
    if (cls.atmo) host.atmo = cls.atmo;
    hosts.push(host);
  }

  const solved = solveLayout({ hosts, services: [] }, { target: options.target ?? 20.0 });
  const solvedHosts = hosts.map(h => {
    const orb = solved.bodies[h.id];
    if (!orb) return h;
    const copy = { ...h, a: orb.a };
    if (orb.e > 0) copy.e = orb.e;
    else delete copy.e;
    return copy;
  });

  return {
    hosts: solvedHosts,
    heliopause: solved.heliopause,
    outer: solved.outer,
    nodeCount: solvedHosts.length - 1,
  };
}

function readTailscaleFromCli() {
  const out = execFileSync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function writeAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, filePath);
}

function findReplacedInput(configPath, rootDir) {
  let config = {};
  try {
    config = normalizeConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch {
    config = {};
  }
  const composePaths = (config.composeFiles || []).map(entry =>
    typeof entry === "string" ? entry : entry.path
  );
  const inputs = [
    __filename,
    configPath,
    config.composeInclude,
    ...composePaths,
    config.dynamicTraefikFile,
    config.gatusFile,
  ]
    .filter(Boolean)
    .map(file => (path.isAbsolute(file) ? file : path.join(rootDir, file)));

  for (const file of inputs) {
    try {
      if (fs.statSync(file).nlink === 0) return file;
    } catch {
      // Missing files are surfaced as warnings by generateRoster().
    }
  }
  return null;
}

function syncOnce(options) {
  const configPath = path.resolve(options.config);
  const rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const rootDir = path.resolve(options.root || path.dirname(configPath));
  const outputPath = path.resolve(options.output);

  const result = generateRoster(rawConfig, {
    root: rootDir,
    fleetPath: options.fleetPath,
    solveFleet: Boolean(options.solveFleet),
    tolerant: options.tolerant,
  });

  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (options.check) {
    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    if (current !== result.code) {
      console.error(`${path.relative(process.cwd(), outputPath)} is stale; run: orrery sync`);
      return { ok: false, stale: true, count: result.services.length, warnings: result.warnings };
    }
    if (result.warnings.length) {
      return { ok: false, stale: false, count: result.services.length, warnings: result.warnings };
    }
    console.log(`Orrery roster is current (${result.services.length} products)`);
    return { ok: true, stale: false, count: result.services.length, warnings: result.warnings };
  }

  const changed = current !== result.code;
  if (changed) {
    writeAtomic(outputPath, result.code);
    console.log(`Orrery roster synced: ${result.services.length} products → ${path.relative(process.cwd(), outputPath)}`);
  }
  if (options.statusPath) {
    const payload = {
      ok: true,
      products: result.services.length,
      warnings: result.warnings,
      checkedAt: new Date().toISOString(),
    };
    writeAtomic(path.resolve(options.statusPath), JSON.stringify(payload) + "\n");
  }
  return { ok: true, changed, count: result.services.length, warnings: result.warnings, result };
}

function touchHeartbeat(heartbeatPath) {
  if (!heartbeatPath) return;
  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  fs.writeFileSync(heartbeatPath, `${Date.now()}\n`);
}

function cli(argv = process.argv.slice(2)) {
  const arg = name => {
    const i = argv.indexOf(name);
    return i < 0 ? null : argv[i + 1];
  };
  const watch = argv.includes("--watch");
  const check = argv.includes("--check");
  const tolerantFlag = argv.includes("--tolerant");
  const solveFleet = argv.includes("--solve-layout");
  const intervalSec = Math.max(5, Number(arg("--interval") || 30));

  const projectRoot = path.resolve(__dirname, "..");
  const defaultCfg = fs.existsSync(path.join(projectRoot, "orrery.config.json"))
    ? path.join(projectRoot, "orrery.config.json")
    : path.join(projectRoot, "catalog.json");

  const configPath = path.resolve(arg("--config") || arg("--catalog") || defaultCfg);
  const rootDir = path.resolve(arg("--root") || path.dirname(configPath));
  const outputPath = path.resolve(arg("--output") || path.join(projectRoot, "src", "services.generated.js"));
  const fleetPath = arg("--fleet") ? path.resolve(arg("--fleet")) : path.join(projectRoot, "src", "fleet.js");
  const explicitStatus = arg("--status") || null;
  const statusPath = explicitStatus
    ? path.resolve(explicitStatus)
    : (watch ? path.join(path.dirname(outputPath), "sync-status.json") : null);
  const explicitHeartbeat = arg("--heartbeat") || process.env.ORRERY_HEARTBEAT || null;
  const heartbeatPath = explicitHeartbeat
    ? path.resolve(explicitHeartbeat)
    : (watch ? path.join(os.tmpdir(), ".orrery-sync-heartbeat") : null);

  if (!watch) {
    const res = syncOnce({
      config: configPath,
      root: rootDir,
      output: outputPath,
      fleetPath,
      statusPath,
      check,
      solveFleet,
      tolerant: tolerantFlag ? true : undefined,
    });
    if (check && !res.ok) process.exit(1);
    if (!check) {
      for (const warning of res.warnings || []) console.error(`warning: ${warning}`);
      if (heartbeatPath) touchHeartbeat(heartbeatPath);
    }
    return;
  }

  let lastLogged = null;
  const logOnce = message => {
    if (message === lastLogged) return;
    lastLogged = message;
    if (message) console.error(message);
  };

  const cycle = () => {
    const replaced = findReplacedInput(configPath, rootDir);
    if (replaced) {
      console.log(`${replaced} was replaced on the host; exiting cleanly so the container remounts current files`);
      process.exit(0);
    }
    try {
      const res = syncOnce({
        config: configPath,
        root: rootDir,
        output: outputPath,
        fleetPath,
        statusPath,
        check: false,
        solveFleet,
        tolerant: true,
      });
      logOnce(res.warnings.length ? `roster warnings:\n  ${res.warnings.join("\n  ")}` : null);
      if (heartbeatPath) touchHeartbeat(heartbeatPath);
    } catch (err) {
      // Keep serving the last good roster; sync-status.json records the error.
      const errorMessage = err && err.message ? err.message : String(err);
      if (statusPath) {
        writeAtomic(
          statusPath,
          JSON.stringify({ ok: false, error: errorMessage, warnings: [], checkedAt: new Date().toISOString() }) + "\n"
        );
      }
      logOnce(err && err.stack ? err.stack : errorMessage);
    }
  };

  cycle();
  setInterval(cycle, intervalSec * 1000);
}

if (require.main === module) cli();

module.exports = {
  parseComposeServices,
  parseComposeIncludes,
  parseDynamicRouters,
  parseGatusEndpoints,
  normalizeConfig,
  generateRoster,
  importTailscale,
  readTailscaleFromCli,
  findReplacedInput,
  syncOnce,
  touchHeartbeat,
  cli,
};
