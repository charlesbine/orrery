/* ─────────────────────────────────────────────────────────────────────────
   greeble.js — surface detail, after Kinnear & Kaplan (2010),
   "Procedural generation of surface detail for science fiction spaceships".

   This is the part that was missing. A hull's silhouette is maybe a fifth of
   why a spaceship reads as one; the rest is the nurnies — the hundreds of small
   protrusions that ILM called greebles, whose real job is to imply SCALE. You
   read the size of a ship from the size of its smallest repeated feature, so a
   smooth hull has no size at all, which is exactly why mine looked like a
   chess piece rather than a kilometre of machinery.

   The pipeline, in the paper's order:

     1. SUBDIVIDE a face into irregular sub-panels. Not a grid — grids read as
        tile. A random point inside a rectangle with THREE of the four lines to
        its edges gives a T junction; the paper is explicit that drawing all
        four is too regular.
     2. NURNIES. Raise cuboids on a fraction of the panels.
     3. COMPLEMENTARY GEOMETRY. Ramp a wedge down from a raised cuboid across
        its neighbour. This is what puts ORDER back into the noise, and without
        it the surface reads as rubble.
     4. SUBSTITUTION RULES. Recursively decorate each cuboid — subdivide its
        top, split it into a row, ring it with bolts, cap it with an enclosure.
        Applying these at several levels is what produces detail at every scale,
        which is the actual goal.

   The governing principle they take from Gombrich: delight lies somewhere
   between boredom and confusion. Every step that adds order gets answered with
   variety, and every step that adds variety gets answered with order.
   ───────────────────────────────────────────────────────────────────────── */

/* ── panel subdivision ──────────────────────────────────────────────────── */

/* Split one rectangle into two or three children. Elongated rectangles get a
   single straight cut — a T junction inside a sliver just makes worse slivers. */
function splitRect(rand, R) {
  const aspect = R.h / R.w;
  if (aspect > 2.4) {
    const t = 0.3 + rand() * 0.4;
    return [{ x: R.x, y: R.y, w: R.w, h: R.h * t },
            { x: R.x, y: R.y + R.h * t, w: R.w, h: R.h * (1 - t) }];
  }
  if (aspect < 1 / 2.4) {
    const t = 0.3 + rand() * 0.4;
    return [{ x: R.x, y: R.y, w: R.w * t, h: R.h },
            { x: R.x + R.w * t, y: R.y, w: R.w * (1 - t), h: R.h }];
  }
  /* The T junction. The split point is confined to a centred, scaled copy of
     the rectangle so a cut never shaves off a sliver. */
  const px = R.x + R.w * (0.28 + rand() * 0.44);
  const py = R.y + R.h * (0.28 + rand() * 0.44);
  const lw = px - R.x, rw = R.x + R.w - px;
  const bh = py - R.y, th = R.y + R.h - py;
  switch (Math.floor(rand() * 4)) {
    case 0:  // omit the upward line
      return [{ x: R.x, y: py, w: R.w, h: th },
              { x: R.x, y: R.y, w: lw, h: bh },
              { x: px,  y: R.y, w: rw, h: bh }];
    case 1:  // omit the downward line
      return [{ x: R.x, y: R.y, w: R.w, h: bh },
              { x: R.x, y: py, w: lw, h: th },
              { x: px,  y: py, w: rw, h: th }];
    case 2:  // omit the leftward line
      return [{ x: R.x, y: R.y, w: lw, h: R.h },
              { x: px,  y: R.y, w: rw, h: bh },
              { x: px,  y: py,  w: rw, h: th }];
    default: // omit the rightward line
      return [{ x: px,  y: R.y, w: rw, h: R.h },
              { x: R.x, y: R.y, w: lw, h: bh },
              { x: R.x, y: py,  w: lw, h: th }];
  }
}

/* Repeatedly split, always choosing from the LARGER panels, so detail spreads
   over the whole face instead of shredding one corner of it. */
function subdivide(rand, count, minSize) {
  let rects = [{ x: 0, y: 0, w: 1, h: 1 }];
  let guard = count * 6;
  while (rects.length < count && guard-- > 0) {
    rects.sort((a, b) => b.w * b.h - a.w * a.h);
    const pool = Math.max(1, Math.ceil(rects.length * 0.35));
    const k = Math.floor(rand() * pool);
    const R = rects[k];
    if (Math.min(R.w, R.h) < minSize * 2) break;
    rects.splice(k, 1);
    rects.push(...splitRect(rand, R));
  }
  return rects;
}

/* ── placing geometry on a face ─────────────────────────────────────────── */

/* A face is an origin and two spanning vectors; everything below works in that
   frame, so the same code details a hull side, a wing, or the top of a nurnie
   it just placed. That reuse is what makes the recursion cheap. */
function faceFrame(O, U, V, N) { return { O, U, V, N }; }

/* A face may be a general quad rather than a parallelogram — the side of a
   tapering, bending hull segment is one. `W` is the corner-closing term that
   makes the mapping bilinear; without it every greeble on a tapered hull sits
   slightly off the surface, floating at one end and buried at the other. */
function fpt(f, x, y, h) {
  const k = f.W ? x * y : 0;
  return [
    f.O[0] + f.U[0] * x + f.V[0] * y + (f.W ? f.W[0] * k : 0) + f.N[0] * h,
    f.O[1] + f.U[1] * x + f.V[1] * y + (f.W ? f.W[1] * k : 0) + f.N[1] * h,
    f.O[2] + f.U[2] * x + f.V[2] * y + (f.W ? f.W[2] * k : 0) + f.N[2] * h,
  ];
}

/* The frame of a sub-rectangle of `f`, lifted to height `h`. Derived by
   evaluating the parent rather than scaling its vectors, so the bilinear term
   is carried correctly into every level of the recursion. */
function subFrame(f, r, h) {
  const O = fpt(f, r.x, r.y, h);
  const X = fpt(f, r.x + r.w, r.y, h), Y = fpt(f, r.x, r.y + r.h, h);
  const XY = fpt(f, r.x + r.w, r.y + r.h, h);
  const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
  return { O, U: sub(X, O), V: sub(Y, O),
           W: [O[0]-X[0]+XY[0]-Y[0], O[1]-X[1]+XY[1]-Y[1], O[2]-X[2]+XY[2]-Y[2]],
           N: f.N };
}

/* A raised slab on a face: five quads, since the bottom is never seen. */
function pad(m, addQuad, f, r, h0, h1, mat, topMat) {
  const { x, y, w, h } = r;
  const A = fpt(f, x,     y,     h0), B = fpt(f, x + w, y,     h0);
  const C = fpt(f, x + w, y + h, h0), D = fpt(f, x,     y + h, h0);
  const a = fpt(f, x,     y,     h1), b = fpt(f, x + w, y,     h1);
  const c = fpt(f, x + w, y + h, h1), d = fpt(f, x,     y + h, h1);
  addQuad(m, a, b, c, d, topMat === undefined ? mat : topMat);
  addQuad(m, A, B, b, a, mat);
  addQuad(m, B, C, c, b, mat);
  addQuad(m, C, D, d, c, mat);
  addQuad(m, D, A, a, d, mat);
}

/* A wedge ramping from a pad's edge down onto the surface beside it. The
   paper's "complementary geometry": it ties a raised block to its neighbour so
   the two read as one designed assembly rather than two dropped objects. */
function wedge(m, addQuad, f, r, side, len, h, mat) {
  const { x, y, w } = r;
  let A, B, C, D;
  if (side === 0) {      // ramp out along -y
    A = fpt(f, x, y, h); B = fpt(f, x + w, y, h);
    C = fpt(f, x + w, y - len, 0); D = fpt(f, x, y - len, 0);
  } else if (side === 1) { // +y
    A = fpt(f, x + w, y + r.h, h); B = fpt(f, x, y + r.h, h);
    C = fpt(f, x, y + r.h + len, 0); D = fpt(f, x + w, y + r.h + len, 0);
  } else if (side === 2) { // -x
    A = fpt(f, x, y + r.h, h); B = fpt(f, x, y, h);
    C = fpt(f, x - len, y, 0); D = fpt(f, x - len, y + r.h, 0);
  } else {                 // +x
    A = fpt(f, x + w, y, h); B = fpt(f, x + w, y + r.h, h);
    C = fpt(f, x + w + len, y + r.h, 0); D = fpt(f, x + w + len, y, 0);
  }
  addQuad(m, A, B, C, D, mat);
}

/* ── substitution rules ─────────────────────────────────────────────────── */

/* Applied to a pad that was just placed, on its own top face. Recursive: a rule
   may greeble the top, which places pads, which may be decorated again. This
   is where multi-scale detail actually comes from — one pass of boxes is a
   crate, three levels of nested boxes is machinery. */
function decorate(m, addQuad, f, r, h, rand, depth, M, budget) {
  if (depth <= 0 || budget.n <= 0) return;
  const sub = subFrame(f, r, h);
  /* The rule heights below are WORLD units, so this has to be the pad's smaller
     side measured in world units — not its fraction of the face. A face's U and
     V differ by an order of magnitude between a hab drum and a courier's nose,
     and a fractional height makes the greebles on one of them stilts. */
  const s = Math.min(Math.hypot(...sub.U), Math.hypot(...sub.V));

  switch (Math.floor(rand() * 6)) {
    case 0: {   // treat the top as a new surface and greeble it again
      greebleFace(m, addQuad, sub, rand, {
        panels: 3 + Math.floor(rand() * 3), height: s * 0.5,
        minSize: 0.12, depth: depth - 1, M, budget,
      });
      break;
    }
    case 1: {   // split into an evenly spaced row of thinner slabs
      const n = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        const gw = 1 / n;
        pad(m, addQuad, sub, { x: i * gw + gw * 0.16, y: 0.1, w: gw * 0.68, h: 0.8 },
            0, s * (0.25 + rand() * 0.4), M.PANEL, M.HULL);
        budget.n--;
      }
      break;
    }
    case 2: {   // four blocks round the rim: an enclosure
      const t = 0.18 + rand() * 0.1;
      for (const q of [{x:0,y:0,w:1,h:t}, {x:0,y:1-t,w:1,h:t},
                       {x:0,y:t,w:t,h:1-2*t}, {x:1-t,y:t,w:t,h:1-2*t}]) {
        pad(m, addQuad, sub, q, 0, s * (0.3 + rand() * 0.3), M.STRUT, M.PANEL);
      }
      budget.n -= 4;
      break;
    }
    case 3: {   // a rib across the top
      const t = 0.12 + rand() * 0.1;
      const vert = rand() < 0.5;
      pad(m, addQuad, sub, vert ? { x: 0.5 - t/2, y: 0, w: t, h: 1 }
                                : { x: 0, y: 0.5 - t/2, w: 1, h: t },
          0, s * (0.35 + rand() * 0.35), M.STRUT, M.FITTING);
      budget.n--;
      break;
    }
    case 4: {   // bolts near the corners
      const t = 0.14, e = 0.10;
      for (const q of [{x:e,y:e},{x:1-e-t,y:e},{x:e,y:1-e-t},{x:1-e-t,y:1-e-t}]) {
        pad(m, addQuad, sub, { ...q, w: t, h: t }, 0, s * 0.16, M.FITTING);
      }
      budget.n -= 4;
      break;
    }
    default: {  // a regular grid of small blocks — reads as vents or cells
      const n = 2 + Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        pad(m, addQuad, sub, { x: (i + 0.22) / n, y: (j + 0.22) / n,
                               w: 0.56 / n, h: 0.56 / n },
            0, s * 0.14, M.PANEL, M.FITTING);
      }
      budget.n -= n * n;
      break;
    }
  }
}

/* ── the entry point ────────────────────────────────────────────────────── */

/* Detail one face. `height` is the tallest a nurnie may stand, in the same
   units as the face's spanning vectors, and is what keeps greebles in
   proportion to the panel they sit on rather than to the ship. */
function greebleFace(m, addQuad, f, rand, o) {
  const M = o.M;
  const budget = o.budget || { n: 400 };
  const panels = subdivide(rand, o.panels ?? 14, o.minSize ?? 0.05);
  const raised = [];

  for (const r of panels) {
    if (budget.n <= 0) break;
    const roll = rand();
    const s = Math.min(r.w, r.h);
    if (roll < 0.34) {
      /* a nurnie */
      const h = o.height * (0.25 + rand() * 0.9);
      pad(m, addQuad, f, r, 0, h, M.PANEL, rand() < 0.3 ? M.HULL : M.PANEL);
      budget.n--;
      raised.push({ r, h });
      if ((o.depth ?? 1) > 0 && s > 0.1 && rand() < 0.75)
        decorate(m, addQuad, f, r, h, rand, (o.depth ?? 1), M, budget);
    } else if (roll < 0.50) {
      /* a shallow plate: panel-line relief rather than a block, and most of
         what stops a hull looking like a pile of crates */
      const inset = Math.min(r.w, r.h) * 0.10;
      pad(m, addQuad, f, { x: r.x + inset, y: r.y + inset,
                           w: r.w - inset * 2, h: r.h - inset * 2 },
          0, o.height * 0.07, M.HULL, M.PANEL);
      budget.n--;
    } else if (roll < 0.60) {
      /* a cluster of repeated elements. The paper's rule: when a panel is much
         longer than it is wide, place SEVERAL copies of a part in a row rather
         than stretching one, which is where that machined-rack look comes from */
      const along = r.w > r.h;
      const n = 2 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        const q = along
          ? { x: r.x + r.w * (i + 0.18) / n, y: r.y + r.h * 0.2, w: r.w * 0.64 / n, h: r.h * 0.6 }
          : { x: r.x + r.w * 0.2, y: r.y + r.h * (i + 0.18) / n, w: r.w * 0.6, h: r.h * 0.64 / n };
        pad(m, addQuad, f, q, 0, o.height * (0.2 + rand() * 0.3), M.STRUT, M.FITTING);
      }
      budget.n -= n;
    } else {
      /* The rest. Not bare — a PLATE, standing off the hull by a hair.
         "Leave it flat" sounds like restraint and renders as blank paper: a
         large unbroken face is the one thing on a hull that has no scale at
         all, and under a raking key it is a white void with machinery around
         it. Plating seams are how a real surface rests. They read as order
         rather than detail, which is exactly the job. */
      const inset = Math.min(r.w, r.h) * 0.055;
      pad(m, addQuad, f, { x: r.x + inset, y: r.y + inset,
                           w: r.w - inset * 2, h: r.h - inset * 2 },
          0, o.height * 0.022, M.PANEL, M.HULL);
      budget.n--;
    }
  }

  /* complementary wedges, ramping raised blocks down onto their neighbours */
  for (const { r, h } of raised) {
    if (rand() < 0.5) continue;
    const side = Math.floor(rand() * 4);
    const len = (side < 2 ? r.h : r.w) * (0.5 + rand());
    wedge(m, addQuad, f, r, side, Math.min(len, 0.18), h, M.STRUT);
  }
}

/* Named, not `API`. greeble.js and hulls.js are classic scripts in the chart
   and therefore share ONE global scope, so two files each declaring `const
   API` is a SyntaxError that kills whichever loads second — and takes every
   later script with it. */
const GREEBLE_API = { greebleFace, subdivide, splitRect, pad, wedge, faceFrame, fpt, subFrame };
if (typeof module !== "undefined" && module.exports) module.exports = GREEBLE_API;
if (typeof window !== "undefined") window.GREEBLE = GREEBLE_API;
