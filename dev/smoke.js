#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   smoke.js — load the real renderer headless and drive real frames.

     node dev/smoke.js              # load + 120 frames, report draw calls
     BENCH=1 node dev/smoke.js      # JS-side cost per frame
     ALLOC=1 node --expose-gc dev/smoke.js    # heap growth per frame

   Stands up just enough DOM, 2D canvas and WebGL to run src/ unmodified. It
   catches what `node --check` cannot: a typo'd element id, a const
   reassignment, a uniform that no longer exists, a function used above its
   declaration, an exception on frame 40.

   What it CANNOT tell you: how it looks, or how fast it really is. Every
   draw call is a no-op here, so the GPU and canvas fill costs — which are
   the actual frame budget — are invisible. BENCH measures the JS half only.
   Use the ⌘K panel in a real browser for the other half; it now reports
   backdrop / bodies / overlay milliseconds separately.
   ───────────────────────────────────────────────────────────────────────── */
const fs = require("fs");

const calls = { fillRect: 0, drawImage: 0, stroke: 0, drawArrays: 0, clearRect: 0,
                fill: 0, beginPath: 0, emptyDraw: 0 };
let pathOps = 0;
const missingEls = new Set();
const glCalls = new Set();

function ctx2d() {
  const noop = () => {};
  const grad = { addColorStop: noop };
  return {
    canvas: { width: 100, height: 100 },
    fillRect(){calls.fillRect++;}, clearRect(){calls.clearRect++;},
    drawImage(){calls.drawImage++;},
    stroke(){ calls.stroke++; if (!pathOps) calls.emptyDraw++; pathOps = 0; },
    createRadialGradient: () => grad, createLinearGradient: () => grad,
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    /* Path bookkeeping: a canvas has ONE current path, so subpaths built for
       different colours must not be interleaved across a beginPath(). This
       tracks how much geometry each stroke()/fill() actually consumes —
       a stroke that consumes zero is geometry that was silently discarded,
       which is exactly the bug that dropped half the orbit web. */
    beginPath(){ calls.beginPath++; pathOps = 0; },
    moveTo(){ pathOps++; }, lineTo(){ pathOps++; },
    arc(){ pathOps++; }, ellipse(){ pathOps++; }, rect(){ pathOps++; },
    fill(){ calls.fill++; if (!pathOps) calls.emptyDraw++; pathOps = 0; },
    save:noop, restore:noop, setTransform:noop, translate:noop, rotate:noop,
    scale:noop, closePath:noop, setLineDash:noop, fillText:noop, strokeText:noop,
    quadraticCurveTo(){ pathOps++; }, bezierCurveTo(){ pathOps++; },
    clip:noop, putImageData:noop,
  };
}

function makeCanvas() {
  return {
    width: 0, height: 0, style: {},
    getContext(kind) { return kind === "2d" ? ctx2d() : glStub(); },
    addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 1000 }),
    clientWidth: 1600, clientHeight: 1000,
  };
}

function glStub() {
  const noop = () => {};
  const o = {};
  for (const k of ["shaderSource","compileShader","attachShader","linkProgram",
    "useProgram","bindBuffer","bufferData","enableVertexAttribArray",
    "vertexAttribPointer","enable","blendFunc","viewport","clear","clearColor",
    "uniform1f","uniform2f","uniform3fv","uniform2fv","uniform1i","deleteShader",
    "activeTexture","bindTexture","pixelStorei","texParameteri","texImage2D"]) o[k]=noop;
  o.createShader=o.createProgram=o.createBuffer=o.createTexture=()=>({});
  o.getShaderParameter=o.getProgramParameter=()=>true;
  /* Big enough for the hull atlas, so the headless run exercises the sprite
     path rather than silently falling back to the SDF glyphs — a stub that
     answers "too small" would test the wrong branch every time. */
  o.getParameter=(p)=>(p===o.MAX_TEXTURE_SIZE?4096:0);
  o.getUniformLocation=n=>({n}); o.getAttribLocation=()=>0;
  o.getShaderInfoLog=o.getProgramInfoLog=()=>"";
  o.getExtension=()=>null;
  o.drawArrays=()=>{calls.drawArrays++;};
  o.COLOR_BUFFER_BIT=1; o.SRC_ALPHA=1; o.ONE=1; o.ONE_MINUS_SRC_ALPHA=1;
  o.BLEND=1; o.ARRAY_BUFFER=1; o.STATIC_DRAW=1; o.FLOAT=1;
  o.VERTEX_SHADER=1; o.FRAGMENT_SHADER=1; o.TRIANGLES=1; o.COMPILE_STATUS=1;
  o.MAX_TEXTURE_SIZE=0x0D33; o.TEXTURE_2D=1; o.RGBA=1; o.UNSIGNED_BYTE=1;
  o.TEXTURE0=0x84C0; o.TEXTURE1=0x84C1; o.CLAMP_TO_EDGE=1; o.LINEAR=1;
  o.TEXTURE_WRAP_S=1; o.TEXTURE_WRAP_T=1;
  o.TEXTURE_MIN_FILTER=1; o.TEXTURE_MAG_FILTER=1;
  o.uniform4f=noop;
  return o;
}

const els = {};
function makeEl(tag = "div") {
  const e = {
    tagName: tag, style: {}, dataset: {}, children: [], hidden: false,
    textContent: "", innerHTML: "", value: "0", type: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null, focus() {}, blur() {}, remove() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 120,
                                    right: 200, bottom: 120 }),
  };
  return e;
}

const IDS = ["stage", "stars", "backdrop", "bodies", "overlay", "readout", "cmdk",
  "plateTitle", "plateChart",
  "epoch", "count", "rate", "fpsNow", "fpsMs", "fpsLow", "fpsGraph",
  "ctlSpeed", "outSpeed", "ctlScale", "outScale",
  "cmdkInput", "cmdkList", "cmdkEmpty",
  "stBodies", "stOrbits", "stZoom", "stCost", "stScale"];

for (const id of IDS) {
  els[id] = (id === "stars" || id === "backdrop" || id === "bodies" ||
             id === "overlay" || id === "fpsGraph") ? makeCanvas() : makeEl();
}
els.stage.clientWidth = 1600; els.stage.clientHeight = 1000;
els.stage.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };

let rafCb = null;
global.window = {
  devicePixelRatio: 2,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  requestAnimationFrame(cb) { rafCb = cb; return 1; },
  location: { hash: "" }, history: { replaceState() {} },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  innerWidth: 1600, innerHeight: 1000,
};
global.devicePixelRatio = 2;
global.requestAnimationFrame = cb => { rafCb = cb; return 1; };
global.cancelAnimationFrame = () => {};
global.performance = { now: () => nowMs };
global.matchMedia = global.window.matchMedia;
global.location = global.window.location;
global.history = global.window.history;
global.getComputedStyle = global.window.getComputedStyle;
global.ResizeObserver = class { observe() {} disconnect() {} };
global.addEventListener = () => {};
global.removeEventListener = () => {};
global.innerWidth = 1600; global.innerHeight = 1000;
global.navigator = { userAgent: "node", maxTouchPoints: 0 };
global.fetch = async () => ({ ok: true, json: async () => [] });

global.document = {
  getElementById(id) {
    if (els[id]) return els[id];
    missingEls.add(id);
    return null;
  },
  createElement: tag => (tag === "canvas" ? makeCanvas() : makeEl(tag)),
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
  documentElement: makeEl(), body: makeEl(),
  hidden: false, visibilityState: "visible",
};

let nowMs = 0;
const ROOT = process.env.ROOT || require("path").join(__dirname, "..");
const src = ["src/services.generated.js", "src/fleet.js", "src/shaders.js", "src/orrery.js"].map(f => ROOT + "/" + f)
  .map(f => fs.readFileSync(f, "utf8")).join("\n;\n");

try {
  new Function(src)();
} catch (e) {
  console.log("LOAD FAILED:", e.message);
  console.log(e.stack.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
}
console.log("loaded ok");

if (!rafCb) { console.log("no animation frame scheduled — loop never started"); process.exit(1); }

// drive 120 real frames
let err = null;
for (let i = 0; i < 120 && !err; i++) {
  nowMs += 16.7;
  const cb = rafCb; rafCb = null;
  try { cb(nowMs); } catch (e) { err = e; }
  if (!rafCb && !err) { console.log(`loop stopped after frame ${i}`); break; }
}
if (err) {
  console.log("FRAME FAILED:", err.message);
  console.log(err.stack.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}

if (process.env.ALLOC) {
  for (let i=0;i<200;i++){ nowMs+=16.7; const cb=rafCb; rafCb=null; cb(nowMs); }
  global.gc(); const h0=process.memoryUsage().heapUsed; const N=2000;
  for (let i=0;i<N;i++){ nowMs+=16.7; const cb=rafCb; rafCb=null; cb(nowMs); }
  const h1=process.memoryUsage().heapUsed;
  console.log("heap growth: "+(((h1-h0)/N)|0)+" bytes/frame (pre-GC allocation proxy)");
  process.exit(0);
}
if (process.env.BENCH) {
  for (let i=0;i<300;i++){ nowMs+=16.7; const cb=rafCb; rafCb=null; cb(nowMs); }  // warm
  const t0=process.hrtime.bigint();
  const N=3000;
  for (let i=0;i<N;i++){ nowMs+=16.7; const cb=rafCb; rafCb=null; cb(nowMs); }
  const ms=Number(process.hrtime.bigint()-t0)/1e6;
  console.log("JS frame cost: "+(ms/N).toFixed(4)+" ms/frame over "+N+" frames");
  process.exit(0);
}
console.log("120 frames ok");
console.log("  draw calls/run:", JSON.stringify(calls));
if (calls.emptyDraw)
  console.log("  \u2717 " + calls.emptyDraw + " stroke/fill calls consumed an EMPTY path" +
              " — geometry built before a beginPath() that wiped it");
else
  console.log("  every stroke/fill consumed geometry");
if (missingEls.size)
  console.log("  ✗ getElementById returned null for:", [...missingEls].join(", "));
else
  console.log("  every getElementById resolved");
