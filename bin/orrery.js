#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   bin/orrery.js — Orrery CLI

   Usage:
     orrery sync [options]              Sync services & orbits from orrery.config.json
     orrery import --tailscale [opts]   Bootstrap hosts + trust rings from Tailscale JSON
     orrery layout [--write]            Solve collision-free orbits for src/fleet.js
     orrery bundle [--check]            Build or verify standalone orrery.html
     orrery check                       Run GLSL, clearance, smoke, and bundle checks
     orrery --help | --version
   ───────────────────────────────────────────────────────────────────────── */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const pkg = require(path.join(ROOT, "package.json"));
const syncMod = require(path.join(ROOT, "dev", "sync.js"));
const layoutMod = require(path.join(ROOT, "dev", "layout.js"));

const HELP = `Orrery v${pkg.version} — live orbital star chart for your homelab fleet

Usage:
  orrery sync [options]              Discover services from Compose/Traefik and emit roster
    --config <file>                  Path to orrery.config.json (also accepts --catalog)
    --root <dir>                     Base directory for relative config paths
    --output <file>                  Output JS file (default: src/services.generated.js)
    --fleet <file>                   Optional fleet.js used when solving layout
    --solve-layout                   Force orbit solve against --fleet even without config.hosts
    --check                          Exit non-zero if output would change
    --tolerant                       Skip invalid routes/files with warnings instead of aborting (default in --watch)
    --watch                          Re-sync continuously (for networkless sidecar; never crash-loops on bad config)
    --interval <sec>                 Watch interval in seconds (default: 30)
    --status <file>                  Write sync-status.json (default in --watch: beside --output)
    --heartbeat <file>               Heartbeat file touched on sync ticks (default in --watch: /tmp/.orrery-sync-heartbeat)

  orrery import --tailscale [opts]   Bootstrap hosts & trust rings from Tailscale status JSON
    --file <json>                    Read JSON from file instead of running \`tailscale status --json\`
    --config <file>                  Target orrery.config.json when using --write
    --write                          Merge imported hosts into --config
    --out <file>                     Write imported hosts to a JSON or JS file
    --format <json|js>               Output format (default: json)
    --include-ips                    Include tailnet IP addresses in host spec rows
    --use-tailnet-name               Use CurrentTailnet.Name as the central body label (default: "tailnet")
    --target <au>                    Target heliopause radius in AU (default: 20.0)

  orrery layout [options]            Solve collision-free orbits for a fleet file
    --fleet <file>                   Path to fleet.js (default: src/fleet.js)
    --services <file>                Path to services.generated.js
    --target <au>                    Target outer radius in AU (default: 20.0)
    --write                          Patch src/fleet.js in place

  orrery bundle [--check]            Regenerate or verify standalone orrery.html
  orrery check                       Run shader, clearance, smoke, and bundle checks
  orrery --version                   Print version
  orrery --help                      Show this help
`;

function flagVal(argv, name) {
  const i = argv.indexOf(name);
  return i < 0 ? null : argv[i + 1];
}

function runImport(argv) {
  if (!argv.includes("--tailscale")) {
    console.error("Usage: orrery import --tailscale [--file status.json] [--write] [--config orrery.config.json]");
    process.exit(1);
  }
  const filePath = flagVal(argv, "--file");
  const raw = filePath
    ? JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"))
    : syncMod.readTailscaleFromCli();

  const target = Number(flagVal(argv, "--target") ?? 20.0);
  const includeIps = argv.includes("--include-ips");
  const useTailnetName = argv.includes("--use-tailnet-name");
  const imported = syncMod.importTailscale(raw, { target, includeIps, useTailnetName });

  if (argv.includes("--write")) {
    const cfgPath = path.resolve(flagVal(argv, "--config") || "orrery.config.json");
    const cfg = fs.existsSync(cfgPath)
      ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
      : { version: 2, discovery: { mode: "routed", composeFiles: [] } };
    cfg.hosts = imported.hosts;
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`Imported ${imported.nodeCount} Tailscale nodes into ${path.relative(process.cwd(), cfgPath)} (heliopause ${imported.heliopause} AU)`);
    return;
  }

  const outPath = flagVal(argv, "--out");
  const format = flagVal(argv, "--format") || (outPath && outPath.endsWith(".js") ? "js" : "json");
  const serialized = format === "js"
    ? `/* Bootstrapped by orrery import --tailscale */\nconst SYS = ${JSON.stringify(imported.hosts, null, 2)};\nconst HELIOPAUSE = ${imported.heliopause};\n`
    : JSON.stringify(imported, null, 2) + "\n";

  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), serialized);
    console.log(`Wrote ${imported.nodeCount} Tailscale nodes to ${outPath} (heliopause ${imported.heliopause} AU)`);
  } else {
    process.stdout.write(serialized);
  }
}

function runScript(rel, extraArgs = []) {
  execFileSync(process.execPath, [path.join(ROOT, rel), ...extraArgs], {
    stdio: "inherit",
    cwd: ROOT,
  });
}

function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === "-v" || cmd === "--version" || cmd === "version") {
    console.log(pkg.version);
    return;
  }
  if (cmd === "sync") {
    syncMod.cli(rest);
    return;
  }
  if (cmd === "import") {
    runImport(rest);
    return;
  }
  if (cmd === "layout") {
    layoutMod.cli(rest);
    return;
  }
  if (cmd === "bundle") {
    runScript("dev/bundle.js", rest);
    return;
  }
  if (cmd === "check") {
    runScript("dev/glsl.js");
    runScript("dev/clearance.js");
    runScript("dev/smoke.js");
    runScript("dev/bundle.js", ["--check"]);
    return;
  }
  console.error(`Unknown command: ${cmd}\nRun \`orrery --help\` for usage.`);
  process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
