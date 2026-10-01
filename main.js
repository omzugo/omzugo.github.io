// Wet glass: the screen starts fogged and beaded with water. The cursor (or a
// finger) wipes it clear, water gathers and runs down from the strokes, and
// the fog slowly creeps back.
(() => {
  'use strict';

  // Per-page options live on the canvas as data- attributes.
  const pageOptions = document.getElementById('glass').dataset;
  const pageNumber = (key, fallback = 0) => {
    const value = parseFloat(pageOptions[key]);
    return Number.isNaN(value) ? fallback : value;
  };

  const CONFIG = {
    // Image or video behind the glass, e.g. data-background="media/meadow.mp4".
    // None paints a placeholder scene.
    background: pageOptions.background || '',
    brushSize: 0.047,   // brush radius, as a fraction of the shorter screen side
    refogSeconds: 20,   // roughly how long a stroke stays clear; 0 = never fog back
    dripRate: 1.5,      // average drops shed per brush-width of stroke
    rain: 0.6,          // how hard it rains: 0 = dry glass, 1 = steady rain
    condensation: true,  // a fixed pattern of fine beads on the fog (true) or plain fog (false)
    // Optional softening that hides soft or compressed footage (off by default):
    softness: pageNumber('softness'),  // data-softness: blur, in 1080p pixels, on the footage behind the glass (drops stay sharp)
    streaks: pageNumber('streaks'),    // data-streaks: 0–1, finger streaks smeared along each wipe
    // Optional grading of the footage:
    exposure: pageNumber('exposure'),         // data-exposure: in stops; 0 = unchanged, positive is brighter
    saturation: pageNumber('saturation', 1),  // data-saturation: 1 = unchanged, lower is more muted
    highlights: pageNumber('highlights'),     // data-highlights: 0–1, how much to pull down the brightest areas
    temperature: pageNumber('temperature'),   // data-temperature: -1 (cool) to 1 (warm), 0 = unchanged
  };

  const BLOB_EDGE = 0.46;   // a drop sprite's visible edge, as a fraction of its radius
  const BLUR_DIVISOR = 8;  // fog blur is computed at 1/8 resolution
  const MASK_DIVISOR = 2;  // wipe mask is stored at 1/2 resolution

  const canvas = document.getElementById('glass');
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
  if (!gl) return;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

  // ---------------------------------------------------------------- shaders

  const VERTEX = `#version 300 es
    in vec2 aPos;
    out vec2 vUv;
    void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const HEADER = `#version 300 es
    precision highp float;
    in vec2 vUv;
    out vec4 o;
  `;

  // Fits the background source to the screen like CSS object-fit: cover, and grades it.
  const COVER = HEADER + `
    uniform sampler2D uSrc;
    uniform vec2 uScale;
    uniform float uExposure, uSaturation, uHighlights, uTemperature;
    void main() {
      vec3 c = texture(uSrc, (vUv - 0.5) * uScale + 0.5).rgb * exp2(uExposure);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c *= 1.0 - uHighlights * smoothstep(0.5, 1.0, l);  // leaves shadows and midtones alone
      c *= vec3(1.0 + 0.1 * uTemperature, 1.0, 1.0 - 0.1 * uTemperature);
      o = vec4(c, 1.0);
    }`;

  // One direction of a 9-tap Gaussian, using linear filtering to halve the taps.
  const BLUR = HEADER + `
    uniform sampler2D uSrc;
    uniform vec2 uStep;
    void main() {
      vec3 c = texture(uSrc, vUv).rgb * 0.2270270;
      c += (texture(uSrc, vUv + uStep * 1.3846154).rgb + texture(uSrc, vUv - uStep * 1.3846154).rgb) * 0.3162162;
      c += (texture(uSrc, vUv + uStep * 3.2307692).rgb + texture(uSrc, vUv - uStep * 3.2307692).rgb) * 0.0702703;
      o = vec4(c, 1.0);
    }`;

  // Copies a texture's alpha into every channel (ink canvas -> mask, mask -> resized mask).
  const COPY_ALPHA = HEADER + `
    uniform sampler2D uSrc;
    void main() { o = vec4(texture(uSrc, vUv).a); }`;

  // Softens the brush's hard edge, then merges in the drip trails, which stay sharp.
  const MERGE_INK = HEADER + `
    uniform sampler2D uBrush, uTrails;
    uniform vec2 uRadius;
    void main() {
      float sum = texture(uBrush, vUv).a, total = 1.0;
      for (int ring = 1; ring <= 3; ring++) {
        float r = float(ring) / 3.0, w = exp(-2.0 * r * r);
        for (int i = 0; i < 16; i++) {
          float angle = (float(i) + 0.5 * float(ring)) * 0.3926991;
          sum += texture(uBrush, vUv + vec2(cos(angle), sin(angle)) * r * uRadius).a * w;
          total += w;
        }
      }
      o = vec4(max(sum / total, texture(uTrails, vUv).a));
    }`;

  const SOLID = HEADER + `
    uniform float uAmount;
    void main() { o = vec4(uAmount); }`;

  const GLASS = HEADER + `
    uniform sampler2D uView;       // the scene through clear glass (optionally softened)
    uniform sampler2D uBlur, uMask, uFogDrops;
    uniform sampler2D uWater;      // rain: RG = position within each drop, B = depth, A = soft coverage
    uniform sampler2D uStrokeDir;  // RG: stroke direction as a doubled angle, A: coverage
    uniform float uStreaks;
    uniform vec2 uRes;
    uniform float uUnit;      // canvas pixels per pixel of a 1080p screen
    uniform float uMaxDropR;  // canvas pixels; drop maps store radius as a fraction of this

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                 mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
    }

    float fbm(vec2 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }

    const vec2 RING[8] = vec2[8](
      vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
      vec2(0.7, 0.7), vec2(-0.7, 0.7), vec2(0.7, -0.7), vec2(-0.7, -0.7));

    // Depth cues that make a small drop read as raised rather than as a hole:
    // a darker rim (strongest along the top) where the curved edge bends light
    // away, a faint bright crescent along the bottom where light focuses, and a
    // small soft highlight near the top left. e is the position within the drop,
    // scaled so its visible edge is at 1 (y up).
    vec3 shadeDrop(vec3 lens, vec2 e) {
      float r = length(e);
      float top = clamp(e.y * 0.5 + 0.5, 0.0, 1.0);
      lens *= 1.0 - 0.3 * smoothstep(0.55, 1.0, r) * (0.5 + 0.5 * top);
      lens += 0.1 * smoothstep(0.5, 0.95, r) * smoothstep(0.1, 0.7, -e.y);
      lens += 0.25 * smoothstep(0.4, 0.0, length(e - vec2(-0.3, 0.45)));
      return lens;
    }

    // 0 = fogged, 1 = wiped clear. The threshold varies across the glass, so
    // stroke edges are ragged and fog returns in blotches rather than evenly.
    float clearness(vec2 uv) {
      vec2 p = uv * uRes / uUnit;
      float t = 0.2 + 0.4 * fbm(p / 160.0) + 0.16 * (noise(p / 7.0) - 0.5);
      return smoothstep(t - 0.16, t + 0.16, texture(uMask, uv).r);
    }

    void main() {
      vec2 px = vUv * uRes;
      vec2 texel = 1.0 / uRes;
      vec2 p = px / uUnit;

      float c = clearness(vUv);
      float e = 2.5 * uUnit;
      vec2 grad = vec2(
        clearness(vUv + vec2(e, 0.0) * texel) - clearness(vUv - vec2(e, 0.0) * texel),
        clearness(vUv + vec2(0.0, e) * texel) - clearness(vUv - vec2(0.0, e) * texel));

      vec3 blur = texture(uBlur, vUv).rgb;
      float lum = dot(blur, vec3(0.299, 0.587, 0.114));

      // Fog: diffused, desaturated light, milky where it catches brightness.
      float density = 0.75 + 0.5 * fbm(p / 300.0 + 7.0);
      vec3 fog = mix(blur, vec3(lum), 0.35);
      fog = fog * (1.0 - 0.3 * density) + vec3(0.6, 0.64, 0.7) * (0.14 + 0.5 * lum) * density;

      // Wiped glass, with a water ridge along the wipe's edge that bends the view.
      float ridge = clamp(length(grad), 0.0, 1.0);
      vec2 uvThrough = vUv - grad * 6.0 * uUnit * texel;
      vec3 through = texture(uView, uvThrough).rgb;

      // Finger streaks: a wipe leaves a thin film, smeared along the stroke,
      // with fine lines where the skin's ridges dragged through the water.
      vec4 sd = texture(uStrokeDir, vUv);
      if (uStreaks > 0.0 && sd.a > 0.0) {
        vec2 doubled = (sd.rg * 2.0 - 1.0) * vec2(1.0, -1.0);  // canvas y runs down
        float angle = atan(doubled.y, doubled.x) * 0.5;
        vec2 dir = vec2(cos(angle), sin(angle)), across = vec2(-dir.y, dir.x);
        vec3 smear = vec3(0.0);
        for (int i = -3; i <= 3; i++) smear += texture(uView, uvThrough + dir * float(i) * 2.5 * uUnit * texel).rgb;
        smear /= 7.0;
        float lines = 0.6 * noise(vec2(dot(p, across) / 1.6, dot(p, dir) / 90.0))
                    + 0.4 * noise(vec2(dot(p, across) / 7.0, dot(p, dir) / 200.0) + 31.0);
        lines = smoothstep(0.35, 1.0, lines);
        float k = uStreaks * sd.a;
        through = mix(through, smear, 0.7 * k);
        through += (vec3(0.75, 0.78, 0.82) * (0.25 + lum) - through) * lines * 0.12 * k;
      }
      vec3 col = mix(fog, through * 0.97, c) + ridge * 0.05;

      // Condensation beads on the fogged glass, drawn the same way as the rain
      // below. A bead disappears whole if a wipe or a running drop's path
      // touches any part of it (it checks its center and eight points around
      // its edge). Raindrops absorb beads by wiping their spot (absorbBeads).
      vec4 fd = texture(uFogDrops, vUv);
      vec2 pos = (fd.rg * 2.0 - 1.0) * vec2(1.0, -1.0);  // position within the sprite
      float rad = fd.b * uMaxDropR;                        // the bead's visible radius
      vec2 beadCenter = vUv - pos * (rad / ${BLOB_EDGE}) * texel;
      float present = 0.0;  // whether this bead still exists
      if (fd.a > 0.5) {
        float ringMask = 0.0;
        for (int i = 0; i < 8; i++) {
          vec2 q = beadCenter + RING[i] * vec2(rad, rad * 1.3) * texel;  // beads are a little taller than wide
          ringMask = max(ringMask, texture(uMask, q).r);
        }
        present = (1.0 - clearness(beadCenter)) * (1.0 - smoothstep(0.35, 0.6, ringMask));
      }
      float a = present * clamp(fd.a * 6.0 - 3.0, 0.0, 1.0);
      if (a > 0.0) {
        vec2 refracted = vUv - pos * (192.0 + 192.0 * 0.9 * rad / uMaxDropR) * uUnit * texel;
        vec3 lens = mix(texture(uBlur, refracted).rgb, texture(uView, refracted).rgb, 0.35);
        col = mix(col, shadeDrop(lens * 1.04, pos / ${BLOB_EDGE}), a);
      }

      // Rain, rendered the way Lucas Bebber's Rain & Water Effect does it. Drops
      // are soft blobs cut at a threshold, so neighbours merge like liquid; each
      // shows a bright, blurred, flipped and zoomed-out view of the scene.
      vec4 w = texture(uWater, vUv);
      float wa = clamp(w.a * 6.0 - 3.0, 0.0, 1.0);
      if (wa > 0.0) {
        vec2 offset = (w.rg * 2.0 - 1.0) * vec2(1.0, -1.0);
        vec2 refracted = vUv - offset * (192.0 + 192.0 * w.b) * uUnit * texel;
        vec3 lens = mix(texture(uBlur, refracted).rgb, texture(uView, refracted).rgb, 0.35);
        col = mix(col, lens * 1.04, wa);
      }

      vec2 v = vUv - 0.5;
      col *= 1.0 - dot(v, v) * 0.35;
      col += (hash(px) - 0.5) / 255.0;  // dither against banding
      o = vec4(col, 1.0);
    }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  const vertexShader = compile(gl.VERTEX_SHADER, VERTEX);

  function program(fragment) {
    const p = gl.createProgram();
    gl.attachShader(p, vertexShader);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  const programs = {
    cover: program(COVER),
    blur: program(BLUR),
    copyAlpha: program(COPY_ALPHA),
    mergeInk: program(MERGE_INK),
    solid: program(SOLID),
    glass: program(GLASS),
  };

  // A single triangle that covers the screen.
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // ------------------------------------------------------------ GL helpers

  function texture(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  function target(w, h) {
    const tex = texture(w, h);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  function dispose(t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fb);
  }

  function upload(tex, source) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  // Runs a full-screen pass into `dest` (null = the screen).
  function pass(prog, dest, textures, setUniforms) {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dest ? dest.fb : null);
    gl.viewport(0, 0, dest ? dest.w : W, dest ? dest.h : H);
    Object.entries(textures).forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.u[name], i);
    });
    if (setUniforms) setUniforms(prog.u);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ------------------------------------------------------------- randomness

  function rng(seed) {  // mulberry32: seeded, so the drops land the same way every visit
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const noiseTable = Array.from({ length: 256 }, Math.random);
  function noise1(x) {
    const i = Math.floor(x), f = x - i;
    const a = noiseTable[i & 255], b = noiseTable[(i + 1) & 255];
    return a + (b - a) * f * f * (3 - 2 * f);
  }

  // ----------------------------------------------------------------- drops

  // Drop sprites, after Lucas Bebber's: a soft, slightly teardrop-shaped blob.
  // RG hold each pixel's position within the sprite (which drives the flipped
  // lens view), B a per-sprite value (one sprite per bucket, since B can't vary
  // per drawImage), and A a soft falloff that the shader cuts at 0.5. That puts
  // a drop's visible edge at BLOB_EDGE of the sprite's radius, and makes drops
  // that come close bridge into each other like water.
  const SPRITE_BUCKETS = 32;
  const sprites = Array.from({ length: SPRITE_BUCKETS }, (_, b) => {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = ((x + 0.5) / size) * 2 - 1, ny = ((y + 0.5) / size) * 2 - 1;
        const sy = ny < 0 ? ny / 0.8 : ny;  // the top of a drop falls off faster
        const alpha = Math.exp(-(nx * nx + sy * sy) / (2 * 0.39 * 0.39));
        const i = (y * size + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[i + 2] = (b / (SPRITE_BUCKETS - 1)) * 255;
        img.data[i + 3] = alpha * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  });

  // Draws a condensation bead of visible radius r; B records the radius.
  function drawDrop(ctx, x, y, r, stretch) {
    const b = Math.max(0, Math.min(SPRITE_BUCKETS - 1, Math.round((r / maxDropR) * (SPRITE_BUCKETS - 1))));
    const w = (r / BLOB_EDGE) * 2, h = w * stretch;
    ctx.drawImage(sprites[b], x - w / 2, y - h / 2, w, h);
  }

  // [count on a 16:9 screen, min radius, max radius] in 1080p pixels.
  const FOG_DROPS = [[26000, 0.6, 1.6], [7000, 1.6, 3.2], [900, 3.2, 6.5], [120, 6.5, 12], [15, 12, 20]];

  // Real drops that touch merge, so visible drops never overlap: layers are
  // placed largest first, and a drop that would touch one already placed is
  // skipped. Specks too small to see are free to crowd each other.
  function paintDrops(ctx, layers, seed) {
    const rand = rng(seed);
    const areaFactor = (W / unit) * (H / unit) / (1920 * 1080);
    const cell = maxDropR * 2.5, cols = Math.ceil(W / cell) + 2;
    const grid = new Map();
    const touches = (x, y, r) => {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const [ox, oy, or] of grid.get((cy + dy) * cols + cx + dx) || []) {
            if (Math.hypot(x - ox, y - oy) < (r + or) * 1.35 + unit) return true;
          }
        }
      }
      return false;
    };
    ctx.clearRect(0, 0, W, H);
    for (const [count, rMin, rMax] of [...layers].reverse()) {
      for (let i = 0, n = Math.round(count * areaFactor); i < n; i++) {
        const r = (rMin + (rMax - rMin) * rand() ** 1.5) * unit;
        const x = rand() * W, y = rand() * H, stretch = 1.2 + rand() * 0.15;  // beads sag slightly on vertical glass
        if (touches(x, y, r)) continue;
        if (r >= 2 * unit) {
          const key = Math.floor(y / cell) * cols + Math.floor(x / cell);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push([x, y, r]);
        }
        drawDrop(ctx, x, y, r, stretch);
      }
    }
    beads = { grid, cell, cols };
  }

  // Visible condensation beads, bucketed by position (canvas pixels), so
  // raindrops can find the ones they touch.
  let beads = null;

  // A raindrop that touches a condensation bead absorbs it. The bead's spot on
  // the glass is wiped clear, so it disappears until the fog forms again.
  function absorbBeads(drop) {
    if (!beads) return;
    const x = drop.x * scale, y = drop.y * scale;
    const reach = drop.r * BLOB_EDGE * (drop.spreadX + 1) * scale;  // the drop's visible half-width
    const span = Math.ceil((reach + maxDropR) / beads.cell);
    const cx = Math.floor(x / beads.cell), cy = Math.floor(y / beads.cell);
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        for (const [bx, by, br] of beads.grid.get((cy + dy) * beads.cols + cx + dx) || []) {
          if (Math.hypot(bx - x, (by - y) / 1.5) >= reach + br) continue;
          trailCtx.fillStyle = '#fff';
          trailCtx.beginPath();
          trailCtx.ellipse((bx / scale) * inkScale, (by / scale) * inkScale, (br * 1.2 / scale) * inkScale, (br * 1.6 / scale) * inkScale, 0, 0, Math.PI * 2);
          trailCtx.fill();
          inkDirty = true;
          lastInkTime = performance.now();
        }
      }
    }
  }

  // ------------------------------------------------------------ background

  function paintPlaceholder(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    const rand = rng(11);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const u = Math.min(w, h) / 1000;
    const horizon = h * 0.64;
    const lights = [];

    let g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, '#070b1e');
    g.addColorStop(0.55, '#26224a');
    g.addColorStop(0.85, '#7a3f58');
    g.addColorStop(1, '#e8905c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, horizon);
    g = ctx.createLinearGradient(0, horizon, 0, h);
    g.addColorStop(0, '#2a1d26');
    g.addColorStop(1, '#06070b');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, w, h - horizon);

    // Two rows of buildings with lit windows.
    const windowColors = ['#ffcf7a', '#ffb35c', '#f8e1a8', '#ffd9a0', '#a8d8ff'];
    for (const [shade, minH, maxH] of [['#161629', 0.25, 0.5], ['#0b0b14', 0.12, 0.36]]) {
      for (let x = -20 * u; x < w; ) {
        const bw = (50 + rand() * 150) * u, bh = h * (minH + rand() * (maxH - minH));
        ctx.globalAlpha = 1;
        ctx.fillStyle = shade;
        ctx.fillRect(x, horizon - bh, bw, bh);
        for (let wy = horizon - bh + 12 * u; wy < horizon - 14 * u; wy += 22 * u) {
          for (let wx = x + 8 * u; wx < x + bw - 12 * u; wx += 16 * u) {
            if (rand() > 0.3) continue;
            ctx.globalAlpha = 0.5 + rand() * 0.5;
            ctx.fillStyle = pick(windowColors);
            ctx.fillRect(wx, wy, 8 * u, 12 * u);
          }
        }
        x += bw + rand() * 10 * u;
      }
    }
    ctx.globalAlpha = 1;

    const glow = (x, y, r, color, core) => {
      const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, color);
      gr.addColorStop(core, color);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gr;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };

    // Street lamps.
    for (let x = rand() * 150 * u; x < w; x += (180 + rand() * 90) * u) {
      const y = horizon - (70 + rand() * 50) * u;
      ctx.fillStyle = '#050508';
      ctx.fillRect(x - 1.5 * u, y, 3 * u, horizon - y + 30 * u);
      lights.push([x, y, 70 * u, 'rgba(255,196,120,0.55)', 0.06], [x, y, 7 * u, 'rgba(255,246,225,1)', 0.5]);
    }
    // Neon signs.
    for (let i = 0; i < 4; i++) {
      const x = rand() * w, y = horizon - (60 + rand() * 160) * u;
      const color = pick(['rgba(255,60,160,0.9)', 'rgba(40,230,210,0.9)', 'rgba(255,90,60,0.9)']);
      ctx.fillStyle = color;
      ctx.fillRect(x - 30 * u, y - 4 * u, 60 * u, 8 * u);
      lights.push([x, y, 70 * u, color.replace('0.9', '0.35'), 0.1]);
    }
    // Traffic: tail lights and headlights.
    for (let i = 0; i < 14; i++) {
      const x = rand() * w, y = horizon + (15 + rand() * 70) * u, head = rand() < 0.4;
      const color = head ? 'rgba(255,245,220,0.95)' : 'rgba(255,40,30,0.9)';
      const r = (head ? 9 : 6) * u * (1 + (y - horizon) / (80 * u));
      lights.push([x - r * 2, y, r, color, 0.3], [x + r * 2, y, r, color, 0.3]);
    }

    ctx.globalCompositeOperation = 'lighter';
    for (const [x, y, r, color, core] of lights) {
      glow(x, y, r, color, core);
      // Stretched reflection on the wet street.
      ctx.save();
      ctx.translate(x, horizon + Math.abs(horizon - y) * 0.6 + 20 * u);
      ctx.scale(0.3, 1.8);
      glow(0, 0, r, color.replace(/[\d.]+\)$/, '0.25)'), core);
      ctx.restore();
    }
    return c;
  }

  let media = null;  // image or video element when CONFIG.background is set
  let backgroundDirty = true;

  if (CONFIG.background) {
    if (/\.(mp4|webm|mov)$/i.test(CONFIG.background)) {
      media = document.createElement('video');
      media.muted = true;
      media.loop = true;
      media.playsInline = true;
      media.setAttribute('muted', '');
      media.setAttribute('playsinline', '');
      media.src = CONFIG.background;
      media.play().catch(() => {});
    } else {
      media = new Image();
      media.onload = () => { backgroundDirty = true; };
      media.src = CONFIG.background;
    }
  }

  // Renders the background into `sharp` (fitted to the screen) and `blur` (the fog's view).
  function buildBackground() {
    let source, sw, sh;
    if (!media) {
      source = paintPlaceholder(W, H);
      sw = W;
      sh = H;
    } else if (media.tagName === 'VIDEO') {
      if (media.readyState < 2) return false;
      source = media;
      sw = media.videoWidth;
      sh = media.videoHeight;
    } else {
      if (!media.naturalWidth) return false;
      source = media;
      sw = media.naturalWidth;
      sh = media.naturalHeight;
    }

    upload(sourceTex, source);
    const screenAspect = W / H, sourceAspect = sw / sh;
    const scale = screenAspect > sourceAspect ? [1, sourceAspect / screenAspect] : [screenAspect / sourceAspect, 1];
    pass(programs.cover, sharp, { uSrc: sourceTex }, (u) => {
      gl.uniform2f(u.uScale, scale[0], scale[1]);
      gl.uniform1f(u.uExposure, CONFIG.exposure);
      gl.uniform1f(u.uSaturation, CONFIG.saturation);
      gl.uniform1f(u.uHighlights, CONFIG.highlights);
      gl.uniform1f(u.uTemperature, CONFIG.temperature);
    });
    gl.bindTexture(gl.TEXTURE_2D, sharp.tex);
    gl.generateMipmap(gl.TEXTURE_2D);  // lets the first blur pass downsample smoothly

    const sigma = (W * 0.012) / BLUR_DIVISOR;  // in blur-texture pixels
    const step = sigma / 2.2;
    let src = sharp.tex;
    for (let i = 0; i < 3; i++) {
      pass(programs.blur, blurA, { uSrc: src }, (u) => gl.uniform2f(u.uStep, step / blurA.w, 0));
      pass(programs.blur, blurB, { uSrc: blurA.tex }, (u) => gl.uniform2f(u.uStep, 0, step / blurB.h));
      src = blurB.tex;
    }

    if (CONFIG.softness > 0) {
      const softStep = (CONFIG.softness * unit) / 2 / 2.2;  // soft view is at half resolution
      pass(programs.blur, softA, { uSrc: sharp.tex }, (u) => gl.uniform2f(u.uStep, softStep / softA.w, 0));
      pass(programs.blur, softB, { uSrc: softA.tex }, (u) => gl.uniform2f(u.uStep, 0, softStep / softB.h));
    }
    return true;
  }

  // ---------------------------------------------------------------- sizing

  let W = 0, H = 0;   // canvas pixels
  let scale = 1;      // canvas pixels per CSS pixel
  let unit = 1;       // canvas pixels per pixel of a 1080p screen
  let maxDropR = 1;
  let inkScale = 1;   // ink/mask pixels per CSS pixel
  let sharp, blurA, blurB, softA, softB, mask;
  const sourceTex = texture();
  const inkTex = texture();
  const fogDropTex = texture();
  const waterTex = texture();
  const trailTex = texture();
  const strokeDirTex = texture();
  const inkCanvas = document.createElement('canvas');  // brush strokes since the last frame
  const inkCtx = inkCanvas.getContext('2d');
  const trailCanvas = document.createElement('canvas');  // drip trails since the last frame
  const trailCtx = trailCanvas.getContext('2d');
  const strokeDirCanvas = document.createElement('canvas');  // direction of each wipe, kept for streaks
  const strokeDirCtx = strokeDirCanvas.getContext('2d');
  let strokeDirDirty = false;
  const fogDropCanvas = document.createElement('canvas');
  const fogDropCtx = fogDropCanvas.getContext('2d');
  const waterCanvas = document.createElement('canvas');     // rain drops and droplets, redrawn every frame
  const waterCtx = waterCanvas.getContext('2d');
  const dropletsCanvas = document.createElement('canvas');  // tiny droplets, which build up over time
  const dropletsCtx = dropletsCanvas.getContext('2d');
  let waterScale = 1;  // water-canvas pixels per CSS pixel

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = Math.min(1, 2560 / Math.max(innerWidth * dpr, innerHeight * dpr));
    W = Math.max(1, Math.round(innerWidth * dpr * fit));
    H = Math.max(1, Math.round(innerHeight * dpr * fit));
    canvas.width = W;
    canvas.height = H;
    scale = W / innerWidth;
    unit = Math.min(W, H) / 1080;
    maxDropR = 24 * unit;

    dispose(sharp);
    dispose(blurA);
    dispose(blurB);
    dispose(softA);
    dispose(softB);
    sharp = target(W, H);
    gl.bindTexture(gl.TEXTURE_2D, sharp.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const bw = Math.max(1, Math.round(W / BLUR_DIVISOR)), bh = Math.max(1, Math.round(H / BLUR_DIVISOR));
    blurA = target(bw, bh);
    blurB = target(bw, bh);
    if (CONFIG.softness > 0) {
      softA = target(Math.max(1, Math.round(W / 2)), Math.max(1, Math.round(H / 2)));
      softB = target(softA.w, softA.h);
    }

    // Keep what's been drawn so far, stretched to the new size.
    const oldMask = mask;
    mask = target(Math.max(1, Math.round(W / MASK_DIVISOR)), Math.max(1, Math.round(H / MASK_DIVISOR)));
    if (oldMask) {
      pass(programs.copyAlpha, mask, { uSrc: oldMask.tex });
      dispose(oldMask);
    }
    for (const c of [inkCanvas, trailCanvas]) {
      c.width = mask.w;
      c.height = mask.h;
    }
    inkScale = mask.w / innerWidth;
    const oldDirs = document.createElement('canvas');
    oldDirs.width = strokeDirCanvas.width;
    oldDirs.height = strokeDirCanvas.height;
    if (oldDirs.width) oldDirs.getContext('2d').drawImage(strokeDirCanvas, 0, 0);
    strokeDirCanvas.width = mask.w;
    strokeDirCanvas.height = mask.h;
    if (oldDirs.width) strokeDirCtx.drawImage(oldDirs, 0, 0, mask.w, mask.h);
    upload(strokeDirTex, strokeDirCanvas);

    fogDropCanvas.width = W;
    fogDropCanvas.height = H;
    if (CONFIG.condensation) paintDrops(fogDropCtx, FOG_DROPS, 1);
    upload(fogDropTex, fogDropCanvas);

    // Rain is simulated in CSS pixels and drawn at up to 1920 pixels wide.
    waterScale = Math.min(scale, 1920 / innerWidth);
    const oldDroplets = document.createElement('canvas');
    oldDroplets.width = dropletsCanvas.width;
    oldDroplets.height = dropletsCanvas.height;
    if (oldDroplets.width) oldDroplets.getContext('2d').drawImage(dropletsCanvas, 0, 0);
    for (const c of [waterCanvas, dropletsCanvas]) {
      c.width = Math.round(innerWidth * waterScale);
      c.height = Math.round(innerHeight * waterScale);
    }
    if (oldDroplets.width) dropletsCtx.drawImage(oldDroplets, 0, 0, dropletsCanvas.width, dropletsCanvas.height);

    backgroundDirty = true;
  }

  // --------------------------------------------------------------- drawing

  let inkDirty = false;
  let lastInkTime = -Infinity;
  let stroke = null;  // last few pointer samples of the stroke in progress, in CSS pixels
  let strokeLength = 0;

  const brushRadius = () => Math.min(innerWidth, innerHeight) * CONFIG.brushSize;
  // The brush drifts slightly wider and narrower along a stroke, like a finger's pressure.
  const brushWidth = (R) => R * 2 * (0.85 + 0.3 * noise1(strokeLength / (R * 4)));
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // The brush is drawn hard-edged and solid; its edge is softened when merged into the mask.
  function beginStroke(x, y) {
    stroke = [{ x, y }];
    inkCtx.fillStyle = '#fff';
    inkCtx.beginPath();
    inkCtx.arc(x * inkScale, y * inkScale, (brushWidth(brushRadius()) / 2) * inkScale, 0, Math.PI * 2);
    inkCtx.fill();
    inkDirty = true;
    lastInkTime = performance.now();
  }

  // Strokes are quadratic curves through the midpoints between pointer samples,
  // so a gesture reads as one smooth line rather than a chain of segments.
  function strokeTo(x, y) {
    if (!stroke) return;
    const prev = stroke[stroke.length - 1];
    if (Math.hypot(x - prev.x, y - prev.y) < brushRadius() * 0.1) return;
    stroke.push({ x, y });
    if (stroke.length > 3) stroke.shift();
    const [a, b, c] = stroke.length === 3 ? stroke : [stroke[0], stroke[0], stroke[1]];
    drawCurve(midpoint(a, b), b, midpoint(b, c));
  }

  function endStroke() {
    if (stroke && stroke.length > 1) {
      const n = stroke.length, last = stroke[n - 1];
      drawCurve(midpoint(stroke[n - 2], last), last, last);
    }
    stroke = null;
  }

  // Records which way the glass was wiped, for finger streaks. The angle is
  // doubled so strokes drawn in opposite directions streak the same way.
  function recordDirection(angle, width, tracePath) {
    if (!CONFIG.streaks) return;
    const r = Math.round((Math.cos(2 * angle) * 0.5 + 0.5) * 255);
    const g = Math.round((Math.sin(2 * angle) * 0.5 + 0.5) * 255);
    strokeDirCtx.strokeStyle = `rgb(${r},${g},0)`;
    strokeDirCtx.lineWidth = width;
    strokeDirCtx.lineCap = 'round';
    strokeDirCtx.lineJoin = 'round';
    strokeDirCtx.beginPath();
    tracePath(strokeDirCtx);
    strokeDirCtx.stroke();
    strokeDirDirty = true;
  }

  function drawCurve(from, ctrl, to) {
    const R = brushRadius();
    const length = Math.hypot(ctrl.x - from.x, ctrl.y - from.y) + Math.hypot(to.x - ctrl.x, to.y - ctrl.y);
    strokeLength += length;
    const width = brushWidth(R);
    inkCtx.strokeStyle = '#fff';
    inkCtx.lineWidth = width * inkScale;
    inkCtx.lineCap = 'round';
    inkCtx.lineJoin = 'round';
    inkCtx.beginPath();
    inkCtx.moveTo(from.x * inkScale, from.y * inkScale);
    inkCtx.quadraticCurveTo(ctrl.x * inkScale, ctrl.y * inkScale, to.x * inkScale, to.y * inkScale);
    inkCtx.stroke();
    recordDirection(Math.atan2(to.y - from.y, to.x - from.x), width * 1.2 * inkScale, (ctx) => {
      ctx.moveTo(from.x * inkScale, from.y * inkScale);
      ctx.quadraticCurveTo(ctrl.x * inkScale, ctrl.y * inkScale, to.x * inkScale, to.y * inkScale);
    });
    inkDirty = true;
    lastInkTime = performance.now();

    // The finger wipes away rain and droplets in its path...
    dropletsCtx.globalCompositeOperation = 'destination-out';
    dropletsCtx.lineWidth = width * waterScale;
    dropletsCtx.lineCap = 'round';
    dropletsCtx.beginPath();
    dropletsCtx.moveTo(from.x * waterScale, from.y * waterScale);
    dropletsCtx.quadraticCurveTo(ctrl.x * waterScale, ctrl.y * waterScale, to.x * waterScale, to.y * waterScale);
    dropletsCtx.stroke();
    dropletsCtx.globalCompositeOperation = 'source-over';
    const pointOnCurve = (t) => {
      const s = 1 - t;
      return { x: s * s * from.x + 2 * s * t * ctrl.x + t * t * to.x, y: s * s * from.y + 2 * s * t * ctrl.y + t * t * to.y };
    };
    const samples = [0, 0.25, 0.5, 0.75, 1].map(pointOnCurve);
    for (const d of rainDrops) {
      if (samples.some((p) => Math.hypot(d.x - p.x, d.y - p.y) < width / 2)) d.killed = true;
    }

    // ...and the water it pushes aside gathers below the stroke and runs down.
    for (let expected = (CONFIG.dripRate * length) / (R * 2); Math.random() < expected; expected--) {
      const p = pointOnCurve(Math.random());
      const r = RAIN.minR + (RAIN.maxR - RAIN.minR) * (0.4 + 0.6 * Math.random());
      const drop = makeRainDrop({ x: p.x + (Math.random() - 0.5) * R * 0.4, y: p.y + width * 0.45, r, momentum: 2 + Math.random() * 3, runner: true });
      if (drop) rainDrops.push(drop);
    }
  }

  // ------------------------------------------------------------------ rain

  // A port of the raindrop simulation from Lucas Bebber's "Rain & Water Effect"
  // (Codrops, 2015). Drops land; heavier ones creep down in spurts, absorb any
  // drop they touch (growing and speeding up), leave smaller drops behind, and
  // wipe tiny droplets clean as they pass. Distances are in CSS pixels and
  // speeds in pixels per 60fps frame, as in the original.
  const RAIN = {
    minR: 6,   // about 0.6x the original's sizes, closer to our earlier drips
    maxR: 19,
    maxDrops: 900,
    rainChance: 0.3,
    rainLimit: 3,
    dropletsRate: 50,
    dropletsSize: [2, 4],
    dropletsCleaningRadiusMultiplier: 0.28,
    spawnArea: [-0.1, 0.95],
    trailRate: 1,
    trailScaleRange: [0.2, 0.45],
    collisionRadius: 0.45,
    collisionRadiusIncrease: 0.01,
    collisionBoostMultiplier: 0.05,
    collisionBoost: 1,
    // Our additions:
    forkChance: 0.006,  // per frame, for a heavy running drop, of splitting in two
    wander: 0.15,       // how much running drops meander side to side
    // When true, drops that land stay put, and streak-leaving drops ("runners")
    // enter from above the screen, so you never see where they started. When
    // false, landed drops start running on their own, as in the original.
    runnersFromAbove: true,
    runnerChance: 0.02, // per frame, of a runner entering from above
  };
  const DELTA_R = RAIN.maxR - RAIN.minR;
  let rainDrops = [];
  let dropletCounter = 0;
  let evaporateClock = 0;

  const between = (from, to, curve = (n) => n) => from + (to - from) * curve(Math.random());
  const chance = (c) => Math.random() <= c;
  const areaFactor = () => Math.sqrt((innerWidth * innerHeight) / (1024 * 768));

  function makeRainDrop(props) {
    if (rainDrops.length >= RAIN.maxDrops * areaFactor()) return null;
    return {
      x: 0, y: 0, r: 0, spreadX: 0, spreadY: 0, momentum: 0, momentumX: 0,
      lastSpawn: 0, nextSpawn: 0, parent: null, isNew: true, killed: false, shrink: 0,
      travelled: 0,                   // distance run so far, for softening where a path begins
      drift: 0,                       // slow sideways push, which lets forks spread apart
      wanderSeed: Math.random() * 256,
      ...props,
    };
  }

  function drawRainDrop(ctx, d) {
    let depth = Math.max(0, Math.min(1, ((d.r - RAIN.minR) / DELTA_R) * 0.9));
    depth /= (d.spreadX + d.spreadY) * 0.5 + 1;
    const w = d.r * 2 * (d.spreadX + 1), h = d.r * 2 * 1.5 * (d.spreadY + 1);
    ctx.drawImage(sprites[Math.floor(depth * (SPRITE_BUCKETS - 1))],
      (d.x - w / 2) * waterScale, (d.y - h / 2) * waterScale, w * waterScale, h * waterScale);
  }

  function clearDroplets(x, y, r) {
    dropletsCtx.globalCompositeOperation = 'destination-out';
    dropletsCtx.beginPath();
    dropletsCtx.ellipse(x * waterScale, y * waterScale, r * waterScale, r * 1.5 * waterScale, 0, 0, Math.PI * 2);
    dropletsCtx.fill();
    dropletsCtx.globalCompositeOperation = 'source-over';
  }

  function updateRain(ts, dt) {
    // Tiny droplets land everywhere, and slowly evaporate so they never saturate.
    dropletCounter += RAIN.dropletsRate * CONFIG.rain * ts * areaFactor();
    for (; dropletCounter >= 1; dropletCounter--) {
      drawRainDrop(dropletsCtx, {
        x: Math.random() * innerWidth, y: Math.random() * innerHeight,
        r: between(...RAIN.dropletsSize, (n) => n * n), spreadX: 0, spreadY: 0,
      });
    }
    evaporateClock += dt;
    if (evaporateClock > 0.5) {
      evaporateClock = 0;
      dropletsCtx.globalCompositeOperation = 'destination-out';
      dropletsCtx.fillStyle = 'rgba(0,0,0,0.04)';
      dropletsCtx.fillRect(0, 0, dropletsCanvas.width, dropletsCanvas.height);
      dropletsCtx.globalCompositeOperation = 'source-over';
    }

    const next = [];

    // New raindrops, mostly small (radius is weighted by a cube).
    const limit = RAIN.rainLimit * ts * areaFactor();
    for (let count = 0; count < limit && chance(RAIN.rainChance * CONFIG.rain * ts * areaFactor()); count++) {
      const r = between(RAIN.minR, RAIN.maxR, (n) => n ** 3);
      const drop = makeRainDrop({
        x: Math.random() * innerWidth,
        y: between(innerHeight * RAIN.spawnArea[0], innerHeight * RAIN.spawnArea[1]),
        r, momentum: RAIN.runnersFromAbove ? 0 : 1 + (r - RAIN.minR) * 0.1 + Math.random() * 2, spreadX: 1.5, spreadY: 1.5,
      });
      if (drop) next.push(drop);
    }

    // Runners enter from just above the screen, already moving.
    if (RAIN.runnersFromAbove && chance(RAIN.runnerChance * CONFIG.rain * ts * (innerWidth / 1024))) {
      const r = between(RAIN.minR * 1.5, RAIN.maxR);
      const runner = makeRainDrop({
        x: Math.random() * innerWidth, y: -r * (1.5 + Math.random() * 2), r,
        momentum: 3 + Math.random() * 3, runner: true, travelled: r * 4,
      });
      if (runner) next.push(runner);
    }

    // Sorted top to bottom, so each drop only checks its neighbours for collisions.
    rainDrops.sort((a, b) => (a.y * innerWidth + a.x) - (b.y * innerWidth + b.x));

    rainDrops.forEach((drop, i) => {
      if (drop.killed) return;
      // Heavier drops are more likely to creep down (only runners, when they come from above).
      if ((drop.runner || !RAIN.runnersFromAbove) && chance((drop.r - RAIN.minR) * (0.1 / DELTA_R) * ts)) {
        drop.momentum += between(0, (drop.r / RAIN.maxR) * 4);
      }
      // Small drops slowly dry up.
      if (drop.r <= RAIN.minR && chance(0.05 * ts)) drop.shrink += 0.01;
      drop.r -= drop.shrink * ts;
      if (drop.r <= 0) drop.killed = true;

      // Moving drops leave a trail of smaller drops, losing water as they do.
      drop.lastSpawn += drop.momentum * ts * RAIN.trailRate;
      if (drop.lastSpawn > drop.nextSpawn) {
        const trailDrop = makeRainDrop({
          x: drop.x + between(-drop.r, drop.r) * 0.1,
          y: drop.y - drop.r * 0.01,
          r: drop.r * between(...RAIN.trailScaleRange),
          spreadY: drop.momentum * 0.1,
          parent: drop,
        });
        if (trailDrop) {
          next.push(trailDrop);
          drop.r *= 0.97 ** ts;
          drop.lastSpawn = 0;
          drop.nextSpawn = between(RAIN.minR, RAIN.maxR) - drop.momentum * 2 * RAIN.trailRate + (RAIN.maxR - drop.r);
        }
      }

      drop.spreadX *= 0.4 ** ts;
      drop.spreadY *= 0.7 ** ts;

      const moved = drop.momentum > 0;
      const px = drop.x, py = drop.y;
      if (moved && !drop.killed) {
        // Running drops meander a little rather than falling dead straight.
        drop.momentumX += (noise1(drop.wanderSeed + drop.y * 0.02) - 0.5) * RAIN.wander * ts * Math.min(1, drop.momentum / 4);
        drop.y += drop.momentum * ts;
        drop.x += (drop.momentumX + drop.drift) * ts;
        drop.drift *= 0.97 ** ts;
        drop.travelled += Math.hypot(drop.x - px, drop.y - py);
        if (drop.y > innerHeight + drop.r) drop.killed = true;

        // Now and then a heavy running drop forks: it splits its water with a
        // branch, and the two drift apart at a slight angle before straightening.
        if (!drop.killed && drop.r > RAIN.minR * 1.6 && drop.momentum > 2 && drop.travelled > drop.r * 4 && chance(RAIN.forkChance * ts)) {
          const share = between(0.3, 0.5);  // of the water, to the branch
          const side = chance(0.5) ? 1 : -1;
          const branchR = drop.r * Math.sqrt(share);
          drop.r *= Math.sqrt(1 - share);
          drop.drift -= side * between(0.2, 0.5);
          const branch = makeRainDrop({
            x: drop.x + side * branchR * 0.3, y: drop.y, r: branchR,
            momentum: drop.momentum * between(0.6, 0.9),
            drift: side * between(0.4, 1),
            travelled: drop.travelled,  // a branch continues a path, so it starts at full width
            parent: drop,               // so the two don't immediately merge again
            runner: true,
          });
          if (branch) next.push(branch);
        }
      }

      // Drops that touch merge. The larger one absorbs the smaller (whichever
      // was moving), growing and picking up speed, which can set it running too.
      // (In the original only a larger moving drop could absorb, so small drops
      // slid straight through big still ones.)
      if ((moved || drop.isNew) && !drop.killed) {
        for (const other of rainDrops.slice(i + 1, i + 70)) {
          if (drop === other || drop.parent === other || other.parent === drop || other.killed) continue;
          if (Math.hypot(other.x - drop.x, other.y - drop.y) >= (drop.r + other.r) * (RAIN.collisionRadius + drop.momentum * RAIN.collisionRadiusIncrease * ts)) continue;
          const [big, small] = drop.r >= other.r ? [drop, other] : [other, drop];
          const targetR = Math.min(RAIN.maxR * 1.5, Math.sqrt(big.r * big.r + small.r * small.r * 0.8));
          big.r = targetR;
          big.momentumX += (small.x - big.x) * 0.1;
          big.spreadX = 0;
          big.spreadY = 0;
          small.killed = true;
          // Merging speeds a drop up, unless two still drops merged (when runners come from above).
          if (big.runner || small.runner || !RAIN.runnersFromAbove) {
            big.momentum = Math.max(small.momentum, Math.min(40, big.momentum + targetR * RAIN.collisionBoostMultiplier + RAIN.collisionBoost));
            big.runner = true;
          }
          if (small === drop) break;
        }
      }
      if ((moved || drop.isNew) && !drop.killed) absorbBeads(drop);
      drop.isNew = false;

      drop.momentum = Math.max(0, drop.momentum - Math.max(1, RAIN.minR * 0.5 - drop.momentum) * 0.1 * ts);
      drop.momentumX *= 0.7 ** ts;

      if (drop.killed) return;
      next.push(drop);
      if (moved) {
        clearDroplets(drop.x, drop.y, drop.r * RAIN.dropletsCleaningRadiusMultiplier);
        // A running drop also clears a path through the fog, as wide as itself.
        // The path starts narrow and faint and builds up over the first few
        // drop-lengths, so there's no telling exactly where the drop began.
        let t = Math.min(1, drop.travelled / (drop.r * 4));
        t = t * t * (3 - 2 * t);
        const trailWidth = Math.max(1, drop.r * 2 * BLOB_EDGE * inkScale * (0.15 + 0.85 * t));
        trailCtx.strokeStyle = `rgba(255,255,255,${0.35 + 0.65 * t})`;
        trailCtx.lineWidth = trailWidth;
        trailCtx.lineCap = 'round';
        trailCtx.beginPath();
        trailCtx.moveTo(px * inkScale, py * inkScale);
        trailCtx.lineTo(drop.x * inkScale, drop.y * inkScale);
        trailCtx.stroke();
        recordDirection(Math.atan2(drop.y - py, drop.x - px), trailWidth, (ctx) => {
          ctx.moveTo(px * inkScale, py * inkScale);
          ctx.lineTo(drop.x * inkScale, drop.y * inkScale);
        });
        inkDirty = true;
        lastInkTime = performance.now();
      }
    });
    rainDrops = next;

    waterCtx.clearRect(0, 0, waterCanvas.width, waterCanvas.height);
    waterCtx.drawImage(dropletsCanvas, 0, 0);
    for (const drop of rainDrops) drawRainDrop(waterCtx, drop);
    upload(waterTex, waterCanvas);
  }

  // Optional loading screen (as in Red Baron): the bar eases toward 90% while
  // waiting, and only fills and fades once the background is ready to play.
  const loader = document.getElementById('loader');
  const loaderFill = loader?.querySelector('.loader-fill');
  let loaderDone = !loader;
  let loaderProgress = 0;
  let backgroundShown = false;  // set once the background is first on screen
  const loaderTimer = loader && setInterval(() => {
    if (loaderProgress < 90) loaderProgress += (90 - loaderProgress) * 0.06 + 0.4;
    loaderFill.style.width = `${Math.min(loaderProgress, 90)}%`;
  }, 100);
  function finishLoading() {
    if (loaderDone) return;
    loaderDone = true;
    clearInterval(loaderTimer);
    loaderFill.style.transition = 'width 350ms ease-out';
    loaderFill.style.width = '100%';
    setTimeout(() => loader.classList.add('done'), 350);
    setTimeout(() => {
      loader.remove();
      showHintSoon();
    }, 850);
  }
  media?.addEventListener('error', finishLoading);  // don't leave people stuck if the video fails

  const hint = document.getElementById('hint');  // optional prompt, dismissed on first touch

  // The prompt fades in 1.5s after the page is up (after the loading screen, if any).
  function showHintSoon() {
    setTimeout(() => hint?.classList.add('shown'), 1500);
  }
  if (!loader) showHintSoon();

  // The prompt drifts slightly toward the cursor, easing behind it.
  const HINT_PARALLAX = 0.03;  // of the cursor's distance from the center
  const hintTarget = { x: 0, y: 0 }, hintOffset = { x: 0, y: 0 };
  window.addEventListener('pointermove', (e) => {
    hintTarget.x = (e.clientX - innerWidth / 2) * HINT_PARALLAX;
    hintTarget.y = (e.clientY - innerHeight / 2) * HINT_PARALLAX;
  });
  function moveHint(dt) {
    if (!hint || hint.classList.contains('gone')) return;
    const ease = Math.min(1, dt * 4);
    hintOffset.x += (hintTarget.x - hintOffset.x) * ease;
    hintOffset.y += (hintTarget.y - hintOffset.y) * ease;
    hint.style.transform = `translate(${hintOffset.x.toFixed(2)}px, ${hintOffset.y.toFixed(2)}px)`;
  }

  // Optional rain slider: sets how hard it rains, live.
  const rainSlider = document.getElementById('rain');
  if (rainSlider) {
    rainSlider.value = CONFIG.rain;
    rainSlider.addEventListener('input', () => { CONFIG.rain = parseFloat(rainSlider.value); });
  }

  // Draw only while the mouse button (or a finger) is down. Capturing the pointer
  // means releasing it outside the window still ends the stroke.
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    hint?.classList.add('gone');
    beginStroke(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stroke || !e.isPrimary) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) strokeTo(ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  // A white dot replaces the system cursor for mice; while pressing, the
  // system's grabbing hand takes its place.
  const cursor = document.getElementById('cursor');
  window.addEventListener('pointermove', (e) => {
    cursor.hidden = e.pointerType !== 'mouse';
    cursor.style.translate = `${e.clientX}px ${e.clientY}px`;
  });
  const setGrabbing = (on) => document.documentElement.classList.toggle('grabbing', on);
  window.addEventListener('pointerdown', () => setGrabbing(true));
  window.addEventListener('pointerup', () => setGrabbing(false));
  window.addEventListener('pointercancel', () => setGrabbing(false));
  document.documentElement.addEventListener('mouseleave', () => { cursor.hidden = true; });

  // ------------------------------------------------------------------ loop

  let fadeCarry = 0;
  let lastFrame = performance.now();

  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (media && media.tagName === 'VIDEO' && !media.paused) backgroundDirty = true;
    if (backgroundDirty && buildBackground()) {
      backgroundDirty = false;
      backgroundShown = true;
    }
    // Done loading once the background is showing and, for video, can play on smoothly.
    if (!loaderDone && backgroundShown && (!media || media.tagName !== 'VIDEO' || media.readyState >= 3)) finishLoading();

    updateRain(dt * 60, dt);
    moveHint(dt);

    if (inkDirty) {
      upload(inkTex, inkCanvas);
      upload(trailTex, trailCanvas);
      const soften = brushRadius() * inkScale * 0.35;  // mask pixels
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      pass(programs.mergeInk, mask, { uBrush: inkTex, uTrails: trailTex },
        (u) => gl.uniform2f(u.uRadius, soften / mask.w, soften / mask.h));
      gl.disable(gl.BLEND);
      inkCtx.clearRect(0, 0, inkCanvas.width, inkCanvas.height);
      trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
      inkDirty = false;
    }

    // Fog back over, in whole 1/255 steps so an 8-bit mask fades evenly to zero.
    if (CONFIG.refogSeconds > 0 && now - lastInkTime < CONFIG.refogSeconds * 1500) {
      fadeCarry += (dt * 0.8) / CONFIG.refogSeconds;
      const steps = Math.floor(fadeCarry * 255);
      if (steps > 0) {
        fadeCarry -= steps / 255;
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
        gl.blendFunc(gl.ONE, gl.ONE);
        pass(programs.solid, mask, {}, (u) => gl.uniform1f(u.uAmount, steps / 255));
        gl.disable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
      }
    }

    if (strokeDirDirty) {
      upload(strokeDirTex, strokeDirCanvas);
      strokeDirDirty = false;
    }

    pass(programs.glass, null, {
      uView: CONFIG.softness > 0 ? softB.tex : sharp.tex,
      uBlur: blurB.tex,
      uMask: mask.tex,
      uFogDrops: fogDropTex,
      uWater: waterTex,
      uStrokeDir: strokeDirTex,
    }, (u) => {
      gl.uniform2f(u.uRes, W, H);
      gl.uniform1f(u.uStreaks, CONFIG.streaks);
      gl.uniform1f(u.uUnit, unit);
      gl.uniform1f(u.uMaxDropR, maxDropR);
    });

    requestAnimationFrame(frame);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 150);
  });

  resize();
  requestAnimationFrame(frame);
})();
