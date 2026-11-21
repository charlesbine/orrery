/* ─────────────────────────────────────────────────────────────────────────
   fleet.js — THE CELESTIAL ROSTER (Demo Homelab: solaris.lab).

   Logical service stations are generated from Compose / Traefik / Caddy /
   Homepage configs into services.generated.js via `orrery sync`. Edit this
   file for hosts, topology, transfers, reserved names, and celestial metadata,
   or supply custom `hosts` in `orrery.config.json` (which `orrery sync`
   injects via `ORRERY_SYNC`).

   Layout is TOPOLOGY, not astronomy: orbital radius is trust distance.
   Bodies render as their real namesakes.

     kind   star | gas | ice | rock | dark | reserved | station | craft
     state  ok | degraded | down | fading | reserved   → expressed ONLY as light
     tier   1 named always · 2 named when near · 3 reserved · 4 stations
   ───────────────────────────────────────────────────────────────────────── */

const _SERVICES = typeof SERVICES !== "undefined" ? SERVICES : [];
const _SYNC = typeof ORRERY_SYNC !== "undefined" && ORRERY_SYNC ? ORRERY_SYNC : null;

const FLEET_META = Object.assign({
  name: "solaris.lab",
  heading: "Orrery",
  title: "Orrery — solaris.lab",
  chart: "solaris.lab fleet · orbital plane 24°",
  statusAdapter: "auto",
  statusUrl: "/api/status",
  statusSelfId: "svc-europa-gatus",
  statusIntervalMs: 30000,
}, (_SYNC && _SYNC.meta) || {});

/* ═══════════════════════════════════════════════════════════════════
   THE SYSTEM
   Layout is topology, not astronomy: orbital radius = trust distance.
   ═══════════════════════════════════════════════════════════════════ */

const SYS = (_SYNC && Array.isArray(_SYNC.hosts) && _SYNC.hosts.length)
  ? _SYNC.hosts.map(h => Object.assign({}, h))
  : [
  { id:"sol", name:"the core", desig:"10.10.0.0/24", kind:"star",
    a:0, rad:38, tint:[1.00,0.84,0.60], state:"ok", tier:0,
    role:"LAN · centre of the system",
    desc:"Everything inside the heliopause is reachable without crossing a trust boundary. Orbital distance encodes trust: inner compute and core infrastructure sit close to the sun, while edge nodes orbit at the perimeter.",
    spec:[["segment","10.10.0.0/24"],["gateway","OPNsense · .1"],["switch","10 GbE core"]] },

  { id:"mercury", name:"Mercury", desig:"GPU / AI compute", kind:"rock",
    a:1.05, e:0.04, rad:13, tint:[0.72,0.66,0.58], state:"ok", tier:1,
    role:"RTX 4090 · 64 GB RAM",
    desc:"Closest to the sun, hottest body, hottest box. Runs local inference, image generation, and speech-to-text on the fastest orbit in the system.",
    spec:[["runs","Ollama · Open WebUI"],["also","ComfyUI · Whisper"],["metrics","→ Europa Prometheus"],["orbit","innermost · fastest"]] },

  { id:"jupiter", name:"Jupiter", desig:"Proxmox hypervisor", kind:"gas",
    surface:"banded",
    a:9.3, e:0.02, rad:30, tint:[0.80,0.71,0.56], state:"ok", tier:1,
    role:"Xeon · 64 GB ECC · ZFS",
    desc:"The largest body in the system, carrying two active VMs as moons and two reserved Galilean slots. Real astronomy and real rack topology agree here.",
    spec:[["moons","Europa · Ganymede"],["reserved","Io · Callisto"],["ram","64 GB ECC"],["storage","NVMe mirror"]] },

  { id:"europa", name:"Europa", desig:"primary Docker host", kind:"ice",
    parent:"jupiter", a:1.106, e:0.01, rad:11, tint:[0.86,0.88,0.90],
    state:"ok", tier:1, role:"VM on Jupiter · 32 GB",
    desc:"An ice moon harbouring every containerized service. Logical products orbit as spacecraft stations grouped into concentric compose shells — databases and sidecars roll up into the product they serve.",
    spec:[["products",_SERVICES.filter(s => s.host === "europa").length + " stations"],["ram","32 GB"],["edge","Traefik :443"],["auth","Authentik SSO"]] },

  { id:"ganymede", name:"Ganymede", desig:"OPNsense firewall", kind:"rock",
    parent:"jupiter", a:1.699, e:0.02, rad:9.5, tint:[0.58,0.55,0.52],
    state:"ok", tier:1, role:"VM on Jupiter · 10.10.0.1",
    desc:"The only moon in the solar system with its own magnetosphere — a real magnetic field deflecting incoming particles. Every packet entering the lab crosses this perimeter firewall first.",
    spec:[["address","10.10.0.1"],["field","own magnetosphere"],["wan","fiber uplink"]] },

  { id:"io", name:"Io", desig:"reserved", kind:"reserved",
    parent:"jupiter", a:0.569, rad:6.5, tint:[0.51,0.55,0.97],
    state:"reserved", tier:3, role:"unallocated Jovian slot",
    desc:"Innermost Galilean — volcanic, hammered by Jupiter's radiation belt. Held for the next VM on the hypervisor.",
    spec:[["status","name reserved"],["fits","an edge-facing guest"]] },

  { id:"callisto", name:"Callisto", desig:"reserved", kind:"reserved",
    parent:"jupiter", a:1.965, rad:6.5, tint:[0.51,0.55,0.97],
    state:"reserved", tier:3, role:"unallocated Jovian slot",
    desc:"Most cratered object known, outermost Galilean, sitting beyond the main radiation belt. Held for the next VM on the hypervisor.",
    spec:[["status","name reserved"],["fits","an archival / backup guest"]] },

  { id:"ceres", name:"Ceres", desig:"TrueNAS Scale", kind:"rock",
    a:5.05, e:0.05, rad:9.5, tint:[0.63,0.61,0.57], state:"ok", tier:1,
    role:"bulk ZFS storage · Forgejo · Immich",
    desc:"Largest body in the main belt. Carries the ZFS storage pool, self-hosted Git forge, photo archive, S3 object storage, and encrypted Restic repositories.",
    spec:[["storage","64 TB RAIDZ2"],["link","10 GbE → Europa"],["runs","Forgejo · Immich · MinIO"]] },

  { id:"vesta", name:"Vesta", desig:"Raspberry Pi 5", kind:"craft", craft:"tender",
    a:4.5, e:0.04, rad:4.5, tint:[0.55,0.62,0.70], state:"ok", tier:2,
    role:"Home Assistant · Zigbee2MQTT",
    desc:"Named for the Roman goddess of the hearth and home. Runs local-only home automation with a dedicated Zigbee coordinator and MQTT broker.",
    spec:[["runs","Home Assistant"],["radio","Zigbee2MQTT · PoE"],["broker","Mosquitto"]] },

  { id:"pallas", name:"Pallas", desig:"Media mini-PC", kind:"craft", craft:"courier",
    a:5.6, e:0.04, rad:4.2, tint:[0.52,0.68,0.66], state:"ok", tier:2,
    role:"Jellyfin · Navidrome · Audiobookshelf",
    desc:"Low-power Intel QuickSync node dedicated to hardware transcoding and media streaming from the Ceres storage pool.",
    spec:[["transcode","Intel QuickSync"],["runs","Jellyfin · Navidrome"],["also","Audiobookshelf"]] },

  { id:"deimos", name:"Deimos", desig:"Pi-hole · retiring", kind:"craft", craft:"derelict",
    a:6.15, e:0.04, rad:3.8, tint:[0.44,0.42,0.46], state:"fading", tier:2,
    role:"legacy DNS → AdGuard Home on Europa",
    desc:"Dimming as DNS filtering migrates to AdGuard Home on Europa. Orrery keeps fading hosts in orbit until decommissioned — a dashboard would have deleted it on day one.",
    spec:[["successor","AdGuard Home @ Europa"],["status","decommissioning"]] },

  { id:"charon", name:"Charon", desig:"edge DMZ VPS", kind:"rock",
    parent:"pluto", a:0.249, e:0.02, rad:7, tint:[0.36,0.38,0.45], state:"ok", tier:1,
    role:"WireGuard ingress · skinny ACL",
    desc:"The ferryman at the system boundary. Sits on an untrusted public edge with a tightly scoped WireGuard tunnel terminating only at Europa's outer gateway ring.",
    spec:[["reaches","Europa gateway only"],["trust","untrusted edge"],["runs","Caddy edge proxy"]] },

  { id:"polaris", name:"Polaris", desig:"public VPS", kind:"star",
    fixed:[22.5,-7.4], rad:9, tint:[0.78,0.86,1.00], state:"ok", tier:1,
    role:"public status page · off-site relay",
    desc:"Outside the heliopause, where real astronomy takes over — a fixed beacon permanently beyond the private trust boundary, serving public status pages and receiving encrypted off-site backups.",
    spec:[["serves","public status page"],["distance","433 ly · real"],["trust","public internet"]] },
];

/* ── Ships: discrete, scheduled transfers. ───────────────────────────── */
const SHIPS = (_SYNC && Array.isArray(_SYNC.hosts) && _SYNC.hosts.length) ? [] : [
  { id:"edge-tunnel", from:"charon", to:"europa", period: 11, hue:"#818cf8", corridor:true,
    label:"wireguard ingress", cadence:"on demand",
    desc:"The only traffic Charon is permitted to originate. A WireGuard ACL allows a single lane to Europa's outer gateway ring.",
    spec:[["route","Charon → Gateway @ Europa"],["transport","WireGuard"],
          ["policy","strict ingress allowlist"]] },

  { id:"backup-sync", from:"europa", to:"ceres", period: 24, hue:"#cfe3f2",
    label:"restic snapshot", cadence:"nightly",
    desc:"Incremental encrypted snapshots of container volumes and PostgreSQL dumps pushed to Ceres's ZFS pool.",
    spec:[["route","Europa → Restic @ Ceres"],["transport","10 GbE LAN"],["retention","7d / 4w / 12m"]] },

  { id:"ci-deploy", from:"ceres", to:"europa", period: 36, hue:"#cfe3f2",
    label:"forgejo runner", cadence:"on push",
    desc:"Builds container images from Forgejo repositories and rolls out updated Compose stacks on Europa.",
    spec:[["route","Forgejo @ Ceres → Europa"],["trigger","main branch push"]] },

  { id:"metrics-push", from:"mercury", to:"europa", period: 18, hue:"#8fa6bd",
    label:"metrics export", cadence:"continuous",
    desc:"Mercury exports GPU thermals, VRAM utilization, and inference latency metrics to Prometheus on Europa.",
    spec:[["route","Mercury → Prometheus @ Europa"],["metrics","DCGM + node_exporter"]] },

  { id:"offsite-archive", from:"ceres", to:"polaris", period: 58, hue:"#ffd9a8",
    label:"off-site backup", cadence:"every 6h",
    desc:"Encrypted backup chunks replicated past the heliopause to off-site object storage so a local failure never means data loss.",
    spec:[["cadence","every 6 hours"],["encryption","client-side AES-256"],["target","beyond heliopause"]] },
];

/* ── Reserved names holding empty orbits. ────────────────────────────── */
const RESERVED = (_SYNC && Array.isArray(_SYNC.hosts) && _SYNC.hosts.length) ? [] : [
  ["Vega", 12.304, 0.016], ["Meridian", 15.748, 0.016], ["Corona", 16.932, 0.012],
  ["Zenith", 18.195, 0.012], ["Pulsar", 19.375, 0.012],
];

/* ── Concentric station shells, INNERMOST FIRST. ─────────────────────── */
const SHELLS = (_SYNC && Array.isArray(_SYNC.shells) && _SYNC.shells.length)
  ? _SYNC.shells.slice()
  : ["edge", "ops", "monitoring", "home", "apps", "ai", "gateway"];

/* Ring radii are DERIVED from the host, never hand-written. */
const ringRadius = (parent, i) => {
  const bodyAU = parent.rad / 100;
  const first = bodyAU * 1.45;
  return first + i * (first * 0.14);
};

const STATION_OMEGA = 0.085;
const STATION_TINT = [0.74, 0.80, 0.88];

/* ═══════════════════════════════════════════════════════════════════
   UNALLOCATED REAL BODIES (press `u` to toggle)
   ═══════════════════════════════════════════════════════════════════ */

const GHOSTS = (_SYNC && Array.isArray(_SYNC.hosts) && _SYNC.hosts.length) ? [] : [
  { id:"venus", name:"Venus", desig:"second planet", kind:"rock", surface:"veiled",
    atmo:1.0, a:1.559, e:0.01, rad:14, tint:[0.92,0.84,0.66], allocated:false,
    role:"0.72 AU · 225-day year",
    desc:"Rotates backwards, and so slowly that its day is longer than its year. A runaway greenhouse holds the surface at 460 °C under 92 atmospheres.",
    spec:[["real orbit","0.72 AU"],["day","243 Earth days"],["year","225 Earth days"],
          ["surface","460 °C · 92 atm"]] },

  { id:"terra", name:"Terra", desig:"Workstation", kind:"rock", surface:"terran",
    atmo:0.85, a:2.815, e:0.01, rad:15, tint:[0.42,0.60,0.78], tier:1,
    role:"operator workstation",
    desc:"Earth, allocated to the workstation driving the fleet — the one body on the chart you do not SSH into because you are already standing on it.",
    spec:[["real orbit","1.00 AU, by definition"],["moon","Luna — unallocated"],
          ["atmosphere","78% N\u2082 · 21% O\u2082"]] },

  { id:"luna", name:"Luna", desig:"Earth's moon", kind:"rock", surface:"cratered",
    parent:"terra", a:0.258, e:0.05, rad:6.5, tint:[0.68,0.66,0.63], allocated:false,
    role:"384,400 km · tidally locked",
    desc:"Tidally locked, receding 3.8 cm a year, with dark basalt maria flooding ancient impact basins.",
    spec:[["distance","384,400 km"],["recession","3.8 cm / year"]] },

  { id:"mars", name:"Mars", desig:"fourth planet", kind:"rock", surface:"cratered",
    atmo:0.28, a:3.969, e:0.067, rad:13, tint:[0.78,0.46,0.30], allocated:false,
    role:"1.52 AU · 687-day year",
    desc:"Carries Olympus Mons (22 km high) and Valles Marineris (4,000 km long), with an unexplained northern-lowland / southern-highland dichotomy.",
    spec:[["real orbit","1.52 AU"],["Olympus Mons","22 km tall"],["moons","Phobos · Deimos"]] },

  { id:"phobos", name:"Phobos", desig:"Martian moon", kind:"rock", surface:"regolith",
    parent:"mars", a:0.192, e:0.02, rad:4, tint:[0.52,0.46,0.42], allocated:false,
    role:"9,376 km · doomed",
    desc:"Orbits below synchronous altitude; tidal forces will break it apart into a Martian ring in ~50 million years.",
    spec:[["orbit","9,376 km"],["period","7h 39m"]] },

  { id:"hygiea", name:"Hygiea", desig:"asteroid 10 Hygiea", kind:"rock", surface:"regolith",
    a:5.877, e:0.046, rad:5.5, tint:[0.48,0.50,0.52], allocated:false,
    role:"3.14 AU · fourth-largest",
    desc:"Fourth-largest main-belt object, nearly spherical without a giant impact basin to show for its size.",
    spec:[["real orbit","3.14 AU"],["diameter","434 km"]] },

  { id:"saturn", name:"Saturn", desig:"sixth planet", kind:"gas", surface:"regolith",
    atmo:1.0, a:14.012, e:0.015, rad:31, tint:[0.86,0.78,0.58], allocated:false,
    role:"9.58 AU · 29-year orbit",
    desc:"Less dense than water. Its water-ice rings span 280,000 km yet are under 100 metres thick, with a persistent hexagonal jet stream at the north pole.",
    spec:[["real orbit","9.58 AU"],["density","0.69 g/cm³"],["rings","<100 m thick"]] },

  { id:"titan", name:"Titan", desig:"Saturn's largest moon", kind:"rock", surface:"veiled",
    atmo:1.0, parent:"saturn", a:1.014, e:0.03, rad:9, tint:[0.80,0.62,0.34], allocated:false,
    role:"1.2 million km · methane cycle",
    desc:"The only body besides Earth with stable surface liquid — lakes and rivers of methane and ethane under an opaque orange haze.",
    spec:[["atmosphere","1.45× Earth pressure"],["surface temp","−179 °C"]] },

  { id:"enceladus", name:"Enceladus", desig:"Saturn's ice moon", kind:"ice", surface:"icy",
    parent:"saturn", a:0.788, e:0.01, rad:5, tint:[0.94,0.96,0.98], allocated:false,
    role:"238,000 km · geysers",
    desc:"Vents subsurface ocean plumes from south polar fractures, actively feeding Saturn's E ring.",
    spec:[["albedo","0.81 — brightest in the system"],["feeds","Saturn's E ring"]] },

  { id:"uranus", name:"Uranus", desig:"seventh planet", kind:"gas", surface:"regolith",
    atmo:1.0, a:16.323, e:0.015, rad:24, tint:[0.62,0.84,0.86], allocated:false,
    role:"19.2 AU · 84-year orbit",
    desc:"Tipped 98° onto its side, giving each pole 42 years of continuous sunlight followed by 42 years of darkness.",
    spec:[["real orbit","19.2 AU"],["axial tilt","97.8°"]] },

  { id:"miranda", name:"Miranda", desig:"Uranian moon", kind:"ice", surface:"icy",
    parent:"uranus", a:0.309, e:0.01, rad:4.5, tint:[0.80,0.84,0.86], allocated:false,
    role:"129,900 km · Verona Rupes",
    desc:"Carries Verona Rupes, the tallest known cliff in the solar system at up to 20 km.",
    spec:[["Verona Rupes","up to 20 km"],["diameter","470 km"]] },

  { id:"neptune", name:"Neptune", desig:"eighth planet", kind:"gas", surface:"regolith",
    atmo:1.0, a:17.556, e:0.01, rad:23, tint:[0.30,0.44,0.82], allocated:false,
    role:"30.1 AU · 165-year orbit",
    desc:"Discovered by mathematics before observation, driven by an internal heat source powering 2,100 km/h winds.",
    spec:[["real orbit","30.1 AU"],["winds","2,100 km/h"]] },

  { id:"triton", name:"Triton", desig:"Neptune's captured moon", kind:"ice", surface:"icy",
    parent:"neptune", a:0.317, rad:6, tint:[0.86,0.86,0.90], allocated:false,
    role:"354,800 km · retrograde",
    desc:"Orbits backwards — a captured Kuiper belt object with nitrogen geysers at −235 °C.",
    spec:[["orbit","retrograde — captured"],["surface","−235 °C"]] },

  { id:"pluto", name:"Pluto", desig:"dwarf planet", kind:"rock", surface:"cratered",
    atmo:0.15, a:18.778, e:0.011, rad:9, tint:[0.76,0.68,0.58], allocated:false,
    role:"39.5 AU · Kuiper belt",
    desc:"Home to Sputnik Planitia, a nitrogen-ice glacier the size of Texas. Charon orbits it here, right at the outer trust edge.",
    spec:[["real orbit","39.5 AU"],["glacier","Sputnik Planitia"]] },

  { id:"eris", name:"Eris", desig:"dwarf planet", kind:"rock", surface:"icy",
    a:19.563, e:0.013, rad:8, tint:[0.88,0.88,0.90], allocated:false,
    role:"67.8 AU · outer boundary",
    desc:"Discovered in 2005 and 27% more massive than Pluto, triggering the 2006 IAU planetary reclassification.",
    spec:[["real orbit","67.8 AU"],["mass","1.27× Pluto"]] },
];

SYS.forEach(b => {
  if (b.id === "io" || b.id === "callisto") {
    b.kind = "rock"; b.state = "ok"; b.allocated = false;
    b.tint = b.id === "io" ? [0.90,0.78,0.36] : [0.52,0.50,0.58];
  }
});

GHOSTS.forEach(g => {
  if (g.tier === undefined) g.tier = g.parent ? 2 : 1;
});
SYS.push(...GHOSTS);

const SURFACE_ID = { regolith: 0, cratered: 1, icy: 2, sulfur: 3, grooved: 4, terran: 5, banded: 6, veiled: 7 };
const ARCH_ID = { truss: 0, relay: 1, stack: 2, sensor: 3, hab: 4, wing: 5, radiator: 6, ring: 7 };
const CRAFT_ID = { tender: 0, courier: 1, derelict: 2 };

const SHELL_ARCH = {
  edge:       "relay",     // gateways: mast and dish
  ops:        "stack",     // module stacks on a spine
  monitoring: "sensor",    // instrument booms and pods
  home:       "ring",      // rotating habitat wheel
  apps:       "wing",      // big solar arrays
  ai:         "radiator",  // heat rejection — compute rejects heat
  gateway:    "hab",       // docking hub: berths for incoming tunnels
};

const SURFACES = {
  mercury: "cratered",
  io:      "sulfur",
  europa:  "icy",
  ganymede:"grooved",
  callisto:"cratered",
  charon:  "cratered",
  ceres:   "regolith",
  vesta:   "regolith",
  pallas:  "regolith",
  deimos:  "regolith",
};
const ATMO = { jupiter: 1.0, io: 0.18, europa: 0.05, ceres: 0.0, mercury: 0.0 };

SYS.forEach(b => {
  if (b.surface === undefined) b.surface = SURFACES[b.id] || "regolith";
  if (b.atmo === undefined)    b.atmo    = ATMO[b.id] ?? 0.0;
});

const FLEET = SYS.slice();
SYS.forEach((b, i) => { if (b.seed === undefined) b.seed = (i * 37.31) % 100; });

const HOSTS = [...new Set(_SERVICES.map(s => s.host))];
HOSTS.forEach(hostId => {
  const parent = SYS.find(b => b.id === hostId);
  if (!parent) return;
  const mine = _SERVICES.filter(s => s.host === hostId);
  const used = SHELLS.filter(id => mine.some(s => s.shell === id));
  const extraShells = [...new Set(mine.map(s => s.shell).filter(Boolean))].filter(id => !used.includes(id));
  const rings = (used.length || extraShells.length) ? [...used, ...extraShells] : [null];

  rings.forEach((ringId, ri) => {
    const members = mine.filter(s => (s.shell || null) === ringId);
    const a = ringRadius(parent, ri);
    members.forEach((s, i) => FLEET.push({
      id: "svc-" + hostId + "-" + s.name,
      name: s.name,
      desig: ringId ? "station · " + ringId : "station · " + parent.name,
      kind: "station",
      parent: hostId, a, e: 0,
      phase: (i / members.length) * Math.PI * 2 + ri * 0.7,
      omega: STATION_OMEGA * (1 - ri * 0.045),
      rad: 0.42, tint: STATION_TINT, station: true, shell: ringId, tier: 4,
      arch: SHELL_ARCH[ringId] || "truss",
      seed: (s.name.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7) % 100),
      state: s.state || "ok",
      health: s.health || [],
      sources: s.sources || [],
      role: "service on " + parent.name + (ringId ? " · compose." + ringId + ".yml" : ""),
      desc: s.state === "down"
        ? "Dark, but still in orbit — Orrery keeps a station visible until it is actually decommissioned."
        : s.state === "degraded"
          ? "Wavering light indicates a split monitor verdict — one check passing while a background worker or cron check is failing."
          : "An off-the-shelf self-hosted service orbiting " +
            parent.name + " as an artificial structure rather than a celestial body.",
      spec: [
        ...(ringId ? [["shell", "compose." + ringId + ".yml"],
                      ["ring", (ri + 1) + " of " + rings.length]] : []),
        ["host", parent.name],
        ...(s.sources && s.sources.length ? [["discovered", s.sources.join(" · ")]] : []),
      ],
    }));
  });
});

RESERVED.forEach(([n, a, e], i) => FLEET.push({
  id: "res-" + n.toLowerCase(), name: n, desig: "reserved", kind: "reserved",
  a, e, phase: i * 1.7, rad: 3.4, tint: [0.51, 0.55, 0.97],
  state: "reserved", tier: 3, role: "unallocated slot",
  desc: "A reserved name holding an empty orbit — room for the fleet to grow.",
  spec: [["status", "name reserved"]],
}));

/* Apply any orbits solved by `orrery sync` when custom config hosts/orbits are supplied. */
if (_SYNC && _SYNC.orbits) {
  for (const b of FLEET) {
    const solved = _SYNC.orbits[b.id];
    if (solved && !b.station && !b.fixed) {
      b.a = solved.a;
      b.e = solved.e || 0;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
   MINOR BODIES — belts, ring systems, comets
   ═══════════════════════════════════════════════════════════════════ */

const BELTS = (_SYNC && Array.isArray(_SYNC.hosts) && _SYNC.hosts.length) ? [] : [
  { id: "main",   from: 4.25, to: 6.43, count: 620, size: 1.15,
    tint: "196,212,232",
    spanIds: ["vesta", "ceres", "pallas", "hygiea", "deimos"],
    resonanceHost: "jupiter",
    resonances: [[1, 3], [2, 5], [3, 7], [1, 2]],
    gaps: [[4.42, 4.52], [4.99, 5.11], [5.22, 5.35], [5.79, 5.93]] },
  { id: "hilda",  from: 6.86, to: 7.34, count: 200, size: 1.0,
    tint: "178,190,206",
    resonanceHost: "jupiter",
    bandResonance: [2, 3],
    gaps: [] },
  { id: "kuiper", from: 18.21, to: 19.9, count: 420, size: 1.0,
    tint: "150,172,204",
    spanIds: ["pluto", "eris"],
    gaps: [] },
];

const SWARMS = (_SYNC && Array.isArray(_SYNC.hosts) && _SYNC.hosts.length) ? [] : [
  { id:"greeks",  host:"jupiter", lead:  60, count: 200, spread: 22, drift: 0.9,
    tint:"206,198,176", label:"Greek camp · L4" },
  { id:"trojans", host:"jupiter", lead: -60, count: 200, spread: 22, drift: 0.9,
    tint:"206,198,176", label:"Trojan camp · L5" },
];

const RINGS = (_SYNC && Array.isArray(_SYNC.hosts) && _SYNC.hosts.length) ? [] : [
  { host: "saturn", bands: [
    { from: 1.24, to: 1.52, alpha: 0.30, tint: "224,208,172" },
    { from: 1.55, to: 1.95, alpha: 0.62, tint: "238,226,196" },
    { from: 1.99, to: 2.28, alpha: 0.42, tint: "226,214,186" },
  ]},
  { host: "jupiter", bands: [
    { from: 1.16, to: 1.28, alpha: 0.16, tint: "196,180,150" },
    { from: 1.31, to: 1.42, alpha: 0.42, tint: "224,206,172" },
    { from: 1.45, to: 1.58, alpha: 0.14, tint: "200,190,166" },
  ]},
];

const COMETS = [
  { id: "c1", a: 5.4, e: 0.74, phase: 1.10, tint: "188,222,240" },
  { id: "c2", a: 7.8, e: 0.80, phase: 4.05, tint: "206,226,236" },
];
const K_COMET = 0.50;

/* The trust boundary, drawn. Beyond it the layout stops being ours and the real
   sky takes over — which is why Polaris is allowed a real celestial position. */
let HELIOPAUSE = 20.8;
if (_SYNC && typeof _SYNC.heliopause === "number") HELIOPAUSE = _SYNC.heliopause;
