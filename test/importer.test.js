"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  parseComposeServices,
  parseComposeIncludes,
  parseDynamicRouters,
  parseGatusEndpoints,
  normalizeConfig,
  generateRoster,
  importTailscale,
  findReplacedInput,
  syncOnce,
} = require("../dev/sync.js");
const { solveLayout } = require("../dev/layout.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "orrery.js");

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orrery-test-"));
}

describe("Compose-only discovery (routed & all modes)", () => {
  it("discovers Traefik, Caddy, Homepage, and Orrery labels in routed mode without Traefik-only fragility", () => {
    const compose = `
services:
  jellyfin:
    image: jellyfin/jellyfin
    labels:
      caddy: watch.homelab.local
      caddy.reverse_proxy: "{{upstreams 8096}}"

  immich-server:
    image: ghcr.io/immich-app/immich-server
    labels:
      - "homepage.name=Immich"
      - "homepage.href=https://photos.homelab.local"
      - "orrery.product=immich"

  immich-postgres:
    image: postgres:16

  grafana:
    image: grafana/grafana
    labels:
      - "traefik.http.routers.grafana.rule=Host(\`grafana.homelab.local\`)"

  disabled-proxy:
    image: nginx
    labels:
      - "traefik.enable=false"
      - "traefik.http.routers.disabled.rule=Host(\`nope.local\`)"

  internal-worker:
    image: alpine
    labels:
      - "orrery.enable=true"
      - "orrery.shell=ops"

  hidden-sidecar:
    image: busybox
    labels:
      - "orrery.enable=true"
      - "orrery.ignore=true"
`;
    const items = parseComposeServices(compose, { mode: "routed" });
    const names = items.map(x => x.service);
    assert.deepEqual(names, ["jellyfin", "immich-server", "grafana", "internal-worker"]);
  });

  it("discovers all non-ignored services in mode: all across multiple compose files and hosts", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "compose.media.yml"), `
services:
  jellyfin:
    image: jellyfin/jellyfin
  navidrome:
    image: deluan/navidrome
  watchtower-helper:
    image: containrrr/watchtower
    labels:
      - "orrery.ignore=true"
`);
    fs.writeFileSync(path.join(dir, "compose.home.yml"), `
services:
  home-assistant:
    image: ghcr.io/home-assistant/home-assistant
  mosquitto:
    image: eclipse-mosquitto
`);

    const cfg = {
      version: 2,
      discovery: {
        mode: "all",
        composeFiles: [
          { path: "compose.media.yml", host: "media-box", shell: "media" },
          { path: "compose.home.yml", host: "pi-home", shell: "home" },
        ],
      },
    };

    const res = generateRoster(cfg, { root: dir });
    assert.equal(res.services.length, 4);
    assert.deepEqual(
      res.services.map(s => [s.host, s.shell, s.name]),
      [
        ["media-box", "media", "jellyfin"],
        ["media-box", "media", "navidrome"],
        ["pi-home", "home", "home-assistant"],
        ["pi-home", "home", "mosquitto"],
      ]
    );
    assert.match(res.code, /const SERVICES = \[/);
  });

  it("never throws ENOENT when optional dynamicTraefikFile or gatusFile are absent", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "compose.yml"), `
services:
  vaultwarden:
    image: vaultwarden/server
    labels:
      - "caddy=vault.example.test"
`);
    const cfg = {
      version: 2,
      defaultHost: "alpha",
      discovery: {
        composeFiles: [{ path: "compose.yml", shell: "home" }],
        dynamicTraefikFile: "does-not-exist/traefik.yml",
        gatusFile: "does-not-exist/gatus.yaml",
      },
      productOverrides: {
        vaultwarden: { health: [["Core", "vaultwarden"]] },
      },
    };

    const res = generateRoster(cfg, { root: dir });
    assert.equal(res.services.length, 1);
    assert.equal(res.services[0].name, "vaultwarden");
    assert.equal(res.services[0].host, "alpha");
  });
});

describe("Compose + Traefik dynamic + Gatus validation", () => {
  it("merges multi-route products, applies excludes/overrides, and validates Gatus references", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "compose.apps.yml"), `
services:
  paperless-ngx:
    image: ghcr.io/paperless-ngx/paperless-ngx
    labels:
      - "traefik.http.routers.paperless.rule=Host(\`docs.lab.test\`)"
  paperless-db:
    image: postgres:16
`);
    fs.writeFileSync(path.join(dir, "traefik.yml"), `
http:
  routers:
    minio-web:
      rule: "Host(\`minio.lab.test\`)"
    minio-s3:
      rule: "Host(\`s3.lab.test\`)"
    router-ui:
      rule: "Host(\`fw.lab.test\`)"
`);
    fs.writeFileSync(path.join(dir, "gatus.yaml"), `
endpoints:
  - name: paperless
    group: Apps
  - name: minio
    group: Storage
`);

    const cfg = {
      version: 2,
      composeFiles: [{ path: "compose.apps.yml", host: "docker-vm", shell: "apps" }],
      dynamicTraefikFile: "traefik.yml",
      gatusFile: "gatus.yaml",
      excludeSources: ["dynamic:router-ui"],
      sourceOverrides: {
        "dynamic:minio-web": { product: "minio", name: "minio", host: "nas" },
        "dynamic:minio-s3": { product: "minio", name: "minio", host: "nas" },
      },
      productOverrides: {
        "paperless-ngx": { health: [["Apps", "paperless"]] },
        minio: { health: [["Storage", "minio"]] },
      },
      extraProducts: [
        { product: "loki", host: "docker-vm", shell: "monitoring" },
      ],
    };

    const res = generateRoster(cfg, { root: dir });
    assert.equal(res.services.length, 3);
    const minio = res.services.find(s => s.product === "minio");
    assert.equal(minio.host, "nas");
    assert.deepEqual(minio.sources, ["dynamic:minio-web", "dynamic:minio-s3"]);
    assert.deepEqual(minio.health, [["Storage", "minio"]]);

    // Missing Gatus endpoint must fail loudly when gatusFile is present.
    const badCfg = {
      ...cfg,
      productOverrides: {
        minio: { health: [["Storage", "nonexistent-check"]] },
      },
    };
    assert.throws(() => generateRoster(badCfg, { root: dir }), /missing Gatus endpoints/);
  });

  it("parses Traefik dynamic routers and Gatus endpoints in either field order", () => {
    assert.deepEqual(
      parseDynamicRouters("http:\n  routers:\n    alpha:\n      rule: x\n    beta:\n      rule: y\n  services:\n    alpha:\n"),
      ["alpha", "beta"]
    );
    const eps = parseGatusEndpoints("endpoints:\n  - group: G1\n    name: E1\n  - name: 'E2'\n    group: \"G2\"\n");
    assert.equal(eps.has("G1\u0000E1"), true);
    assert.equal(eps.has("G2\u0000E2"), true);
  });

  it("follows root docker-compose include: entries and warns on unlisted files", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "docker-compose.yml"), `
include:
  - ./compose.apps.yml
  - path: "compose.extra.yml"
`);
    fs.writeFileSync(path.join(dir, "compose.apps.yml"), `
services:
  immich:
    image: immich
    labels:
      traefik.http.routers.immich.rule: Host(\`photos.lab.test\`)
`);
    fs.writeFileSync(path.join(dir, "compose.extra.yml"), `
services:
  vault:
    image: vaultwarden
    labels:
      - "traefik.http.routers.vault.rule=Host(\`vault.lab.test\`)"
`);

    assert.deepEqual(
      parseComposeIncludes(fs.readFileSync(path.join(dir, "docker-compose.yml"), "utf8")),
      ["compose.apps.yml", "compose.extra.yml"]
    );

    const cfg = {
      version: 2,
      defaultHost: "alpha",
      discovery: {
        composeInclude: "docker-compose.yml",
        defaultComposeShell: "misc",
        composeFiles: [
          { path: "compose.apps.yml", shell: "apps" },
          { path: "compose.unused.yml", shell: "ops" },
        ],
      },
    };
    const res = generateRoster(cfg, { root: dir });
    assert.deepEqual(
      res.services.map(s => [s.name, s.shell]),
      [["immich", "apps"], ["vault", "misc"]]
    );
    assert.equal(res.warnings.length, 2);
    assert.match(res.warnings[0], /compose\.extra\.yml has no entry/);
    assert.match(res.warnings[1], /compose\.unused\.yml/);
  });

  it("skips individual bad items with warnings in tolerant mode and writes sync-status.json", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "compose.apps.yml"), `
services:
  grafana:
    image: grafana/grafana
    labels:
      - "traefik.http.routers.grafana.rule=Host(\`grafana.lab.test\`)"
`);
    fs.writeFileSync(path.join(dir, "traefik.yml"), `
http:
  routers:
    unmapped-route:
      rule: "Host(\`mystery.lab.test\`)"
    conflict-route:
      rule: "Host(\`grafana-alt.lab.test\`)"
`);
    fs.writeFileSync(path.join(dir, "gatus.yaml"), `
endpoints:
  - group: Ops
    name: grafana
`);
    const cfgPath = path.join(dir, "orrery.config.json");
    const outPath = path.join(dir, "services.generated.js");
    const statusPath = path.join(dir, "sync-status.json");
    const cfg = {
      version: 2,
      defaultHost: "alpha",
      composeFiles: [
        { path: "compose.apps.yml", shell: "ops" },
        { path: "compose.missing.yml", shell: "apps" },
      ],
      dynamicTraefikFile: "traefik.yml",
      gatusFile: "gatus.yaml",
      sourceOverrides: {
        "dynamic:conflict-route": { product: "grafana", host: "beta", shell: "apps" },
      },
      extraProducts: [
        { product: "grafana", host: "alpha", shell: "ops" },
      ],
      productOverrides: {
        grafana: { health: [["Ops", "grafana"], ["Ops", "missing-probe"]] },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const res = syncOnce({
      config: cfgPath,
      root: dir,
      output: outPath,
      statusPath,
      tolerant: true,
    });
    assert.equal(res.ok, true);
    assert.equal(res.count, 1);
    assert.equal(res.warnings.length, 5);
    assert.deepEqual(res.result.services[0].health, [["Ops", "grafana"]]);

    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.equal(status.ok, true);
    assert.equal(status.products, 1);
    assert.equal(status.warnings.length, 5);
    assert.ok(status.checkedAt);

    // Existing inputs are not flagged as replaced (nlink > 0).
    assert.equal(findReplacedInput(cfgPath, dir), null);

    // --check fails when warnings exist even if output matches.
    const checkRes = syncOnce({
      config: cfgPath,
      root: dir,
      output: outPath,
      check: true,
      tolerant: true,
    });
    assert.equal(checkRes.ok, false);
    assert.equal(checkRes.warnings.length, 5);
  });
});

describe("Tailscale importer & automatic solveLayout() integration", () => {
  const tsFixture = {
    CurrentTailnet: { Name: "atlas.ts.net" },
    Self: {
      HostName: "workstation",
      DNSName: "workstation.atlas.ts.net.",
      OS: "macOS",
      Online: true,
      TailscaleIPs: ["100.64.0.10"],
      Tags: ["tag:workstation"],
    },
    Peer: {
      p1: {
        HostName: "gpu-rig",
        DNSName: "gpu-rig.atlas.ts.net.",
        OS: "linux",
        Online: true,
        TailscaleIPs: ["100.64.0.11"],
        Tags: ["tag:gpu"],
      },
      p2: {
        HostName: "docker-core",
        DNSName: "docker-core.atlas.ts.net.",
        OS: "linux",
        Online: true,
        TailscaleIPs: ["100.64.0.12"],
        Tags: ["tag:server"],
      },
      p3: {
        HostName: "truenas-box",
        DNSName: "truenas-box.atlas.ts.net.",
        OS: "linux",
        Online: true,
        TailscaleIPs: ["100.64.0.13"],
        Tags: ["tag:nas"],
      },
      p4: {
        HostName: "pi-zigbee",
        DNSName: "pi-zigbee.atlas.ts.net.",
        OS: "linux",
        Online: false,
        TailscaleIPs: ["100.64.0.14"],
        Tags: ["tag:iot"],
      },
      p5: {
        HostName: "vps-edge",
        DNSName: "vps-edge.atlas.ts.net.",
        OS: "linux",
        Online: true,
        ExitNodeOption: true,
        TailscaleIPs: ["100.64.0.15"],
        Tags: ["tag:edge"],
      },
      mullvad: {
        HostName: "us-nyc-wg-001",
        DNSName: "us-nyc-wg-001.mullvad.ts.net.",
        OS: "linux",
        Online: true,
        Tags: ["tag:mullvad"],
      },
    },
  };

  it("bootstraps hosts with trust rings, offline state, and solved collision-free orbits", () => {
    const res = importTailscale(tsFixture);
    assert.equal(res.nodeCount, 6); // Self + 5 peers (mullvad skipped)
    assert.ok(res.heliopause > 0);

    const byId = Object.fromEntries(res.hosts.map(h => [h.id, h]));
    assert.equal(byId.sol.kind, "star");
    assert.equal(byId.sol.desig, "tailnet");
    assert.equal(byId["pi-zigbee"].state, "down");
    assert.equal(byId["gpu-rig"].state, "ok");

    // Trust ordering: GPU compute inside storage inside edge VPS
    assert.ok(byId["gpu-rig"].a < byId["truenas-box"].a);
    assert.ok(byId["truenas-box"].a < byId["vps-edge"].a);

    // Raw Tailscale IPs and private tailnet name are omitted by default
    const serialized = JSON.stringify(res.hosts);
    assert.equal(serialized.includes("100.64.0."), false);
    assert.equal(serialized.includes("atlas.ts.net"), false);
  });

  it("only exposes CurrentTailnet.Name when useTailnetName is opted in", () => {
    const emailTailnet = {
      ...tsFixture,
      CurrentTailnet: { Name: "person@example.com" },
    };
    const defRes = importTailscale(emailTailnet);
    assert.equal(defRes.hosts[0].desig, "tailnet");

    const optInRes = importTailscale(emailTailnet, { useTailnetName: true });
    assert.equal(optInRes.hosts[0].desig, "person@example.com");
  });

  it("filters Mullvad exit nodes by tag, .mullvad.ts.net. DNSName, or Location object", () => {
    const withMullvadVariants = {
      Self: { HostName: "laptop", OS: "macOS", Online: true },
      Peer: {
        realServer: { HostName: "app-srv", DNSName: "app-srv.home.ts.net.", OS: "linux", Online: true },
        mullvadByTag: { HostName: "exit-tag", DNSName: "exit-tag.home.ts.net.", OS: "linux", Online: true, Tags: ["tag:mullvad"] },
        mullvadByDns: { HostName: "se-sto-wg-101", DNSName: "se-sto-wg-101.mullvad.ts.net.", OS: "linux", Online: true },
        mullvadByLoc: {
          HostName: "us-sea-exit",
          DNSName: "us-sea-exit.exit.ts.net.",
          OS: "linux",
          Online: true,
          Location: { Country: "United States", City: "Seattle" },
        },
      },
    };

    const filtered = importTailscale(withMullvadVariants);
    const ids = filtered.hosts.map(h => h.id);
    assert.deepEqual(ids, ["sol", "laptop", "app-srv"]);

    const all = importTailscale(withMullvadVariants, { includeAll: true });
    assert.equal(all.nodeCount, 5);
  });

  it("uses word-boundary classifiers without false substring matches or personal hostnames", () => {
    const edgeCases = {
      Self: { HostName: "workstation", OS: "macOS", Online: true },
      Peer: {
        mail: { HostName: "mail", OS: "linux", Online: true },
        html: { HostName: "html-docs", OS: "linux", Online: true },
        api: { HostName: "api-gateway", OS: "linux", Online: true, Tags: ["tag:api"] },
        shadow: { HostName: "shadow", OS: "linux", Online: true },
        mercury: { HostName: "mercury", OS: "linux", Online: true },
        ceres: { HostName: "ceres", OS: "linux", Online: true },
        aiBox: { HostName: "ai-box", OS: "linux", Online: true },
        mlWorker: { HostName: "ml-worker", OS: "linux", Online: true },
        llm1: { HostName: "llm1", OS: "linux", Online: true },
        pi4: { HostName: "pi4", OS: "linux", Online: true },
        haGreen: { HostName: "ha-green", OS: "linux", Online: true },
      },
    };
    const res = importTailscale(edgeCases);
    const ringOf = id => res.hosts.find(h => h.id === id).spec.find(([k]) => k === "trust ring")[1];

    // No substring false positives and no hardcoded personal hostnames
    assert.equal(ringOf("mail"), "core");
    assert.equal(ringOf("html-docs"), "core");
    assert.equal(ringOf("api-gateway"), "core");
    assert.equal(ringOf("shadow"), "core");
    assert.equal(ringOf("mercury"), "core");
    assert.equal(ringOf("ceres"), "core");

    // Legitimate segment matches still classify accurately
    assert.equal(ringOf("ai-box"), "compute");
    assert.equal(ringOf("ml-worker"), "compute");
    assert.equal(ringOf("llm1"), "compute");
    assert.equal(ringOf("pi4"), "iot");
    assert.equal(ringOf("ha-green"), "iot");

    // v1 config defaultHost fallback uses generic "homelab"
    assert.equal(normalizeConfig({ version: 1 }).defaultHost, "homelab");
  });

  it("wires solveLayout() directly into generateRoster() with zero hardcoded planet IDs", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "compose.yml"), `
services:
  grafana:
    image: grafana/grafana
  forgejo:
    image: codeberg.org/forgejo/forgejo
  jellyfin:
    image: jellyfin/jellyfin
`);

    const imported = importTailscale(tsFixture);
    const cfg = {
      version: 2,
      fleet: {
        name: "atlas.lab",
        status: { adapter: "static" },
      },
      hosts: imported.hosts,
      shells: ["ops", "apps"],
      discovery: {
        mode: "all",
        composeFiles: [{ path: "compose.yml", host: "docker-core", shell: "apps" }],
      },
    };

    const res = generateRoster(cfg, { root: dir });
    assert.ok(res.layout);
    assert.ok(res.syncPayload.heliopause > 0);
    assert.ok(res.syncPayload.orbits["docker-core"].a > 0);
    assert.equal(res.syncPayload.meta.statusAdapter, "static");

    // Verify generated output evaluates cleanly alongside src/fleet.js!
    const fleetSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "fleet.js"), "utf8");
    const evalOut = new Function(res.code + "\n" + fleetSrc + "\nreturn { FLEET, FLEET_META, HELIOPAUSE };")();
    assert.equal(evalOut.FLEET_META.name, "atlas.lab");
    assert.equal(evalOut.FLEET_META.statusAdapter, "static");
    assert.equal(evalOut.HELIOPAUSE, res.syncPayload.heliopause);
    assert.equal(evalOut.FLEET.filter(b => b.station).length, 3);
  });

  it("solveLayout works on arbitrary custom body IDs with no sol/jupiter/RESERVED assumptions", () => {
    const custom = {
      hosts: [
        { id: "hub", name: "Hub", kind: "star", a: 0, rad: 30 },
        { id: "node-a", name: "Node A", kind: "rock", a: 1.0, e: 0.05, rad: 12 },
        { id: "node-b", name: "Node B", kind: "gas", a: 1.1, e: 0.05, rad: 18 },
      ],
      services: [
        { host: "node-b", name: "app-1", shell: "apps" },
        { host: "node-b", name: "app-2", shell: "ops" },
      ],
      shells: ["ops", "apps"],
    };
    const solved = solveLayout(custom, { target: 15 });
    assert.ok(solved.bodies["node-b"].a > solved.bodies["node-a"].a + 0.5);
    assert.ok(solved.heliopause > solved.outer);
  });

  it("CLI `orrery import --tailscale` + `orrery sync` + `--check` + `--heartbeat` run end-to-end", () => {
    const dir = makeTmpDir();
    const tsFile = path.join(dir, "tailscale.json");
    const cfgFile = path.join(dir, "orrery.config.json");
    const outFile = path.join(dir, "services.generated.js");
    const hbFile = path.join(dir, "sync.heartbeat");
    fs.writeFileSync(tsFile, JSON.stringify(tsFixture));
    fs.writeFileSync(path.join(dir, "compose.yml"), "services:\n  immich:\n    image: immich\n");

    execFileSync(process.execPath, [BIN, "import", "--tailscale", "--file", tsFile, "--config", cfgFile, "--write"], {
      cwd: dir,
      stdio: "pipe",
    });

    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    assert.equal(cfg.hosts[0].desig, "tailnet");

    // Opt-in flag exposes CurrentTailnet.Name
    const optInOut = path.join(dir, "optin.json");
    execFileSync(process.execPath, [BIN, "import", "--tailscale", "--file", tsFile, "--use-tailnet-name", "--out", optInOut], {
      cwd: dir,
      stdio: "pipe",
    });
    const optIn = JSON.parse(fs.readFileSync(optInOut, "utf8"));
    assert.equal(optIn.hosts[0].desig, "atlas.ts.net");

    cfg.discovery = { mode: "all", composeFiles: [{ path: "compose.yml", host: "docker-core", shell: "apps" }] };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

    execFileSync(process.execPath, [BIN, "sync", "--config", cfgFile, "--root", dir, "--output", outFile, "--heartbeat", hbFile], {
      cwd: dir,
      stdio: "pipe",
    });
    assert.equal(fs.existsSync(outFile), true);
    assert.equal(fs.existsSync(hbFile), true);
    assert.ok(Number(fs.readFileSync(hbFile, "utf8").trim()) > 0);

    // --check passes immediately after sync
    execFileSync(process.execPath, [BIN, "sync", "--config", cfgFile, "--root", dir, "--output", outFile, "--check"], {
      cwd: dir,
      stdio: "pipe",
    });
  });
});

describe("Pluggable health/status adapters in renderer", () => {
  function runWithStatus(metaOverride, fetchPayload, opts = {}) {
    let fetched = 0;
    const noop = () => {};
    const grad = { addColorStop: noop };
    const ctx2d = () => ({
      canvas: { width: 100, height: 100 },
      fillRect: noop, clearRect: noop, drawImage: noop, stroke: noop, fill: noop,
      beginPath: noop, moveTo: noop, lineTo: noop, arc: noop, ellipse: noop, rect: noop,
      save: noop, restore: noop, setTransform: noop, translate: noop, rotate: noop,
      scale: noop, closePath: noop, setLineDash: noop, fillText: noop, strokeText: noop,
      quadraticCurveTo: noop, bezierCurveTo: noop, clip: noop, putImageData: noop,
      createRadialGradient: () => grad, createLinearGradient: () => grad,
      measureText: () => ({ width: 10 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    });
    const glStub = () => {
      const o = {};
      for (const k of ["shaderSource","compileShader","attachShader","linkProgram",
        "useProgram","bindBuffer","bufferData","enableVertexAttribArray","disableVertexAttribArray",
        "vertexAttribPointer","enable","disable","depthFunc","blendFunc","viewport","clear","clearColor",
        "uniform1f","uniform2f","uniform3fv","uniform2fv","uniform1i","uniform4f","deleteShader",
        "activeTexture","bindTexture","pixelStorei","texParameteri","texImage2D","drawArrays"]) o[k] = noop;
      o.createShader = o.createProgram = o.createBuffer = o.createTexture = () => ({});
      o.getShaderParameter = o.getProgramParameter = () => true;
      o.getParameter = () => 4096;
      o.getUniformLocation = () => ({}); o.getAttribLocation = () => 0;
      o.getShaderInfoLog = o.getProgramInfoLog = () => "";
      return o;
    };
    const makeEl = () => ({
      width: 0, height: 0, style: {}, dataset: {}, hidden: false, textContent: "", innerHTML: "", value: "0",
      clientWidth: 1200, clientHeight: 800,
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      getContext: k => k === "2d" ? ctx2d() : glStub(),
      addEventListener: noop, removeEventListener: noop, setAttribute: noop, getAttribute: () => null,
      querySelector: () => null, querySelectorAll: () => [], closest: () => null, focus: noop, blur: noop,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    });
    const els = {};
    const env = {
      window: {
        devicePixelRatio: 1, addEventListener: noop, removeEventListener: noop,
        matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 1,
        location: { hash: opts.hash || "", pathname: "/" }, history: { replaceState: noop },
        getComputedStyle: () => ({ getPropertyValue: () => "" }),
      },
      document: {
        title: "",
        getElementById: id => (els[id] ||= makeEl()),
        createElement: () => makeEl(),
        addEventListener: noop, removeEventListener: noop,
        documentElement: makeEl(), body: makeEl(),
      },
      fetch: async () => {
        fetched++;
        return { ok: true, status: 200, json: async () => fetchPayload };
      },
    };
    const servicesSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "services.generated.js"), "utf8");
    const fleetSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "fleet.js"), "utf8");
    const shadersSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "shaders.js"), "utf8");
    const orrerySrc = fs.readFileSync(path.join(REPO_ROOT, "src", "orrery.js"), "utf8");
    const mutateFleet = opts.fleetHook ? `(${opts.fleetHook.toString()})(FLEET);` : "";
    const runner = new Function(
      "window", "document", "fetch", "matchMedia", "requestAnimationFrame", "getComputedStyle",
      "location", "history", "addEventListener", "removeEventListener", "devicePixelRatio",
      `${servicesSrc}\n${fleetSrc}\n${mutateFleet}\nObject.assign(FLEET_META, ${JSON.stringify(metaOverride)});\n${shadersSrc}\n${orrerySrc}\nreturn { FLEET, FLEET_META, document };`
    );
    const out = runner(
      env.window, env.document, env.fetch, env.window.matchMedia, env.window.requestAnimationFrame,
      env.window.getComputedStyle, env.window.location, env.window.history, noop, noop, 1
    );
    return new Promise(resolve => setImmediate(() => resolve({ ...out, fetched, els })));
  }

  it("applies Gatus split-verdict degraded and down states plus statusSelfId", async () => {
    const res = await runWithStatus(
      { statusAdapter: "gatus", statusUrl: "/api/status", statusSelfId: "svc-europa-gatus" },
      [
        { group: "Apps", name: "nextcloud", results: [{ success: true, timestamp: "2026-01-01T00:00:00Z" }] },
        { group: "Apps", name: "nextcloud cron", results: [{ success: false, timestamp: "2026-01-01T00:00:00Z" }] },
        { group: "Apps", name: "karakeep", results: [{ success: true, timestamp: "2026-01-01T00:00:00Z" }] },
        { group: "Core", name: "traefik", results: [{ success: false, timestamp: "2026-01-01T00:00:00Z" }] },
      ]
    );
    const byId = Object.fromEntries(res.FLEET.map(b => [b.id, b]));
    assert.equal(res.fetched, 1);
    assert.equal(byId["svc-europa-nextcloud"].state, "degraded");
    assert.equal(byId["svc-europa-karakeep"].state, "ok");
    assert.equal(byId["svc-europa-traefik"].state, "down");
    assert.equal(byId["svc-europa-gatus"].state, "ok");
  });

  it("applies generic JSON /api/status payloads", async () => {
    const res = await runWithStatus(
      { statusAdapter: "generic", statusUrl: "/api/status", title: "Orrery — Custom" },
      { services: { grafana: "degraded", "svc-europa-karakeep": "ok", jellyfin: false } }
    );
    const byId = Object.fromEntries(res.FLEET.map(b => [b.id, b]));
    assert.equal(res.document.title, "Orrery — Custom");
    assert.equal(byId["svc-europa-grafana"].state, "degraded");
    assert.equal(byId["svc-europa-karakeep"].state, "ok");
    assert.equal(byId["svc-pallas-jellyfin"].state, "down");
  });

  it("skips polling completely in static/none status adapter mode", async () => {
    const res = await runWithStatus({ statusAdapter: "static" }, {});
    assert.equal(res.fetched, 0);
  });

  it("escapes custom b.state in the info readout panel and renders known states cleanly", async () => {
    const xssRes = await runWithStatus(
      { statusAdapter: "static" },
      {},
      {
        hash: "#svc-europa-karakeep",
        fleetHook: fleet => {
          const target = fleet.find(b => b.id === "svc-europa-karakeep");
          target.state = '<img src=x onerror="alert(1)">';
        },
      }
    );
    const html = xssRes.els.readout.innerHTML;
    assert.equal(html.includes("<img"), false);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);

    const okRes = await runWithStatus(
      { statusAdapter: "static" },
      {},
      { hash: "#svc-europa-traefik" }
    );
    assert.match(okRes.els.readout.innerHTML, /<dt>state<\/dt><dd>lit · healthy<\/dd>/);
    assert.equal(okRes.els.readout.innerHTML.includes("&amp;middot;"), false);

    const protoRes = await runWithStatus(
      { statusAdapter: "static" },
      {},
      {
        hash: "#svc-europa-karakeep",
        fleetHook: fleet => {
          fleet.find(b => b.id === "svc-europa-karakeep").state = "toString";
        },
      }
    );
    assert.match(protoRes.els.readout.innerHTML, /<dt>state<\/dt><dd>toString<\/dd>/);
  });
});
