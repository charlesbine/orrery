/* ─────────────────────────────────────────────────────────────────────────
   shaders.js — body surface programs.

   Shared with dev/contact.html so the tuning rig renders with EXACTLY the
   shader that ships, never a copy that drifts.

   Two uniforms drive appearance beyond colour:
     u_kind    what the thing IS       — star / gas / ice / rock / station / …
     u_style   how its surface behaves — cratered / sulfur / grooved / …

   Before this split every rocky body was the same mottled sphere with a
   different tint, which is exactly what the first contact sheet showed:
   Ganymede, Ceres, Vesta, Pallas, Deimos and Charon were
   indistinguishable. Kind alone was never going to carry that.
   ───────────────────────────────────────────────────────────────────────── */

const VS = `
  attribute vec2 a_quad;
  uniform vec2  u_center, u_res;
  uniform float u_radius;
  uniform float u_kind;     // KIND_ID from fleet.js; glyph kinds need quad margin
  uniform float u_atmo;     // 0 airless .. 1 thick; the halo needs room too
  varying vec2  v_uv;
  void main(){
    /* Worlds are discs: the quad is exactly the disc's bounding box and every
       fragment outside it is thrown away, so ±1 is the right size.

       Glyphs (stations, craft) are not. Their silhouette is an SDF, and the
       antialias band around it is 1.0/u_radius wide in uv units — at the 2.5px
       station floor that is 0.4, nearly half the quad again. Without margin the
       soft edge has no fragments to land on and gets cut off square, which puts
       a hard aliased edge back on the exact glyphs the antialiasing was added
       to steady. Grow the quad by that band so the gradient has somewhere to go.
       At a zoomed-in 128px hull this is a 0.8% margin, so it costs nothing where
       it is not needed. */
    float m = 1.0;
    if (u_kind > 5.5) m += 1.0 / max(u_radius, 1.0) + 0.02;
    else              m += 0.175 * u_atmo;   // room for the atmospheric shell
    v_uv = a_quad * m;
    vec2 p = u_center + a_quad * m * u_radius;
    vec2 c = (p / u_res) * 2.0 - 1.0;
    gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
  }`;

/* ─────────────────────────────────────────────────────────────────────────
   THE HULL PASS — real geometry, for when a sprite is not enough.

   The atlas is the right answer for a station three pixels across and the
   wrong one the moment the chart FRAMES a body, because selecting one fills
   the screen with it. No fixed sprite survives that: 256px magnified to 900
   is soft, 512 would be soft one zoom step later, and the atlas is already
   six megabytes. Past a certain size the only thing that stays sharp is the
   mesh itself.

   So the same meshes the baker uses are built in the browser and drawn as
   actual triangles when a hull is big, and sampled from the atlas when it is
   small. Impostors far, geometry near — and the geometry costs 45 kB of
   JavaScript rather than megabytes of PNG.

   The projection is the chart's own axonometric, matching dev/bake.js exactly
   so a hull does not jump when it crosses the threshold between the two.
   ───────────────────────────────────────────────────────────────────────── */

const HULL_VS = `
  attribute vec3 a_pos;
  attribute vec3 a_nrm;
  attribute float a_mat;
  attribute float a_tone;
  uniform vec2  u_center, u_res;
  uniform float u_scale, u_head;
  varying vec3  v_n;
  varying float v_m, v_t;
  varying vec3  v_world;
  void main(){
    /* Craft point where they are going. With real geometry that is a rotation
       about the plane's normal rather than a choice between baked frames, so
       the heading is continuous and nothing steps. */
    float c = cos(u_head), s = sin(u_head);
    vec3 p = vec3(a_pos.x * c - a_pos.y * s, a_pos.x * s + a_pos.y * c, a_pos.z);
    vec3 n = vec3(a_nrm.x * c - a_nrm.y * s, a_nrm.x * s + a_nrm.y * c, a_nrm.z);
    v_world = p;

    /* The chart's view basis: +y across the plane is squashed by TILT and +z
       out of the plane stands up. Both lean toward the viewer, which is what
       the third row is — and it is also the depth we sort on. */
    const float TILT = 0.40, COS = 0.9165151;
    vec2 sxy = vec2(p.x, p.y * TILT - p.z * COS);
    float key = p.y * COS + p.z * TILT;
    v_n = normalize(vec3(n.x, n.y * TILT - n.z * COS, n.y * COS + n.z * TILT));
    v_m = a_mat;
    v_t = a_tone;

    vec2 px = u_center + sxy * u_scale;
    vec2 cc = (px / u_res) * 2.0 - 1.0;
    /* Depth from the view-space key, mapped into clip space. The range is
       generous because a hull is normalised to about a unit box and the scale
       is applied in screen space, not here. */
    gl_Position = vec4(cc.x, -cc.y, clamp(-key * 0.25, -0.99, 0.99), 1.0);
  }`;

const HULL_FS = `
  precision highp float;
  varying vec3  v_n;
  varying float v_m, v_t;
  varying vec3  v_world;
  uniform vec2  u_light;
  uniform vec3  u_tint;
  uniform vec3  u_accent;   // the family's livery, from HULLS.LIVERY
  uniform float u_lit, u_sel, u_ghost;

  void main(){
    vec3 n = normalize(v_n);
    vec3 L = normalize(vec3(u_light, 0.42));
    float m = v_m;

    /* The same palette dev/bake.js bakes, so near and far hulls agree.
       0 hull · 1 panel · 2 strut · 3 fitting · 4 window · 5 dish
       6 solar · 7 radiator · 8 nozzle throat · 9 radiator tube */
    float alb = 0.86; vec3 hue = vec3(1.0); float emit = 0.0; float gloss = 0.25;
    if (m > 0.5 && m < 1.5) { alb = 0.50; }
    else if (m > 1.5 && m < 2.5) { alb = 0.68; gloss = 0.45; }
    else if (m > 2.5 && m < 3.5) { alb = 1.00; gloss = 0.60; }
    else if (m > 3.5 && m < 4.5) { alb = 0.30; hue = vec3(1.00, 0.84, 0.55); emit = 1.0; }
    else if (m > 4.5 && m < 5.5) { alb = 0.80; gloss = 0.10; }
    else if (m > 5.5 && m < 6.5) { alb = 0.12; hue = vec3(0.30, 0.36, 0.78); gloss = 0.7; }
    else if (m > 6.5 && m < 7.5) { alb = 0.95; gloss = 0.05; }
    else if (m > 7.5 && m < 8.5) { alb = 0.20; hue = vec3(1.00, 0.58, 0.22); emit = 1.0; }
    else if (m > 8.5 && m < 9.5)  { alb = 0.62; hue = vec3(1.00, 0.58, 0.22); emit = 0.10; }
    /* Livery. A painted band, so it is lit like paint and not like a lamp —
       the whole point is that it is quieter than the shape it sits on. */
    else if (m > 9.5 && m < 10.5) { alb = 0.72; hue = u_accent; }
    else if (m > 10.5 && m < 11.5){ alb = 0.20; hue = u_accent; emit = 1.0; }
    /* PLUME, and note the explicit bound. This used to be a bare else, which
       material 0, plain HULL, reaches — because it fails every test above:
       it is not > 0.5. Every hull triangle in the fleet was therefore being
       drawn as translucent additive exhaust, which is why the ships went
       see-through. A default branch in a chain that tests for exact ids is a
       trap; the ids have to be closed at both ends. */
    else if (m > 11.5) {
      /* Emissive, and it never takes light — nothing shades exhaust. v_t
         carries the ramp along its length, in the slot the plate tone uses,
         because a plume has no plating to vary. Alpha rides the same ramp so
         it dissolves into the sky instead of ending. */
      float f = clamp(v_t, 0.0, 1.0);
      gl_FragColor = vec4(u_accent * f * 1.35 * u_lit * u_ghost, f * 0.72 * u_ghost);
      return;
    }

    /* Per-plate tonal variation, computed PER TRIANGLE on the CPU with the
       baker's own hash and interpolated flat across the face. Hashing the
       fragment's position instead — which is what this did first — gives a
       different value at every pixel, so at any real zoom the hull came out
       covered in grain rather than plating. A plate is flat; its tone has to
       be flat with it. */
    /* Halved against the baked path on purpose. The same +/-12% swing that
       reads as quiet plating under the baker's shading is loud here, because
       this pass has no environment term to sit it against — on a big flat
       face like the ring's it came out as a chequerboard. */
    alb *= mix(1.0, v_t, 0.28);

    float dif = max(dot(n, L), 0.0);
    float amb = 0.26 + 0.10 * n.z;
    float v   = alb * (amb + 0.98 * dif);

    /* A tight specular, which is most of what says metal. */
    vec3  V = vec3(0.0, 0.0, 1.0);
    vec3  H = normalize(L + V);
    /* Narrow, and weak. A broad specular on the large flat faces this fleet
       is made of takes an entire panel to the ceiling at once, and everything
       painted on it — plating, panel lines — disappears into the white. */
    v += gloss * pow(max(dot(n, H), 0.0), 64.0) * 0.55;

    vec3 col = mix(vec3(v), v * u_tint, 0.45);
    if (hue.r + hue.g + hue.b < 2.99) col = mix(col, v * hue * 1.9, 0.85);
    col += hue * emit * (0.55 + 0.45 * u_lit);
    col *= u_lit;
    col += vec3(0.22, 0.74, 0.97) * u_sel * 0.16 * (1.0 - 0.55 * dif);
    gl_FragColor = vec4(col * u_ghost, u_ghost);
  }`;

const FS = `
  precision highp float;
  varying vec2  v_uv;
  uniform vec2  u_light;
  uniform vec3  u_tint;
  uniform float u_kind, u_spin, u_lit, u_seed, u_sel, u_ghost, u_focusAlpha;
  uniform float u_style;    // SURFACE_ID from fleet.js
  uniform float u_atmo;     // 0 = airless, 1 = thick atmosphere
  uniform float u_detail;   // screen coverage 0..1 — more surface detail up close
  uniform float u_arch;     // station archetype, ARCH_ID from fleet.js
  uniform float u_craft;    // craft hull, CRAFT_ID from fleet.js
  uniform float u_angle;    // heading, from the body's own velocity

  /* ── the baked hull atlas ────────────────────────────────────────────────
     Stations and craft are rendered from sprites baked by dev/bake.js out of
     the meshes in dev/hulls.js, rather than from the signed distance fields
     below. The SDFs stay as the fallback: the atlas is two PNGs that arrive
     over the network some frames after the first paint, and a chart that draws
     nothing until its textures land is worse than one that draws a simpler
     glyph and sharpens.

     Albedo carries four channels, not a picture: R albedo, G ambient
     occlusion, B accent id, A coverage. The shape lives in the NORMAL map,
     in view space, which is what lets the chart's own sun light a hull — bake
     a lit sprite and every station is lit from the same direction forever,
     which reads as a sticker the moment two of them sit either side of the
     star. */
  uniform vec3  u_accent;   // the family's livery, from HULLS.LIVERY
  uniform sampler2D u_alb, u_nrm;
  uniform vec4  u_cell;     // xy = cell origin in uv, zw = cell size in uv
  uniform float u_hull;     // 0 = atlas not ready for this body, use the SDF
  /* Also declared in the vertex shader, which is where it sizes the quad. The
     two stages share one uniform namespace, so re-declaring it here binds the
     same value — the glyph branches need it to know how big a screen pixel is
     in UV units, for antialiasing. */
  uniform float u_radius;

  float sdBox(vec2 p, vec2 b){ vec2 q = abs(p) - b;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
  #define ADD(dd, pp)      { float _d = (dd); if (_d < d) { d = _d; part = (pp); } }
  #define ADDB(pp2, bb, pp) ADD(sdBox(pp2, bb), pp)

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
  }
  /* Octave budget, set once per fragment from u_detail (screen coverage).
     u_detail used to be uploaded every draw and never read, so a body eight
     pixels across paid for six octaves of noise it could not possibly show.
     Dropping them when the body is small is not just cheaper, it is BETTER —
     an octave finer than a pixel is aliasing, not detail. */
  float gOct = 6.0;

  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++){
      if (float(i) >= gOct) break;
      v += a * vnoise(p); p *= 2.03; a *= 0.5;
    }
    return v;
  }
  float ridged(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++){
      if (float(i) >= gOct) break;
      v += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0)); p *= 2.07; a *= 0.5;
    }
    return v;
  }
  /* Domain warping: sample noise at coordinates that are themselves displaced
     by noise. This is the difference between "grey mottling" and a surface. */
  vec2 warp(vec2 p, float amt){
    return p + amt * vec2(fbm(p + vec2(1.7, 9.2)), fbm(p + vec2(8.3, 2.8)));
  }

  float hash31(vec3 p){
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }

  /* Value noise on a 3D lattice that also returns its own GRADIENT.

     Finite-differencing a noise field costs three evaluations of it; the
     derivative of the interpolation is exact and costs a few multiplies on the
     eight corner samples already fetched. That difference is what makes it
     affordable to shade the terrain BETWEEN the craters, which is most of a
     body's surface and was until now perfectly smooth — one broad fbm on
     albedo and no relief at all, so it lit as a flat wash. */
  vec4 vnoised3(vec3 p){
    vec3 i = floor(p), f = fract(p);
    vec3 u  = f * f * (3.0 - 2.0 * f);
    vec3 du = 6.0 * f * (1.0 - f);
    float a = hash31(i + vec3(0,0,0)), b = hash31(i + vec3(1,0,0));
    float c = hash31(i + vec3(0,1,0)), d = hash31(i + vec3(1,1,0));
    float e = hash31(i + vec3(0,0,1)), g = hash31(i + vec3(1,0,1));
    float h = hash31(i + vec3(0,1,1)), k = hash31(i + vec3(1,1,1));
    float k0 = a,         k1 = b - a,     k2 = c - a,     k3 = e - a;
    float k4 = a - b - c + d;
    float k5 = a - b - e + g;
    float k6 = a - c - e + h;
    float k7 = -a + b + c - d + e - g - h + k;
    float v = k0 + k1*u.x + k2*u.y + k3*u.z
            + k4*u.x*u.y + k5*u.x*u.z + k6*u.y*u.z + k7*u.x*u.y*u.z;
    vec3 gr = vec3(
      du.x * (k1 + k4*u.y + k5*u.z + k7*u.y*u.z),
      du.y * (k2 + k4*u.x + k6*u.z + k7*u.x*u.z),
      du.z * (k3 + k5*u.x + k6*u.y + k7*u.x*u.y));
    return vec4(v, gr);
  }

  /* Ridged multifractal terrain on the sphere, value and gradient together.
     Octaves come off the same u_detail budget as everything else, so a body
     eight pixels across does not pay for relief it cannot show. */
  vec4 terrain3(vec3 dir, float freq, float seed, float oct){
    vec4 acc = vec4(0.0);
    float amp = 0.5, f = freq;
    for (int i = 0; i < 4; i++){
      if (float(i) >= oct) break;
      vec4 n = vnoised3(dir * f + seed);
      acc.x   += amp * n.x;
      acc.yzw += amp * n.yzw * f;      // chain rule through the frequency
      f *= 2.17; amp *= 0.5;
    }
    return acc;
  }

  vec3 hash33(vec3 p){
    p = vec3(dot(p, vec3(127.1, 311.7,  74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
  }
  /* d/dx of smoothstep, for the analytic crater gradient below. */
  float dsmooth(float a, float b, float x){
    float t = clamp((x - a) / (b - a), 0.0, 1.0);
    return 6.0 * t * (1.0 - t) / (b - a);
  }

  /* Jittered impact craters, placed IN 3D ON THE SPHERE.

     This used to run on a (lon, lat) sheet, which is an equirectangular map
     wrapped round a ball: cells converge at the poles, so craters smeared into
     wide arcs across the top and bottom of every body, and the field slid in
     longitude as a flat texture behind a circular mask rather than turning with
     a solid. A 3D cell grid has no poles and no seam — a crater centre is just a
     point in space, and one whose cell sits off the shell falls outside its own
     radius and is skipped.

     Returns (height, rim mask) and writes the field's GRADIENT, because the
     height is worthless for shading unless it becomes a normal. A crater is a
     bowl with a raised rim; both terms are radial, so their slope is exact and
     accumulates in this same loop — no extra taps, no finite differences. */
  vec2 craters3(vec3 dir, float density, float seed, out vec3 grad){
    vec3 p = dir * density;
    vec3 ip = floor(p), f = fract(p);
    float h = 0.0, rim = 0.0;
    grad = vec3(0.0);
    for (int z = -1; z <= 1; z++){
      for (int y = -1; y <= 1; y++){
        for (int x = -1; x <= 1; x++){
          vec3 g = vec3(float(x), float(y), float(z));
          vec3 o = hash33(ip + g + seed);
          if (o.z < 0.42) continue;                  // not every cell is cratered
          float rad = 0.06 + 0.62 * pow(o.x, 3.0); // power law: many small, few huge
          vec3  rel = g + o - f;                     // sample → centre, in cells
          float len = length(rel);
          float d   = len / rad;
          if (d < 1.25 && len > 1e-5) {
            float dm   = min(d, 1.0);
            float bowl = -0.55 * (1.0 - dm * dm);
            float rm   = smoothstep(0.70, 0.96, d) * (1.0 - smoothstep(0.96, 1.25, d));
            h   += bowl + rm * 0.85;
            rim  = max(rim, rm);

            /* dh/dd for the two terms, then chain onto d(d)/d(dir). The sample
               moves away from the centre, so the radial unit vector is -rel. */
            float dBowl = (d < 1.0) ? 1.1 * dm : 0.0;
            float dRim  = dsmooth(0.70, 0.96, d) * (1.0 - smoothstep(0.96, 1.25, d))
                        - smoothstep(0.70, 0.96, d) * dsmooth(0.96, 1.25, d);
            grad += (dBowl + dRim * 0.85) * (-rel / len) * (density / rad);
          }
        }
      }
    }
    return vec2(h, rim);
  }

  void main(){
    /* Two octaves for a speck, six for a body filling the screen. The ramp is
       deliberately steep at the bottom: almost every body on a zoomed-out
       chart is tiny, and that is the case worth making cheap. */
    gOct = clamp(2.0 + 26.0 * u_detail, 2.0, 6.0);

    float rr = dot(v_uv, v_uv);
    float r = sqrt(rr);
    float z = sqrt(max(0.0, 1.0 - rr));
    vec3  N = vec3(v_uv.x, v_uv.y, z);
    vec3  L = normalize(vec3(u_light, 0.10));

    /* ── hulls, from the atlas ─────────────────────────────────────────
       Everything a station or craft needs is in two texture reads. Craft are
       baked at 24 headings and the right frame is chosen on the CPU, so there
       is no rotation to do here — a sprite rotated in the shader would rotate
       its baked lighting with it, which is exactly the sticker problem the
       view-space normals exist to avoid. */
    if (u_kind > 5.5 && u_hull > 0.5) {
      /* v_uv.y runs DOWN the screen, and the baker writes its rows the same
         way, so the sprite maps straight across with no flip. */
      vec2 q = v_uv * 0.5 + 0.5;
      if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) discard;
      vec2 uv = u_cell.xy + q * u_cell.zw;

      vec4 A = texture2D(u_alb, uv);
      float cov = A.a;
      if (cov <= 0.02) discard;
      vec4 Nt = texture2D(u_nrm, uv);
      vec3 n  = normalize(Nt.xyz * 2.0 - 1.0);

      /* The chart's own sun, leaning a little toward the viewer so a hull is
         never completely flat-on to its own light. */
      vec3  L   = normalize(vec3(u_light, 0.42));
      float dif = max(0.0, dot(n, L));
      float ao  = A.g;
      /* AO multiplies the AMBIENT, never the key. Occlusion blocks the sky; it
         does not block the sun, and applying it to everything is the usual way
         baked AO ends up looking like dirt. */
      float v = A.r * (0.30 * ao + 1.20 * dif * (0.35 + 0.65 * ao));

      /* Neutral, then tinted by the body — the atlas is baked colourless so
         the fleet keeps one palette and a hull belongs to its world. */
      vec3 col = mix(vec3(v), v * u_tint, 0.45);

      /* Accent ids: a hue a material carries whether or not it emits. Windows
         and exhaust glow; solar cells only tint. */
      float acc = floor(A.b * 255.0 / 24.0 + 0.5);
      vec3  hue = vec3(1.0);
      if (acc > 0.5 && acc < 1.5) hue = vec3(1.00, 0.84, 0.55);   // window
      else if (acc > 1.5 && acc < 2.5) hue = vec3(1.00, 0.58, 0.22); // hot metal
      else if (acc > 4.5 && acc < 5.5) hue = vec3(0.30, 0.36, 0.78); // solar
      else if (acc > 5.5) hue = u_accent;                            // livery
      if (acc > 0.5) col = mix(col, v * hue * 1.9, 0.85);
      col += hue * Nt.a * (0.55 + 0.45 * u_lit);                   // emissive

      col *= u_lit;
      /* Selection has to be far gentler here than on the glyphs. The same
         0.55 flood was tuned against a silhouette a few pixels across; on a
         hull that fills the screen it washed the entire sprite cyan and threw
         away every bit of the shading. Lift the unlit side rather than the
         whole thing, so selection reads as a light on the ship. */
      col += vec3(0.22, 0.74, 0.97) * u_sel * 0.16 * (1.0 - 0.55 * dif);
      gl_FragColor = vec4(col * u_ghost, cov * u_ghost);
      return;
    }

    /* ── craft ─────────────────────────────────────────────────────────
       A machine named for something that is not a celestial body has no
       business being drawn as a world. These ride the same orbits as vessels,
       and unlike a station a craft POINTS WHERE IT IS GOING — the hull is
       rotated into the body's own velocity, which is most of what makes it
       read as a ship rather than a box. */
    if (u_kind > 6.5) {
      float ca = cos(u_angle), sa = sin(u_angle);
      vec2 p = vec2(v_uv.x * ca + v_uv.y * sa, -v_uv.x * sa + v_uv.y * ca);
      float d = 1e9, part = 0.0;

      if (u_craft < 0.5) {              /* tender — blunt working hull */
        ADDB(p - vec2( 0.05, 0.00), vec2(0.42, 0.17), 0.0)
        ADDB(p - vec2( 0.52, 0.00), vec2(0.14, 0.08), 0.0)
        ADDB(p - vec2(-0.34, 0.00), vec2(0.13, 0.22), 2.0)
        ADDB(p - vec2(-0.05, 0.31), vec2(0.26, 0.05), 1.0)
        ADDB(p - vec2(-0.05,-0.31), vec2(0.26, 0.05), 1.0)
        ADD(length(p - vec2(0.24, -0.27)) - 0.10, 3.0)
      } else if (u_craft < 1.5) {       /* courier — slender and quick */
        ADDB(p, vec2(0.54, 0.085), 0.0)
        ADDB(p - vec2( 0.64, 0.00), vec2(0.16, 0.042), 0.0)
        ADDB(p - vec2(-0.28, 0.17), vec2(0.24, 0.032), 1.0)
        ADDB(p - vec2(-0.28,-0.17), vec2(0.24, 0.032), 1.0)
        ADDB(p - vec2(-0.56, 0.00), vec2(0.10, 0.13), 2.0)
      } else {                          /* derelict — holed, canted, one spar */
        ADDB(p - vec2( 0.02, 0.00), vec2(0.36, 0.14), 0.0)
        ADDB(p - vec2(-0.40, 0.07), vec2(0.11, 0.09), 2.0)
        ADDB(p - vec2( 0.12, 0.28), vec2(0.30, 0.032), 1.0)
      }
      // same pixel-size antialiasing as the stations, and for the same reason:
      // minor craft hulls are ~3.8px at zoom 100
      float px  = 1.0 / max(u_radius, 1.0);
      float cov = 1.0 - smoothstep(-px, px, d);
      /* a hole punched clean through the derelict's hull */
      if (u_craft > 1.5)
        cov *= smoothstep(0.11 - px, 0.11 + px, length(p - vec2(0.15, -0.02)));
      if (cov <= 0.004) discard;

      float side = dot(vec2(ca, sa), u_light);
      float lit  = 0.30 + 0.70 * smoothstep(-0.65, 0.85, side);
      vec3  col  = u_tint * lit;
      if (part > 0.5 && part < 1.5) col *= 0.62;
      if (part > 1.5 && part < 2.5) col *= 0.78;
      if (part > 2.5)               col *= 1.14;
      col += vec3(0.80, 0.86, 0.95) * smoothstep(0.05, 0.0, abs(d)) * (0.20 + 0.40 * lit);
      col += vec3(0.22, 0.74, 0.97) * u_sel * 0.55;
      gl_FragColor = vec4(col * u_lit * u_ghost, cov);
      return;
    }

    /* ── stations ──────────────────────────────────────────────────────
       Off-the-shelf services keep their product names, so they render as
       structures, not bodies. Each compose shell gets its own ARCHETYPE, so
       the silhouette tells you what kind of thing it is before you read a
       label: relays at the edge, sensor booms for monitoring, radiator farms
       for AI, a docking ring for home/gateway services. Built from signed distance fields so
       the edges antialias and the hull can carry a rim highlight. */
    if (u_kind > 5.5) {
      vec2 p = v_uv;
      float d = 1e9, part = 0.0;
      float v1 = fract(u_seed * 0.0137), v2 = fract(u_seed * 0.0291);
      float a = u_arch;

      if (a < 0.5) {                       /* truss — the generic hull */
        ADDB(p, vec2(0.24, 0.34), 0.0)
        ADDB(p, vec2(0.44, 0.05), 2.0)
        ADDB(p - vec2( 0.66, 0.0), vec2(0.28, 0.11), 1.0)
        ADDB(p - vec2(-0.66, 0.0), vec2(0.28, 0.11), 1.0)
      } else if (a < 1.5) {                /* relay — mast and dish, the edge */
        ADDB(p, vec2(0.17, 0.22), 0.0)
        ADDB(p - vec2(0.0, 0.34), vec2(0.035, 0.34), 2.0)
        float dish = length((p - vec2(0.0, -0.52)) * vec2(1.0, 1.7)) - 0.30;
        float cut  = length((p - vec2(0.0, -0.62)) * vec2(1.0, 1.7)) - 0.30;
        ADD(max(dish, -cut), 3.0)
        ADDB(p - vec2(0.0, 0.16), vec2(0.40, 0.028), 2.0)
      } else if (a < 2.5) {                /* stack — ops modules on a spine */
        ADDB(p - vec2(0.0,-0.44), vec2(0.30, 0.16), 0.0)
        ADDB(p,                    vec2(0.24, 0.15), 0.0)
        ADDB(p - vec2(0.0, 0.42), vec2(0.18 + 0.06 * v1, 0.13), 0.0)
        ADDB(p, vec2(0.045, 0.70), 2.0)
        ADDB(p - vec2( 0.44, 0.0), vec2(0.16, 0.05), 1.0)
      } else if (a < 3.5) {                /* sensor — booms and instrument pods */
        ADDB(p, vec2(0.19, 0.19), 0.0)
        ADDB(p, vec2(0.86, 0.022), 2.0)
        ADDB(p, vec2(0.022, 0.62), 2.0)
        ADD(length(p - vec2( 0.84, 0.0)) - 0.10, 3.0)
        ADD(length(p - vec2(-0.84, 0.0)) - 0.08, 3.0)
        ADD(length(p - vec2( 0.0, -0.60)) - 0.09, 3.0)
      } else if (a < 4.5) {                /* hab — compact pressurised drum */
        ADD(length(max(abs(p * vec2(1.0, 1.55)) - vec2(0.24, 0.20), 0.0)) - 0.16, 0.0)
        ADDB(p - vec2( 0.54, 0.0), vec2(0.20, 0.07), 1.0)
        ADDB(p - vec2(-0.54, 0.0), vec2(0.20, 0.07), 1.0)
      } else if (a < 5.5) {                /* wing — big solar arrays, the apps */
        ADDB(p, vec2(0.15, 0.26), 0.0)
        ADDB(p, vec2(0.30, 0.035), 2.0)
        ADDB(p - vec2( 0.62, 0.0), vec2(0.34, 0.26 + 0.06 * v2), 1.0)
        ADDB(p - vec2(-0.62, 0.0), vec2(0.34, 0.26 + 0.06 * v2), 1.0)
      } else if (a < 6.5) {                /* radiator — heat rejection = compute */
        ADDB(p, vec2(0.16, 0.20), 0.0)
        ADDB(p, vec2(0.86, 0.018), 2.0)
        for (int i = 0; i < 4; i++) {
          float fy = (float(i) - 1.5) * 0.30;
          ADDB(p - vec2(0.0, fy), vec2(0.72, 0.045), 1.0)
        }
      } else {                             /* ring — rotating habitat / gateway wheel */
        float ring = abs(length(p) - 0.66) - 0.10;
        ADD(ring, 1.0)
        ADDB(p, vec2(0.19, 0.19), 0.0)
        ADDB(p, vec2(0.66, 0.030), 2.0)
        ADDB(p, vec2(0.030, 0.66), 2.0)
      }

      /* Antialias the silhouette against its OWN pixel size.

         A hard discard is fine on a 40px hull and is noise on a 2px one: the
         station first draws at ~1px radius, so as it orbits, sub-pixel motion
         flips each pixel in and out of the glyph and the whole thing crawls.
         u_radius is in device pixels and v_uv spans ±1 across it, so one pixel
         is exactly 1.0/u_radius in these units — no derivatives extension
         needed, and it is exact rather than estimated. */
      float px  = 1.0 / max(u_radius, 1.0);
      float cov = 1.0 - smoothstep(-px, px, d);
      if (cov <= 0.004) discard;

      vec2  n2   = p / max(length(p), 0.001);
      float side = dot(n2, u_light);
      float lit  = 0.24 + 0.76 * smoothstep(-0.60, 0.85, side);
      vec3  base = u_tint;
      if (part > 0.5 && part < 1.5) base *= 0.58;              // panels/fins darker
      if (part > 1.5 && part < 2.5) base *= 0.74;              // structure
      if (part > 2.5)               base *= 1.12;              // dishes and pods
      vec3 col = base * lit * u_lit;

      /* a bright edge picks the silhouette out against a lit planet */
      col += vec3(0.80, 0.86, 0.95) * smoothstep(0.045, 0.0, abs(d)) * (0.18 + 0.42 * lit);
      /* sun glint off a panel face */
      if (part > 0.5 && part < 1.5 && side > 0.45)
        col += vec3(0.95, 0.88, 0.70) * pow(side, 6.0) * 0.55;
      col += vec3(0.22, 0.74, 0.97) * u_sel * 0.55;
      col *= u_ghost;
      gl_FragColor = vec4(col, cov);
      return;
    }

    /* Everything below is drawn as a DISC, so the unit circle is its silhouette
       and clipping to it is what gives the shape its edge. Stations and craft
       returned above precisely because that is not true of them: their edge is
       the SDF's, and cutting it to this circle was shaving the antialias band
       off the smallest glyphs — 13% of a truss and 17% of a wing at the 2.5px
       station floor, on the outermost pixels, which is where a soft edge has to
       be soft. Kept low in the function rather than deleted: a world with no
       clip is a square. */
    /* ── the air OUTSIDE the body ──────────────────────────────────────
       An atmosphere does not stop at the silhouette; that is the one place you
       are guaranteed to be looking through the most of it. This used to be a
       thin rim drawn INSIDE the disc — pow(1-z, 3.2) is a hairline, which is
       why six bodies were carrying atmo 1.0 and none of them looked like it.
       The quad already has room (the vertex shader grows it by u_atmo), so the
       shell is drawn out here where it belongs, brightest where the sunlight
       is coming towards you through it. */
    float shell = 0.17 * u_atmo;
    if (rr > 1.0) {
      if (u_atmo < 0.02 || r > 1.0 + shell) discard;
      float t    = (r - 1.0) / max(shell, 1e-4);
      float dens = exp(-t * 2.6) * (1.0 - t);       // falls off, and ends clean
      vec2  outw = v_uv / r;
      float side = dot(outw, normalize(u_light));
      // forward scattering: the limb you are looking through toward the sun
      /* Steeply asymmetric on purpose. Air is only bright where it is being lit
         THROUGH, so the halo belongs on the sunward limb and should all but
         vanish round the night side — a ring of even brightness reads as a glow
         effect stuck on the body rather than as atmosphere. */
      float fwd  = 0.04 + 0.96 * pow(smoothstep(-0.55, 0.95, side), 1.7);
      vec3  sky  = mix(vec3(0.42, 0.60, 0.95), u_tint, 0.60);
      vec3  warm = vec3(1.00, 0.62, 0.36);
      // and it reddens where the light is grazing, which is what a sunset is
      sky = mix(sky, warm, smoothstep(0.55, -0.1, side) * 0.55);
      gl_FragColor = vec4(sky * fwd * u_lit * u_ghost,
                          dens * fwd * u_atmo * 0.62 * u_ghost * u_focusAlpha);
      return;
    }

    /* reserved / unallocated — dashed outline, no body */
    if (u_kind > 4.5) {
      float ring = smoothstep(0.80, 0.96, r) * (1.0 - smoothstep(0.96, 1.0, r));
      float ang  = atan(v_uv.y, v_uv.x);
      float dash = step(0.42, fract(ang * 2.8));
      float a = ring * dash * (0.42 + u_sel * 0.5) * u_ghost;
      if (a < 0.01) discard;
      gl_FragColor = vec4(u_tint, a);
      return;
    }

    /* stars — emissive, no terminator */
    if (u_kind < 0.5) {
      float core = smoothstep(1.0, 0.0, r);
      vec3  c = mix(u_tint, vec3(1.0), pow(core, 2.6));
      gl_FragColor = vec4(c, min(1.0, pow(core, 1.35) * 1.7) * u_focusAlpha);
      return;
    }

    float lon = atan(N.x, N.z) + u_spin;
    float lat = asin(clamp(N.y, -1.0, 1.0));
    vec2  uv  = vec2(lon, lat);
    float sd  = u_seed;
    vec3  surf;
    float rough = 1.0;      // how hard the terminator falls
    float gloss = 0.0;      // specular strength

    /* The same point as uv, but as a direction in the body's own frame —
       spun about the pole rather than slid along a texture axis. This is what
       the 3D crater field is sampled with. */
    float cs = cos(u_spin), sn = sin(u_spin);
    vec3  dir = vec3(N.x * cs + N.z * sn, N.y, N.z * cs - N.x * sn);

    /* Surface relief, in body space, accumulated by whichever branch runs. It
       becomes a normal at the end — that is the whole point of computing a
       height field at all. */
    vec3  relief = vec3(0.0);
    float bump   = 0.0;     // how much of it to believe, per surface type

    /* How much of a crater is PAINTED rather than lit. The albedo terms below
       were written when nothing else could suggest depth, so they had to carry
       the whole illusion — a dark bowl and a bright rim, drawn on. Now the
       normal does that work, and running both at full strength counts the
       depth twice: the shading darkens the far wall and the albedo darkens it
       again, which is what made the field shout. Held low and left in, because
       a little painted contrast is real — crater floors and fresh ejecta do
       differ in albedo, they just do not differ THAT much. */
    const float PAINT = 0.42;

    /* Terrain between the craters. Craters are the loud feature but they cover
       a fraction of a surface; everything around them was a single broad fbm on
       albedo with no relief, which lights as one flat tone and is what made the
       bodies read as painted balls once the craters stopped shouting. Two or
       three octaves of relief, gradient included, so the whole surface takes
       the light and not just the holes in it. */
    float tOct = clamp(1.0 + 22.0 * u_detail, 1.0, 3.0);
    vec4  terr = vec4(0.0);
    if (u_kind > 0.5 && u_kind < 1.5) {
      terr = vec4(0.0);                       // gas giants get theirs from bands
    } else if (u_kind < 4.5) {
      terr = terrain3(dir, 3.4, sd, tOct);
    }
    float tval = terr.x;                      // 0..1-ish, for albedo

    if (u_kind < 1.5) {
      /* ── gas giant ── bands from latitude, curdled by domain warping, with
         vortex chains riding the shear lines rather than one stamped oval */
      /* What makes a gas giant read is SHEAR, not stripes. Neighbouring bands
         run in opposite directions at different speeds, and the turbulence
         between them is dragged out into filaments parallel to the equator —
         so the noise has to be advected along longitude by an amount that
         varies with latitude. This was a plain sine in latitude with a gentle
         warp, which is why it came out as a soft cream wash.

         Bands are also not evenly spaced. Their edges come from a warped
         latitude coordinate, so belts and zones differ in width the way real
         ones do, and the boundaries wander instead of ruling straight lines. */
      float latw = lat + 0.10 * fbm(vec2(lon * 0.7 + sd, lat * 1.6));
      float jet  = sin(latw * 8.5);                 // alternating band direction
      float shear = 2.4 * jet * (1.0 - 0.45 * abs(sin(lat)));

      // turbulence, smeared along the band it belongs to
      vec2  q = vec2(lon * 1.25 + sd + shear, latw * 7.0);
      float turb = fbm(warp(q, 0.85));
      float band = sin(latw * 8.5 + turb * 2.8);

      /* Belts dark, zones bright, and a wider spread than before — the old
         range spanned barely a third of the tint and read as one colour. */
      float v = 0.5 + 0.34 * band + 0.16 * (turb - 0.5);
      surf = mix(u_tint * 0.44, u_tint * 1.38, clamp(v, 0.0, 1.0));

      // fine filaments, stretched hard in longitude and only along the flow
      float fil = fbm(vec2(lon * 5.5 + shear * 1.6, latw * 22.0));
      surf *= 0.93 + 0.14 * fil;

      /* Vortices ride the band BOUNDARIES, where the shear is greatest, rather
         than being sprinkled anywhere. Elongated in longitude, as they are when
         the flow is stretching them. */
      float edge = 1.0 - abs(jet);                  // 1 at a band boundary
      float ov = fbm(vec2(lon * 2.6 - sd * 0.3, latw * 9.0) + 4.0);
      float storms = smoothstep(0.60, 0.84, ov) * smoothstep(0.35, 0.85, edge);
      surf = mix(surf, u_tint * 1.34, storms * 0.42);

      /* The Great Red Spot belongs to JUPITER. It was drawn on every gas giant,
         which put a salmon oval on Neptune — so it is behind a surface style
         now, the same mechanism that tells a rock from an ice moon. An oval
         with a bright collar and an internal swirl; a stamped ellipse reads as
         a decal. */
      if (u_style > 5.5) {
        vec2  sp = vec2(lon - 0.85, (lat + 0.30) * 2.4);
        float sd2 = length(vec2(sp.x * 0.62, sp.y));
        float swirl = fbm(vec2(atan(sp.y, sp.x * 0.62) * 1.9 + sd2 * 5.0, sd2 * 6.0));
        vec3  spot  = mix(vec3(0.70, 0.30, 0.20), vec3(0.85, 0.48, 0.30), swirl);
        surf = mix(surf, spot, smoothstep(0.42, 0.08, sd2) * 0.86);
        surf = mix(surf, u_tint * 1.30, smoothstep(0.52, 0.40, sd2) * 0.30);
      }

      /* Cloud tops get a little form. Not terrain — there is no ground — but
         the band structure does have depth, and lighting it stops the giants
         reading as flat next to the rocks. */
      relief = vec3(band * 0.55 + fil * 0.30, turb - 0.5, jet * 0.35);
      bump   = 0.5;
      rough  = 0.55;
    } else if (u_style > 1.5 && u_style < 2.5) {
      /* ── icy (Europa) ── high albedo, long curved lineae, chaos terrain ── */
      vec2 w = warp(vec2(lon * 1.5 + sd, lat * 2.0), 0.85);
      float base = 0.86 + 0.14 * fbm(w * 2.0);
      float lineae = smoothstep(0.72, 0.98, ridged(w * 2.6));
      float chaos  = smoothstep(0.66, 0.90, fbm(vec2(lon * 4.0 + sd, lat * 5.0)));
      surf = u_tint * base;
      surf = mix(surf, vec3(0.52, 0.31, 0.24), lineae * 0.55);
      surf = mix(surf, u_tint * 0.78, chaos * 0.30);
      gloss = 0.55; rough = 0.8;
    } else if (u_style > 2.5 && u_style < 3.5) {
      /* ── sulfur / volcanic (Io) ── paterae, lava floors, sulfur plains ── */
      vec2 w = warp(vec2(lon * 1.3 + sd, lat * 1.9), 0.5);
      float plains = fbm(w * 2.2);
      surf = mix(vec3(0.86, 0.72, 0.30), vec3(0.96, 0.90, 0.62), plains);
      vec3 cg; vec2 cr = craters3(dir, 5.0, sd, cg);
      relief += cg; bump = 0.5;      // paterae are shallow floors, not deep pits
      float patera = smoothstep(0.15, 0.55, -cr.x);
      surf = mix(surf, vec3(0.22, 0.12, 0.09), patera * 0.85);
      surf = mix(surf, vec3(0.95, 0.44, 0.12), smoothstep(0.45, 0.9, cr.y) * 0.5);
      float sulfur = smoothstep(0.55, 0.85, fbm(vec2(lon * 3.4, lat * 4.2) + 7.0));
      surf = mix(surf, vec3(0.90, 0.30, 0.22), sulfur * 0.22);
      rough = 1.1;
    } else if (u_style > 6.5) {
      /* ── veiled (Venus, Titan) ── a surface you cannot see.

         Both were regolith with atmo 1.0, which drew them as cratered rocks
         wearing a rim light. Venus has never been seen in visible light: it is
         under an opaque sulfuric acid deck, and its own entry in the roster says
         460 °C under 92 atmospheres. Titan is the only moon with a thick
         atmosphere and is a smooth orange haze ball. What you see IS the cloud
         deck, so the deck is the surface style — atmo stays what it should be,
         the depth of air around a body, not a switch for hiding it. */
      vec2 w = warp(vec2(lon * 1.05 + sd, lat * 2.1), 0.75);
      float deck  = fbm(w * 1.5);
      float swirl = sin(lat * 4.5 + deck * 3.2) * 0.5 + 0.5;
      surf = mix(u_tint * 0.84, u_tint * 1.12, deck * 0.55 + swirl * 0.45);
      // faint upper-level streaks, stretched the way a super-rotating deck is
      surf *= 0.97 + 0.06 * fbm(vec2(lon * 3.2 + sd, lat * 9.0));
      rough = 0.30;          // thick air scatters the terminator very soft
      bump  = 0.0;
      terr.yzw = vec3(0.0);  // no ground to light
    } else if (u_style > 4.5 && u_style < 5.5) {
      /* ── terran (Terra) ── the one body in the chart you are already on.
         It was regolith with an atmosphere bolted on, which drew the machine
         everything is run from as a cratered rock wearing a blue haze. A world
         with oceans is not a rock with a filter: what makes it read is the
         SPLIT — a sea level that sorts one continuous height field into water
         and land, so coastlines are a consequence of the terrain rather than a
         pattern, and the two sides answer light completely differently. */
      float land = terr.x * 1.35 + 0.5 * fbm(warp(vec2(lon * 0.9 + sd, lat * 1.4), 0.7));
      /* Sea level is placed to leave roughly seven tenths of the surface under
         water, which is the single number that decides whether this reads as
         Earth or as a swamp planet with lakes. */
      float sea  = smoothstep(0.88, 0.97, land);          // 0 water · 1 land
      /* Depth reads through clear water on the shelf and darkens off it. */
      vec3 ocean = mix(vec3(0.020, 0.058, 0.16), vec3(0.06, 0.24, 0.38),
                       smoothstep(0.62, 0.90, land));
      /* Green where it is wet and low, arid ochre in the continental interiors. */
      float arid = smoothstep(0.30, 0.85, fbm(vec2(lon * 2.1 + 12.0, lat * 2.6)));
      vec3 ground = mix(vec3(0.16, 0.28, 0.14), vec3(0.42, 0.35, 0.20), arid);
      ground = mix(ground, vec3(0.30, 0.34, 0.22), smoothstep(0.70, 0.95, land));
      /* Ice caps by latitude, ragged at their edge so they are not two discs. */
      float ice = smoothstep(0.80, 0.99, abs(sin(lat)) + 0.10 * fbm(vec2(lon * 4.0, lat * 3.0)));
      surf = mix(ocean, ground, sea);
      surf = mix(surf, vec3(0.90, 0.93, 0.96), ice);
      /* Weather sits ABOVE the surface, so it ignores the coastline entirely —
         that independence is most of what makes a planet look alive. */
      float cloud = smoothstep(0.52, 0.78, fbm(warp(vec2(lon * 1.7 - sd * 0.4, lat * 2.3), 1.1) * 1.6));
      surf = mix(surf, vec3(0.94, 0.95, 0.97), cloud * 0.72);
      /* Only the sea is glossy, and only where it is not clouded over. */
      gloss = (1.0 - sea) * (1.0 - cloud) * 0.85;
      rough = 0.9;
      // land takes the relief; water is flat and cloud hides what is under it
      bump = sea * (1.0 - cloud) * 0.9;
      terr.yzw *= sea * (1.0 - cloud);
    } else if (u_style > 3.5 && u_style < 4.5) {
      /* ── grooved (Ganymede) ── dark ancient terrain cut by bright sulci ── */
      float dark = smoothstep(0.42, 0.58, fbm(warp(vec2(lon * 1.2 + sd, lat * 1.7), 0.6) * 1.8));
      surf = mix(u_tint * 0.55, u_tint * 1.05, dark);
      float sulci = smoothstep(0.60, 0.92, ridged(vec2(lon * 5.5 + sd, lat * 2.2)));
      surf = mix(surf, u_tint * 1.28, sulci * 0.55 * dark);
      vec3 cg; vec2 cr = craters3(dir, 7.0, sd + 3.0, cg);
      relief += cg; bump = 0.75;
      surf *= 1.0 + cr.x * 0.30 * PAINT;
      surf = mix(surf, vec3(0.92, 0.94, 0.97), smoothstep(0.5, 1.0, cr.y) * 0.30 * PAINT);
    } else if (u_style > 0.5 && u_style < 1.5) {
      /* ── heavily cratered (Callisto, Mercury, Charon) ── the oldest surfaces
         in the system: saturated with impacts, plus bright ejecta rays ── */
      float base = 0.55 + 0.45 * fbm(vec2(lon * 2.2 + sd, lat * 3.0));
      surf = u_tint * base;
      float cv = fract(sd * 0.0211);
      vec3 g1; vec2 c1 = craters3(dir, 4.5 + 3.0 * cv, sd, g1);
      // the fine crater pass is a second jittered search — it only earns its
      // cost once the body is big enough to resolve the small craters
      vec3 g2 = vec3(0.0); vec2 c2 = vec2(0.0);
      if (u_detail > 0.05) c2 = craters3(dir, 11.0 + 7.0 * cv, sd + 11.0, g2);
      relief += g1 * 0.7 + g2 * 0.45; bump = 1.0;
      surf *= 1.0 + (c1.x * 0.7 + c2.x * 0.45) * 0.55 * PAINT;
      surf = mix(surf, u_tint * 1.45, smoothstep(0.55, 1.0, max(c1.y, c2.y)) * 0.45 * PAINT);
      // highland/lowland tone follows the terrain, so albedo and relief agree
      surf *= 0.86 + 0.30 * tval;
      rough = 1.25;
    } else {
      /* ── regolith (small bodies, asteroids) ──
         Every parameter is derived from the seed, so two asteroids are not the
         same asteroid in a different colour — which is precisely what the
         previous single recipe produced across seven bodies. */
      float v1 = fract(sd * 0.0137), v2 = fract(sd * 0.0291), v3 = fract(sd * 0.0473);
      float dens  = 5.0 + 9.0 * v1;          // sparse, pitted plains … saturated
      float relf  = 0.25 + 0.45 * v2;        // shallow dust … sharp topography
      float mott  = 1.1  + 2.6 * v3;         // broad albedo patches … fine speckle
      vec2 w = warp(vec2(lon * (1.6 + 2.0 * v2) + sd, lat * (2.4 + 1.6 * v1)), 0.3 + 0.5 * v3);
      float n = fbm(w * mott);
      surf = mix(u_tint * (0.42 + 0.18 * v3), u_tint * (1.10 + 0.20 * v1), n);
      vec3 cg; vec2 cr = craters3(dir, dens, sd + 5.0, cg);
      relief += cg * relf; bump = 0.55 + 0.75 * v2;
      surf *= 1.0 + cr.x * relf * PAINT;
      surf = mix(surf, u_tint * 1.28, smoothstep(0.6, 1.0, cr.y) * (0.20 + 0.25 * v2) * PAINT);
      surf *= 0.90 + 0.20 * fbm(vec2(lon * (6.0 + 6.0 * v1), lat * (7.0 + 5.0 * v3)));
      surf *= 0.86 + 0.30 * tval;
      rough = 1.0 + 0.35 * v2;
    }

    /* ── relief becomes a normal ──────────────────────────────────────
       Until this existed the height field only ever multiplied albedo, so a
       crater was a dark disc with a bright ring painted on it — identical
       whether it sat in full sun or on the terminator, which is exactly what
       made them read as stickers and made a spinning body read as a sliding
       texture. Tilting the normal gives every pit a lit wall and a shadowed
       one, and the sense of a solid comes free from the lighting already here.

       The gradient arrives in body space, so it is spun back into view space
       before use, and its radial component is projected out — only the part
       along the surface can tilt a normal. */
    vec3 total = relief * bump + terr.yzw * 0.62;
    if (dot(total, total) > 0.0) {
      vec3 gv = vec3(total.x * cs - total.z * sn,
                     total.y,
                     total.x * sn + total.z * cs);
      gv -= N * dot(gv, N);
      /* Fade the perturbation out at the limb. There the true normal is nearly
         edge-on and a tilt of any size flips it through the silhouette, which
         sparkles under the sub-pixel drift. */
      N = normalize(N - gv * 0.055 * smoothstep(0.0, 0.35, z));
    }

    /* ── one warm sun. The terminator is the whole design. ── */
    /* Keep the UNCLAMPED cosine as well. Anything that wants to know how far
       past the terminator a pixel is cannot use the clamped one: it pins the
       entire night side to exactly zero, so a band centred on zero covers a
       whole hemisphere rather than a line. */
    float ndl  = dot(N, L);
    float diff = max(ndl, 0.0);
    float term = smoothstep(0.0, 0.30 * rough, diff);

    /* AMBIENT MUST NOT CARRY PAINTED RELIEF.
       Much of what is in surf is not albedo at all — the crater passes above
       write their shading into it (that is what PAINT means), because a bowl
       reads better with its own light baked in than with normals alone. That
       is fine where there IS light. Multiplying the whole of it by a flat
       ambient carried every one of those fake highlights onto the night side,
       so Mercury's dark half came out covered in brightly lit crater rims —
       lighting that no longer had a source.
       So the unlit term uses the body's own base colour instead, keeping only
       a trace of the surface variation. A night side should be a silhouette
       with a hint of texture, not a dimmer copy of the day. */
    vec3  night = mix(surf, u_tint * 0.85, 0.72);
    vec3  col   = surf * term * 1.04 + night * 0.10;

    /* specular — only ice gets a highlight */
    if (gloss > 0.0) {
      vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
      col += vec3(0.85, 0.93, 1.0) * pow(max(dot(N, H), 0.0), 42.0) * gloss * term;
    }

    /* atmosphere — scattering brightens the limb, far more on the lit side.
       Airless bodies get none, and that absence is most of what separates a
       rock from a world. */
    if (u_atmo > 0.001) {
      /* Airmass: looking at the limb you are looking through far more air than
         at the centre of the disc. The old exponent of 3.2 crushed that into a
         hairline at the very edge; 1.7 lets the haze reach into the disc the
         way it actually does, and the ground fades into it near the edge. */
      float air  = pow(1.0 - z, 1.7);
      vec3  sky  = mix(vec3(0.42, 0.60, 0.95), u_tint, 0.30);
      vec3  warm = vec3(1.00, 0.68, 0.40);   // gold, not rust

      /* Sunset. Light reaching the terminator has taken the longest path
         through the atmosphere, so it arrives red — the band of warm colour
         along the day/night line is the single cue that most says "this world
         has air" rather than "this rock has a rim light". */
      /* A band, and only where you are looking THROUGH the air.
         Reddening the surface all along the terminator drew a rust stripe
         straight down the middle of Terra — the exact Martian streak this was
         supposed to have stopped doing. The physics says why: sunlight
         reddens because of the distance it travels through atmosphere, and
         looking down at the terminator from above you are barely looking
         through any. The long path is at the LIMB, which is why in every
         photograph from orbit the sunset is a thin gold arc around the edge
         of the disc and never a band across its face.
         So the same band, multiplied by airmass. */
      float graze = smoothstep(0.26, 0.0, ndl) * smoothstep(-0.12, 0.02, ndl);
      col = mix(col, col * 0.70 + warm * 0.30, graze * air * u_atmo * 0.95);

      col += sky * air * u_atmo * (0.20 + 0.80 * term) * 1.35;
      // haze thickens toward the limb until the surface is no longer readable
      col = mix(col, sky * (0.28 + 0.72 * term), air * u_atmo * 0.42);
    }

    col *= mix(0.70, 1.0, z);      /* limb darkening */
    col *= u_lit * u_ghost;

    if (u_sel > 0.01) {
      float rim = smoothstep(0.86, 1.0, r);
      col += vec3(0.22, 0.74, 0.97) * rim * u_sel * 0.85;
    }

    gl_FragColor = vec4(col, smoothstep(1.0, 0.982, r) * u_focusAlpha);
  }`;
