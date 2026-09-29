// Wet glass: the screen starts fogged and beaded with water. The cursor (or a
// finger) wipes it clear, water gathers and runs down from the strokes, and
// the fog slowly creeps back.
(() => {
  'use strict';

  const CONFIG = {
    // '' paints a placeholder scene. Or point at an image or video,
    // e.g. 'media/background.jpg' or 'media/background.mp4'.
    background: 'media/meadow.mp4',
    brushSize: 0.065,   // brush radius, as a fraction of the shorter screen side
    refogSeconds: 30,   // roughly how long a stroke stays clear; 0 = never fog back
    dripRate: 1.5,      // average drips per brush-width of stroke
    ambientDrips: 0.25, // drops per second that gather and slide down untouched glass
  };

  const MAX_DRIPS = 80;
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

  // Fits the background source to the screen like CSS object-fit: cover.
  const COVER = HEADER + `
    uniform sampler2D uSrc;
    uniform vec2 uScale;
    void main() { o = vec4(texture(uSrc, (vUv - 0.5) * uScale + 0.5).rgb, 1.0); }`;

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
    #define MAX_DRIPS ${MAX_DRIPS}
    uniform sampler2D uSharp, uBlur, uMask, uFogDrops, uClearDrops;
    uniform vec2 uRes;
    uniform float uUnit;      // canvas pixels per pixel of a 1080p screen
    uniform float uMaxDropR;  // canvas pixels; drop maps store radius as a fraction of this
    uniform vec4 uDrips[MAX_DRIPS];  // running drips: xy position, z radius (canvas pixels)
    uniform int uDripCount;

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
      vec3 through = texture(uSharp, vUv - grad * 6.0 * uUnit * texel).rgb;
      vec3 col = mix(fog, through * 0.97, c) + ridge * 0.05;

      // Droplets. Fog drops are wiped away with the fog; a sparse set of leftover
      // drops (and beads left by drips) sits on the clear glass.
      vec4 fd = texture(uFogDrops, vUv);
      vec4 cd = texture(uClearDrops, vUv);
      float fa = fd.a * (1.0 - c), ca = cd.a * c;
      vec4 d = fa >= ca ? vec4(fd.rgb, fa) : vec4(cd.rgb, ca);
      vec2 n = (d.rg * 2.0 - 1.0) * vec2(1.0, -1.0);
      float rad = d.b * uMaxDropR;
      float a = d.a;

      for (int i = 0; i < MAX_DRIPS; i++) {
        if (i >= uDripCount) break;
        vec4 dr = uDrips[i];
        vec2 q = (px - dr.xy) / dr.z;
        q.y *= 0.8;
        float da = clamp((1.0 - length(q)) / 0.12, 0.0, 1.0);
        if (da > a) { a = da; n = q; rad = dr.z; }
      }

      if (a > 0.0) {
        float h = sqrt(max(0.0, 1.0 - dot(n, n)));
        // Each drop is a tiny lens showing an inverted view of what's behind it.
        vec3 lens = texture(uSharp, vUv - n * rad * 2.2 * texel).rgb;
        float rim = smoothstep(0.55, 1.0, length(n));
        // On fogged glass a drop is mostly clear, but still carries some haze.
        vec3 dc = mix(lens, fog, 0.35 * (1.0 - c)) * (0.85 + 0.15 * h) * (1.0 - 0.35 * rim);
        vec2 light = vec2(-0.45, 0.55);
        dc += smoothstep(0.35, 0.0, length(n - light)) * 0.35;
        dc += smoothstep(0.45, 1.0, dot(n, -normalize(light))) * 0.15 * lum;
        col = mix(col, dc, a);
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

  // Drop sprites encode a hemisphere: RG = surface normal, B = drop radius
  // (one sprite per radius bucket, since B can't vary per drawImage), A = coverage.
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
        const r = Math.hypot(nx, ny);
        if (r >= 1) continue;
        const i = (y * size + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[i + 2] = (b / (SPRITE_BUCKETS - 1)) * 255;
        img.data[i + 3] = Math.min(1, (1 - r) / 0.1) * 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  });

  function drawDrop(ctx, x, y, r, stretch) {
    const b = Math.max(0, Math.min(SPRITE_BUCKETS - 1, Math.round((r / maxDropR) * (SPRITE_BUCKETS - 1))));
    const h = r * 2 * stretch;
    ctx.drawImage(sprites[b], x - r, y - h / 2, r * 2, h);
  }

  // [count on a 16:9 screen, min radius, max radius] in 1080p pixels.
  const FOG_DROPS = [[26000, 0.6, 1.6], [7000, 1.6, 3.2], [900, 3.2, 6.5], [120, 6.5, 12], [15, 12, 20]];
  const CLEAR_DROPS = [[900, 0.7, 2], [160, 2, 4.5], [25, 4.5, 8]];

  function paintDrops(ctx, layers, seed) {
    const rand = rng(seed);
    const areaFactor = (W / unit) * (H / unit) / (1920 * 1080);
    ctx.clearRect(0, 0, W, H);
    for (const [count, rMin, rMax] of layers) {
      for (let i = 0, n = Math.round(count * areaFactor); i < n; i++) {
        const r = (rMin + (rMax - rMin) * rand() ** 1.5) * unit;
        drawDrop(ctx, rand() * W, rand() * H, r, 0.92 + rand() * 0.2);
      }
    }
  }

  // Adds one drop to the clear-glass layer and patches just that region of its texture.
  function addClearDrop(x, y, r) {
    drawDrop(clearDropCtx, x, y, r, 1.1);
    const x0 = Math.max(0, Math.floor(x - r - 2)), x1 = Math.min(W, Math.ceil(x + r + 2));
    const y0 = Math.max(0, Math.floor(y - r * 1.1 - 2)), y1 = Math.min(H, Math.ceil(y + r * 1.1 + 2));
    if (x1 <= x0 || y1 <= y0) return;
    const data = clearDropCtx.getImageData(x0, y0, x1 - x0, y1 - y0);
    gl.bindTexture(gl.TEXTURE_2D, clearDropTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, H - y1, x1 - x0, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, data);
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
    pass(programs.cover, sharp, { uSrc: sourceTex }, (u) => gl.uniform2f(u.uScale, scale[0], scale[1]));
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
    return true;
  }

  // ---------------------------------------------------------------- sizing

  let W = 0, H = 0;   // canvas pixels
  let scale = 1;      // canvas pixels per CSS pixel
  let unit = 1;       // canvas pixels per pixel of a 1080p screen
  let maxDropR = 1;
  let inkScale = 1;   // ink/mask pixels per CSS pixel
  let sharp, blurA, blurB, mask;
  const sourceTex = texture();
  const inkTex = texture();
  const fogDropTex = texture();
  const clearDropTex = texture();
  const trailTex = texture();
  const inkCanvas = document.createElement('canvas');  // brush strokes since the last frame
  const inkCtx = inkCanvas.getContext('2d');
  const trailCanvas = document.createElement('canvas');  // drip trails since the last frame
  const trailCtx = trailCanvas.getContext('2d');
  const fogDropCanvas = document.createElement('canvas');
  const fogDropCtx = fogDropCanvas.getContext('2d');
  const clearDropCanvas = document.createElement('canvas');
  const clearDropCtx = clearDropCanvas.getContext('2d', { willReadFrequently: true });

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
    sharp = target(W, H);
    gl.bindTexture(gl.TEXTURE_2D, sharp.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const bw = Math.max(1, Math.round(W / BLUR_DIVISOR)), bh = Math.max(1, Math.round(H / BLUR_DIVISOR));
    blurA = target(bw, bh);
    blurB = target(bw, bh);

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

    for (const c of [fogDropCanvas, clearDropCanvas]) {
      c.width = W;
      c.height = H;
    }
    paintDrops(fogDropCtx, FOG_DROPS, 1);
    paintDrops(clearDropCtx, CLEAR_DROPS, 2);
    upload(fogDropTex, fogDropCanvas);
    upload(clearDropTex, clearDropCanvas);

    backgroundDirty = true;
  }

  // --------------------------------------------------------------- drawing

  let inkDirty = false;
  let lastInkTime = -Infinity;
  let stroke = null;  // last few pointer samples of the stroke in progress, in CSS pixels
  let strokeLength = 0;
  const drips = [];

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
    inkDirty = true;
    lastInkTime = performance.now();

    // Drips start from random points along the curve's lower edge.
    for (let expected = (CONFIG.dripRate * length) / (R * 2); Math.random() < expected; expected--) {
      const t = Math.random(), s = 1 - t;
      const x = s * s * from.x + 2 * s * t * ctrl.x + t * t * to.x;
      const y = s * s * from.y + 2 * s * t * ctrl.y + t * t * to.y;
      spawnDrip(x + (Math.random() - 0.5) * R * 0.4, y + width * 0.4, R);
    }
  }

  // Water pushed aside by a stroke gathers, then runs down in stops and starts,
  // clearing a thin trail and shrinking until it settles as a bead.
  function spawnDrip(x, y, R, pace = 1) {
    if (drips.length >= MAX_DRIPS) return;
    const r = R * (0.06 + Math.random() ** 2 * 0.12);  // mostly modest, a few heavy
    drips.push({
      x, y, r,
      age: 0,
      speed: (40 + Math.random() * 60) * (r / (R * 0.1)) * pace,  // heavier drips run faster
      loss: r / (300 + Math.random() * 600),  // radius lost per pixel travelled
      wait: 0.1 + Math.random() * 0.7,
      phase: Math.random() * Math.PI * 2,
    });
  }

  function updateDrips(dt) {
    for (let i = drips.length - 1; i >= 0; i--) {
      const d = drips[i];
      d.age += dt;
      if (d.wait > 0) {
        d.wait -= dt;
        continue;
      }
      const px = d.x, py = d.y;
      d.y += d.speed * dt;
      d.x += Math.sin(d.y * 0.03 + d.phase) * d.speed * dt * 0.15;
      d.r -= (d.y - py) * d.loss;
      if (Math.random() < dt * 0.4) d.wait = 0.1 + Math.random() * 0.6;

      trailCtx.strokeStyle = '#fff';
      trailCtx.lineWidth = Math.max(1, d.r * 1.7 * inkScale);
      trailCtx.lineCap = 'round';
      trailCtx.beginPath();
      trailCtx.moveTo(px * inkScale, py * inkScale);
      trailCtx.lineTo(d.x * inkScale, d.y * inkScale);
      trailCtx.stroke();
      inkDirty = true;
      lastInkTime = performance.now();

      if (Math.random() < (d.y - py) * 0.004) addClearDrop(d.x * scale, d.y * scale, d.r * 0.6 * scale);

      if (d.r < 1 || d.y > innerHeight + 20) {
        if (d.y < innerHeight) addClearDrop(d.x * scale, d.y * scale, d.r * 1.2 * scale);
        drips.splice(i, 1);
      }
    }
  }

  // Draw only while the mouse button (or a finger) is down. Capturing the pointer
  // means releasing it outside the window still ends the stroke.
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    beginStroke(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stroke || !e.isPrimary) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) strokeTo(ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  // A white dot replaces the system cursor for mice; it grows while pressed.
  const cursor = document.getElementById('cursor');
  window.addEventListener('pointermove', (e) => {
    cursor.hidden = e.pointerType !== 'mouse';
    cursor.style.translate = `${e.clientX}px ${e.clientY}px`;
  });
  window.addEventListener('pointerdown', () => cursor.classList.add('pressed'));
  window.addEventListener('pointerup', () => cursor.classList.remove('pressed'));
  document.documentElement.addEventListener('mouseleave', () => { cursor.hidden = true; });

  // ------------------------------------------------------------------ loop

  const dripUniform = new Float32Array(MAX_DRIPS * 4);
  let fadeCarry = 0;
  let ambientClock = 2;
  let lastFrame = performance.now();

  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    if (media && media.tagName === 'VIDEO' && !media.paused) backgroundDirty = true;
    if (backgroundDirty && buildBackground()) backgroundDirty = false;

    ambientClock -= dt;
    if (CONFIG.ambientDrips > 0 && ambientClock <= 0) {
      ambientClock = (0.5 + Math.random()) / CONFIG.ambientDrips;
      spawnDrip(Math.random() * innerWidth, Math.random() * innerHeight * 0.6, brushRadius(), 0.35);
    }
    updateDrips(dt);

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

    // Drips swell into view over their first half second rather than popping in.
    drips.forEach((d, i) => dripUniform.set([d.x * scale, H - d.y * scale, Math.max(0.01, d.r * Math.min(1, d.age / 0.5)) * scale, 1], i * 4));
    pass(programs.glass, null, {
      uSharp: sharp.tex,
      uBlur: blurB.tex,
      uMask: mask.tex,
      uFogDrops: fogDropTex,
      uClearDrops: clearDropTex,
    }, (u) => {
      gl.uniform2f(u.uRes, W, H);
      gl.uniform1f(u.uUnit, unit);
      gl.uniform1f(u.uMaxDropR, maxDropR);
      gl.uniform4fv(u.uDrips, dripUniform);
      gl.uniform1i(u.uDripCount, drips.length);
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
