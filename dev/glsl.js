#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   glsl.js — static check of the shader sources.

     node dev/glsl.js

   There is no GL context here, and the smoke test's stub answers
   COMPILE_STATUS with `true` unconditionally, so a shader that cannot compile
   sails straight through it. That is not hypothetical: using `u_radius` in the
   fragment shader when it was only declared in the vertex shader failed to
   link, every body vanished, and every automated check still said pass.

   So this does the one thing that would have caught it — resolve every
   identifier against what its own stage declares.
   ───────────────────────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");

const SHADERS = path.join(__dirname, "..", "src", "shaders.js");
const src = fs.readFileSync(SHADERS, "utf8");

/* ── a backtick inside a GLSL comment ────────────────────────────────────
   Every shader here is a JS template literal, so one backtick in a comment
   ends the literal early and the rest of the shader becomes JavaScript. What
   you get is a SyntaxError somewhere further down the file, pointing at a line
   that is perfectly fine, and no clue that the cause was punctuation inside a
   comment. It has happened three times on this branch alone — writing about
   `u_radius` or `surf` in prose is exactly the natural thing to do.

   This runs BEFORE the file is evaluated, on the raw text, because once it is
   broken it cannot be loaded at all. */
{
  const lines = src.split("\n");
  const bad = [];
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], ticks = (line.match(/`/g) || []).length;
    if (block === null) {
      const open = line.match(/^const\s+([A-Za-z_]\w*)\s*=\s*`/);
      if (open) {
        block = open[1];
        if (ticks > 1) bad.push([i + 1, block, line]);
      }
      continue;
    }
    if (ticks === 0) continue;
    if (/`\s*;?\s*$/.test(line)) { block = null; if (ticks > 1) bad.push([i + 1, block, line]); continue; }
    bad.push([i + 1, block, line]);
  }
  if (bad.length) {
    console.log("BACKTICK INSIDE A SHADER LITERAL — this ends the template early:");
    for (const [n, b, line] of bad)
      console.log(`  src/shaders.js:${n}  (in ${b})  ${line.trim()}`);
    console.log("\nUse plain prose in GLSL comments; there is no way to escape a");
    console.log("backtick inside a template literal without changing the shader text.");
    process.exit(1);
  }
}

const { VS, FS, HULL_VS, HULL_FS } =
  new Function(src + "return { VS, FS, HULL_VS, HULL_FS };")();

/* Every stage in the file, not just the body pair. The hull pass was added
   later and went unchecked until this line existed — which is the same way
   the undeclared-uniform bug this tool was written for got in. */
const STAGES = [["vertex", VS], ["fragment", FS],
                ["hull vertex", HULL_VS], ["hull fragment", HULL_FS]];

// strip comments and string noise so declarations parse cleanly
const clean = s => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const GLSL_BUILTIN = new Set([
  "gl_Position", "gl_FragColor", "gl_FragCoord", "gl_PointSize", "gl_PointCoord",
  "gl_FrontFacing", "gl_FragData",
]);

function declared(stage) {
  const s = clean(stage);
  const names = new Set();
  // uniform/attribute/varying, including comma-separated lists
  for (const m of s.matchAll(/\b(?:uniform|attribute|varying)\s+\w+\s+([^;]+);/g))
    m[1].split(",").forEach(n => names.add(n.trim().replace(/\[.*/, "")));
  // locals, globals, params
  for (const m of s.matchAll(/\b(?:float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4|sampler2D)\s+([A-Za-z_]\w*)/g))
    names.add(m[1]);
  for (const m of s.matchAll(/\bfor\s*\(\s*\w+\s+([A-Za-z_]\w*)/g)) names.add(m[1]);
  // #define macros
  for (const m of s.matchAll(/#define\s+([A-Za-z_]\w*)/g)) names.add(m[1]);
  return names;
}

/* Identifiers that look like ours — uniforms, varyings and the shared globals.
   Deliberately narrow: parsing GLSL properly is not the job. Catching an
   undeclared `u_`, `v_`, `a_` or `g`-prefixed name is. */
function used(stage) {
  return new Set([...clean(stage).matchAll(/\b((?:u_|v_|a_|g)[A-Za-z_]\w*)/g)]
    .map(m => m[1]));
}

let bad = 0;
for (const [name, stage] of STAGES) {
  const dec = declared(stage), use = used(stage);
  const missing = [...use].filter(n => !dec.has(n) && !GLSL_BUILTIN.has(n));
  if (missing.length) {
    bad += missing.length;
    console.log(`  ✗ ${name} shader uses undeclared: ${missing.join(", ")}`);
  } else {
    console.log(`  ${name} shader: ${dec.size} names declared, all references resolve`);
  }
}

// every uniform the JS uploads must exist in at least one stage
const orrery = fs.readFileSync(
  path.join(__dirname, "..", "src", "orrery.js"), "utf8");
/* ALL of them. This matched only the first list, which happened to be the body
   pass — so when the hull program arrived with its own uniforms they were
   never checked, and an undeclared one there would have linked to nothing and
   drawn nothing, silently. Both lists start with "u_center", which is exactly
   why the single match looked like it was working. */
const uploadLists = [...orrery.matchAll(
  /\[\s*"u_center"[\s\S]*?\]\s*\n?\s*\.forEach\s*\(\s*n\s*=>\s*(\w+)\[n\]/g)];
if (uploadLists.length) {
  const names = [...new Set(uploadLists.flatMap(
    l => [...l[0].matchAll(/"(u_\w+)"/g)].map(m => m[1])))];
  const all = new Set(STAGES.flatMap(([, st]) => [...declared(st)]));
  const orphan = names.filter(n => !all.has(n));
  if (orphan.length) {
    bad += orphan.length;
    console.log(`  ✗ orrery.js uploads uniforms no shader declares: ${orphan.join(", ")}`);
  } else {
    console.log(`  ${names.length} uploaded uniforms all declared in a shader`);
  }
}

// balanced braces, since an unbalanced one also fails to compile
for (const [name, stage] of STAGES) {
  let d = 0;
  for (const ch of clean(stage)) { if (ch === "{") d++; else if (ch === "}") d--; }
  if (d !== 0) { bad++; console.log(`  ✗ ${name} shader braces unbalanced (${d})`); }
}

if (bad) { console.log(`\n${bad} problem(s) — the shader would fail to compile.`); process.exit(1); }
console.log("\nShaders resolve.");
