/*
 * Infinity Snap - FX engine (runs in the page's MAIN world)
 *
 * FxPipeline takes the real camera track, renders it through a WebGL canvas and
 * exposes that canvas as the outgoing video track. Normally it is a pass-through.
 * On snap() it freezes you into thousands of particles that sweep away as ash,
 * leaves the empty room behind, and after the vanish duration pulls the ash back
 * together and crossfades to the live camera.
 */
(() => {
  'use strict';
  if (!window.__INFINITY_SNAP__) {
    Object.defineProperty(window, '__INFINITY_SNAP__', { value: {}, enumerable: false });
  }
  const NS = window.__INFINITY_SNAP__;
  if (NS.FxPipeline) return;

  const CFG = {
    MAX_WIDTH: 1280,       // cap output width (keeps GPU/CPU cost sane)
    DRAW_MS: 16,           // render tick
    CAPTURE_FPS: 30,       // frame rate of the outgoing track
    SWEEP: 2.6,            // seconds for the dust front to cross the frame
    LIFE: 2.4,             // base lifetime of one particle (seconds)
    RETURN: 3.6,           // seconds the ash takes to re-form
    MIN_DURATION: 12,      // shortest allowed total vanish time
    DIFF_THRESHOLD: 34,    // 0-255 colour distance that counts as "you"
    MAX_COVERAGE: 0.9      // if >90% of the frame differs, the saved room is stale
  };
  const T_DISSOLVE = CFG.SWEEP + CFG.LIFE * 1.3; // when the last particle is gone
  const FLASH_SECONDS = 0.45;

  /* ------------------------------------------------------------ shaders */

  const QUAD_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const FS_PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

  const QUAD_FS = FS_PRECISION + `
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uUseTex;
uniform vec4 uColor;
void main() {
  vec3 t = texture2D(uTex, vUv).rgb;
  gl_FragColor = vec4(mix(uColor.rgb, t, uUseTex), uColor.a);
}`;

  const PART_VS = `
precision highp float;
attribute vec2 aUv;
attribute vec3 aRnd;
uniform float uTime;
uniform float uSweep;
uniform float uLife;
uniform float uDir;
uniform float uCell;
uniform vec2 uRes;
varying vec2 vUv;
varying float vAge;
varying vec2 vSpan;
void main() {
  float coord = uDir > 0.0 ? aUv.x : 1.0 - aUv.x;
  float delay = uSweep * clamp(0.62 * coord + 0.38 * aRnd.x, 0.0, 1.0);
  float life  = uLife * (0.7 + 0.6 * aRnd.y);
  float age   = clamp((uTime - delay) / life, 0.0, 1.0);
  float e     = pow(age, 1.7);

  vec2 px = aUv * uRes;
  vec2 wind = vec2(1.0, -0.42);
  float dist = uRes.x * (0.22 + 0.55 * aRnd.z);
  vec2 swirl = vec2(sin(age * 7.0 + aRnd.x * 31.4), cos(age * 6.0 + aRnd.y * 27.1)) * uRes.y * 0.07 * e;
  px += wind * dist * e + swirl + vec2(0.0, -uRes.y * 0.12 * aRnd.x * e);

  float size = (uCell + 0.8) * (1.0 - 0.75 * smoothstep(0.0, 1.0, age));
  vUv = aUv;
  vAge = age;
  vSpan = vec2(size) / uRes;
  gl_PointSize = max(size, 1.0);
  gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
  if (age >= 1.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

  const PART_FS = FS_PRECISION + `
uniform sampler2D uTex;
varying vec2 vUv;
varying float vAge;
varying vec2 vSpan;
void main() {
  vec2 pc = gl_PointCoord - 0.5;
  vec3 c = texture2D(uTex, vUv + pc * vSpan).rgb;
  float r = length(pc) * 2.0;
  float roundness = smoothstep(0.0, 0.25, vAge);
  float shape = mix(1.0, 1.0 - smoothstep(0.55, 1.0, r), roundness);
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  vec3 ash = vec3(lum * 0.55 + 0.10, lum * 0.50 + 0.09, lum * 0.46 + 0.08);
  c = mix(c, ash, smoothstep(0.02, 0.5, vAge));
  float ember = (1.0 - smoothstep(0.0, 0.22, vAge)) * step(0.001, vAge);
  c += vec3(1.0, 0.42, 0.08) * ember * 0.85;
  float a = (1.0 - smoothstep(0.5, 1.0, vAge)) * shape;
  if (a < 0.01) discard;
  gl_FragColor = vec4(c, a);
}`;

  /* ------------------------------------------------------------ helpers */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function makeProgram(gl, vs, fs, attribs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  function makeTexture(gl) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }

  /**
   * A timer that keeps running in background tabs (workers are not throttled).
   * Falls back to setInterval if the page's CSP forbids blob workers.
   */
  function makeTicker(cb, ms) {
    let worker = null;
    let url = null;
    let id = 0;
    let stopped = false;
    const fallback = () => {
      if (worker) { worker.terminate(); worker = null; }
      if (!id && !stopped) id = setInterval(cb, ms);
    };
    try {
      url = URL.createObjectURL(new Blob([`setInterval(function(){postMessage(0)},${ms})`], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = cb;
      worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fallback(); };
    } catch (_) {
      fallback();
    }
    return {
      stop() {
        stopped = true;
        if (worker) worker.terminate();
        if (id) clearInterval(id);
        if (url) URL.revokeObjectURL(url);
      }
    };
  }

  /** Per-channel median of (A - B): the global exposure drift between the two frames. */
  function medianOffset(A, B) {
    const n = A.length / 4;
    const offsets = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const hist = new Int32Array(511);
      for (let i = 0; i < n; i++) hist[A[i * 4 + ch] - B[i * 4 + ch] + 255]++;
      let acc = 0;
      for (let k = 0; k < 511; k++) {
        acc += hist[k];
        if (acc >= n / 2) { offsets[ch] = k - 255; break; }
      }
    }
    return offsets;
  }

  /** Majority filter (removes noise specks) followed by a 1-cell dilation (covers soft edges). */
  function cleanMask(raw, w, h) {
    const maj = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w) c += raw[yy * w + xx];
          }
        }
        maj[y * w + x] = c >= 4 ? 1 : 0;
      }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] = maj[i] || (x > 0 && maj[i - 1]) || (x < w - 1 && maj[i + 1]) ||
                 (y > 0 && maj[i - w]) || (y < h - 1 && maj[i + w]) ? 1 : 0;
      }
    }
    return out;
  }

  /* ----------------------------------------------------------- pipeline */

  class FxPipeline {
    constructor(track, opts = {}) {
      this.track = track;
      this.plateKey = 'infinity-snap:room:v1:' + (opts.plateKey || 'default');
      this.fx = null;
      this.partCount = 0;
      this.hasPlate = false;
      this.destroyed = false;
      this.lost = false;
      this.lastDraw = 0;
    }

    async start() {
      const v = (this.video = document.createElement('video'));
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.setAttribute('aria-hidden', 'true');
      v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      v.srcObject = new MediaStream([this.track]);
      (document.body || document.documentElement).appendChild(v);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('camera metadata timeout')), 6000);
        const ok = () => { clearTimeout(timer); resolve(); };
        if (v.readyState >= 1) ok(); else v.onloadedmetadata = ok;
      });
      try { await v.play(); } catch (_) { /* autoplay muted is allowed; ignore */ }

      const nw = v.videoWidth || 1280;
      const nh = v.videoHeight || 720;
      const scale = Math.min(1, CFG.MAX_WIDTH / nw);
      this.W = Math.max(2, Math.round((nw * scale) / 2) * 2);
      this.H = Math.max(2, Math.round((nh * scale) / 2) * 2);

      const canvas = (this.canvas = document.createElement('canvas'));
      canvas.width = this.W;
      canvas.height = this.H;
      this.plateCanvas = document.createElement('canvas');
      this.plateCanvas.width = this.W;
      this.plateCanvas.height = this.H;
      this.plateCtx = this.plateCanvas.getContext('2d');
      this.plateCtx.fillStyle = '#000';
      this.plateCtx.fillRect(0, 0, this.W, this.H);

      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
      canvas.addEventListener('webglcontextrestored', () => {
        try { this._initGL(); this.lost = false; } catch (err) { console.warn('[Infinity Snap] GL restore failed', err); }
      });
      this._initGL();

      NS.pipelines.add(this);
      this._loadPlate();
      this.ticker = makeTicker(() => this._frame(), CFG.DRAW_MS);
      if (NS.pushStatus) NS.pushStatus();
    }

    _initGL() {
      const gl = (this.gl = this.canvas.getContext('webgl', {
        alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false
      }));
      if (!gl) throw new Error('WebGL unavailable');

      this.pq = makeProgram(gl, QUAD_VS, QUAD_FS, ['aPos']);
      this.pp = makeProgram(gl, PART_VS, PART_FS, ['aUv', 'aRnd']);
      const U = (p, names) => Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
      this.uq = U(this.pq, ['uTex', 'uUseTex', 'uColor']);
      this.up = U(this.pp, ['uTex', 'uTime', 'uSweep', 'uLife', 'uDir', 'uCell', 'uRes']);

      this.quadBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.partBuf = gl.createBuffer();

      this.videoTex = makeTexture(gl);
      this.snapTex = makeTexture(gl);
      this.plateTex = makeTexture(gl);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      if (this.hasPlate) this._uploadPlate();
      if (this.fx && this.partCount) this._rebuildSnapTexture();
    }

    /* ------------------------------------------------------- drawing */

    _attribs(n) {
      const gl = this.gl;
      for (let i = 0; i < 2; i++) (i < n ? gl.enableVertexAttribArray(i) : gl.disableVertexAttribArray(i));
    }

    _drawQuad(tex, useTex, r, g, b, a) {
      const gl = this.gl;
      gl.useProgram(this.pq);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      this._attribs(1);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.uq.uTex, 0);
      gl.uniform1f(this.uq.uUseTex, useTex);
      gl.uniform4f(this.uq.uColor, r, g, b, a);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _drawParticles(uTime) {
      const gl = this.gl;
      const fx = this.fx;
      gl.useProgram(this.pp);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
      this._attribs(2);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.snapTex);
      gl.uniform1i(this.up.uTex, 0);
      gl.uniform1f(this.up.uTime, uTime);
      gl.uniform1f(this.up.uSweep, CFG.SWEEP);
      gl.uniform1f(this.up.uLife, CFG.LIFE);
      gl.uniform1f(this.up.uDir, fx.dir);
      gl.uniform1f(this.up.uCell, this.cellPx);
      gl.uniform2f(this.up.uRes, this.W, this.H);
      gl.drawArrays(gl.POINTS, 0, this.partCount);
    }

    _advance(now) {
      const fx = this.fx;
      if (!fx) return null;
      const t = (now - fx.start) / 1000;
      if (!fx.ret && t >= fx.returnAt) fx.ret = { at: fx.returnAt, u: T_DISSOLVE };
      let uTime = Math.min(t, T_DISSOLVE);
      let liveAlpha = 0;
      if (fx.ret) {
        const p = (t - fx.ret.at) / CFG.RETURN;
        if (p >= 1) {
          this.fx = null;
          this.partCount = 0;
          if (NS.pushStatus) NS.pushStatus();
          return null;
        }
        const e = p * p * (3 - 2 * p);
        uTime = fx.ret.u * (1 - e);
        liveAlpha = smoothstep(0.82, 1, p);
      }
      const flash = t < FLASH_SECONDS ? Math.pow(1 - t / FLASH_SECONDS, 2) * 0.75 : 0;
      return { t, uTime, liveAlpha, flash };
    }

    _frame() {
      if (this.destroyed || this.lost || !this.gl) return;
      const now = performance.now();
      if (now - this.lastDraw < CFG.DRAW_MS * 0.6) return;
      this.lastDraw = now;

      const v = this.video;
      if (v.readyState < 2) return;
      const gl = this.gl;
      gl.viewport(0, 0, this.W, this.H);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      } catch (_) { return; }

      const st = this._advance(now);
      if (!st) {
        this._drawQuad(this.videoTex, 1, 0, 0, 0, 1);
        return;
      }
      if (this.fx.usePlate) {
        this._drawQuad(this.plateTex, 1, 0, 0, 0, 1);
      } else {
        gl.clearColor(0.02, 0.02, 0.04, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      if (this.partCount > 0 && st.uTime < T_DISSOLVE - 1e-3) this._drawParticles(st.uTime);
      if (st.liveAlpha > 0) this._drawQuad(this.videoTex, 1, 0, 0, 0, st.liveAlpha);
      if (st.flash > 0) this._drawQuad(this.videoTex, 0, 1.0, 0.92, 0.72, st.flash);
    }

    /* ----------------------------------------------------- snap logic */

    phase() {
      const fx = this.fx;
      if (!fx) return 'idle';
      if (fx.ret) return 'returning';
      const t = (performance.now() - fx.start) / 1000;
      return t < T_DISSOLVE ? 'vanishing' : 'gone';
    }

    /** Start the vanish. If you are already gone, a second snap brings you back early. */
    snap(durationSeconds) {
      if (this.destroyed || this.lost || !this.video || this.video.readyState < 2) return false;
      if (this.fx) {
        if (!this.fx.ret) {
          const t = (performance.now() - this.fx.start) / 1000;
          this.fx.ret = { at: t, u: Math.min(t, T_DISSOLVE) };
          if (NS.pushStatus) NS.pushStatus();
        }
        return true;
      }
      const usePlate = this._buildParticles();
      const total = Math.max(CFG.MIN_DURATION, Number(durationSeconds) || 20);
      this.fx = {
        start: performance.now(),
        returnAt: total - CFG.RETURN,
        ret: null,
        dir: Math.random() < 0.5 ? 1 : -1,
        usePlate
      };
      if (NS.pushStatus) NS.pushStatus();
      return true;
    }

    _rebuildSnapTexture() {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.snapTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.snapshot);
    }

    /** Freeze the current frame, work out which cells are "you", and upload them as particles. */
    _buildParticles() {
      const { W, H, video, gl } = this;
      const cell = Math.max(3, Math.round(W / 320));
      const gw = Math.ceil(W / cell);
      const gh = Math.ceil(H / cell);
      const cw = W / gw;
      const ch = H / gh;
      this.cellPx = (cw + ch) / 2;

      // Snapshot (kept as a canvas so a lost GL context can rebuild the texture).
      if (!this.snapshot) {
        this.snapshot = document.createElement('canvas');
        this.snapshot.width = W;
        this.snapshot.height = H;
      }
      this.snapshot.getContext('2d').drawImage(video, 0, 0, W, H);
      this._rebuildSnapTexture();

      if (!this.maskCanvas || this.maskCanvas.width !== gw || this.maskCanvas.height !== gh) {
        this.maskCanvas = document.createElement('canvas');
        this.maskCanvas.width = gw;
        this.maskCanvas.height = gh;
        this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
        this.maskCtx.imageSmoothingQuality = 'high';
      }
      const mctx = this.maskCtx;
      mctx.drawImage(this.snapshot, 0, 0, gw, gh);
      const A = mctx.getImageData(0, 0, gw, gh).data;

      let keep = new Uint8Array(gw * gh).fill(1);
      let usePlate = false;
      if (this.hasPlate) {
        mctx.drawImage(this.plateCanvas, 0, 0, gw, gh);
        const B = mctx.getImageData(0, 0, gw, gh).data;
        const off = medianOffset(A, B);
        const raw = new Uint8Array(gw * gh);
        for (let i = 0; i < raw.length; i++) {
          const j = i * 4;
          const d = Math.max(
            Math.abs(A[j] - B[j] - off[0]),
            Math.abs(A[j + 1] - B[j + 1] - off[1]),
            Math.abs(A[j + 2] - B[j + 2] - off[2])
          );
          raw[i] = d > CFG.DIFF_THRESHOLD ? 1 : 0;
        }
        const cleaned = cleanMask(raw, gw, gh);
        let count = 0;
        for (let i = 0; i < cleaned.length; i++) count += cleaned[i];
        if (count / cleaned.length <= CFG.MAX_COVERAGE) {
          keep = cleaned;
          usePlate = true;
        }
      }

      let n = 0;
      for (let i = 0; i < keep.length; i++) n += keep[i];
      const data = new Float32Array(n * 5);
      let k = 0;
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          if (!keep[y * gw + x]) continue;
          data[k++] = ((x + 0.5) * cw) / W;
          data[k++] = ((y + 0.5) * ch) / H;
          data[k++] = Math.random();
          data[k++] = Math.random();
          data[k++] = Math.random();
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.partCount = n;
      return usePlate;
    }

    /* ------------------------------------------------ empty-room plate */

    _uploadPlate() {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.plateTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.plateCanvas);
    }

    /** Average several frames of the empty room so sensor noise doesn't leave a ghost outline. */
    async capturePlate(frames = 10) {
      const ctx = this.plateCtx;
      for (let i = 0; i < frames; i++) {
        ctx.globalAlpha = 1 / (i + 1);
        ctx.drawImage(this.video, 0, 0, this.W, this.H);
        await sleep(60);
      }
      ctx.globalAlpha = 1;
      this.hasPlate = true;
      if (this.gl && !this.lost) this._uploadPlate();
      try {
        localStorage.setItem(this.plateKey, JSON.stringify({
          w: this.W, h: this.H, data: this.plateCanvas.toDataURL('image/jpeg', 0.88)
        }));
      } catch (_) { /* storage may be full or blocked */ }
      if (NS.pushStatus) NS.pushStatus();
    }

    clearPlate() {
      this.hasPlate = false;
      this.plateCtx.fillStyle = '#000';
      this.plateCtx.fillRect(0, 0, this.W, this.H);
      try { localStorage.removeItem(this.plateKey); } catch (_) {}
      if (NS.pushStatus) NS.pushStatus();
    }

    _loadPlate() {
      try {
        const raw = localStorage.getItem(this.plateKey);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved || !saved.data || Math.abs(saved.w / saved.h - this.W / this.H) > 0.05) return;
        const img = new Image();
        img.onload = () => {
          if (this.destroyed) return;
          this.plateCtx.drawImage(img, 0, 0, this.W, this.H);
          this.hasPlate = true;
          if (this.gl && !this.lost) this._uploadPlate();
          if (NS.pushStatus) NS.pushStatus();
        };
        img.src = saved.data;
      } catch (_) { /* ignore corrupt data */ }
    }

    /* ------------------------------------------------------ lifecycle */

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (this.ticker) this.ticker.stop();
      NS.pipelines.delete(this);
      try {
        this.video.pause();
        this.video.srcObject = null;
        this.video.remove();
      } catch (_) {}
      try {
        const ext = this.gl && this.gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      } catch (_) {}
      if (NS.pushStatus) NS.pushStatus();
    }
  }

  NS.FxPipeline = FxPipeline;
  NS.FX = Object.freeze({ ...CFG, T_DISSOLVE });
  NS.pipelines = NS.pipelines || new Set();
})();
