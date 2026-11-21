#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   bundle.js — regenerate orrery.html, the single-file build.

     node dev/bundle.js            # write ../orrery.html
     node dev/bundle.js --check    # verify it is up to date, write nothing

   The README has always said "regenerate by concatenating src/", which was
   true and also entirely manual. This is that sentence, executable, so the
   bundle cannot silently drift from the sources it claims to be.
   ───────────────────────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const OUT = path.join(__dirname, "..", "orrery.html");
const read = f => fs.readFileSync(path.join(SRC, f), "utf8");

/* The snapshot is deliberately not a whole document: no doctype, no <head>,
   no favicon — keeping it to charset + title + style + markup + scripts is what
   makes it readable as one file.

   The charset line is NOT optional, though this comment used to say the file
   quirks-parses fine without it. It does not. The chart is full of ·, ° and —,
   and with no <meta charset> the encoding falls to the Content-Type header:
   Caddy sends `text/html; charset=utf-8` so the deployed copy is fine, but a
   file:// open sends no header at all and `python3 -m http.server` sends none
   either, and both then decode as windows-1252 — every separator in the plate
   renders as Â·. Verified in Chrome: document.characterSet was windows-1252. */
const index = read("index.html");
const between = (from, to) => {
  const i = index.indexOf(from), j = index.indexOf(to, i);
  return index.slice(i, j).trimEnd();
};

const title = index.match(/^[ \t]*<title>.*<\/title>[ \t]*$/m)[0].trim();
const markup = between('<div class="orrery" id="stage">', '<script src=');
const scripts = [...index.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => m[1] === "generated/services.js" ? "services.generated.js" : m[1]);

const charset = index.match(/^[ \t]*<meta charset=[^>]*>[ \t]*$/m)[0].trim();

const html = [
  charset,
  title,
  "",
  "<!-- GENERATED SNAPSHOT. Canonical source is src/. Regenerate with: node dev/bundle.js -->",
  "",
  `<style>\n${read("orrery.css").trimEnd()}\n</style>`,
  "",
  markup,
  "",
  ...scripts.flatMap(f => [`<script>\n${read(f).trimEnd()}\n</script>`, ""]),
].join("\n").replace(/\n+$/, "\n");

/* ── one global scope ────────────────────────────────────────────────────
   Every file here ships as a classic <script>, and a top-level `const` in a
   classic script goes into the GLOBAL lexical environment — shared across all
   of them. Two files declaring the same name is a SyntaxError that kills
   whichever loads second and every script after it, and the failure is
   nowhere near the cause: the chart simply stops having a feature. It cost a
   debugging session when greeble.js and hulls.js both exported `const API`,
   so it is a check now. */
{
  const names = {}, dup = [];
  for (const f of scripts) {
    const src = read(f), seen = new Set();
    for (const m of src.matchAll(/^(?:const|let|class)\s+([^;=\n(]*?)(?:=|;|$)/gm))
      for (const part of m[1].split(","))
        if (/^[A-Za-z_$][\w$]*$/.test(part.trim())) seen.add(part.trim());
    for (const m of src.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) seen.add(m[1]);
    for (const n of seen) (names[n] ||= []).push(f);
  }
  for (const [n, fs_] of Object.entries(names))
    if (fs_.length > 1) dup.push(`  ${n} — declared in ${fs_.join(" and ")}`);
  if (dup.length) {
    console.log("TOP-LEVEL NAME COLLISION between scripts sharing one global scope:");
    console.log(dup.join("\n"));
    process.exit(1);
  }
}

if (process.argv.includes("--check")) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur === html) { console.log("orrery.html is up to date"); process.exit(0); }
  console.log("orrery.html is STALE — run: node dev/bundle.js");
  process.exit(1);
}

fs.writeFileSync(OUT, html);
console.log(`wrote orrery.html · ${(html.length / 1024).toFixed(0)} kB` +
            ` from ${["index.html", "orrery.css", "services.generated.js", "fleet.js", "shaders.js", "orrery.js"].length} sources`);
