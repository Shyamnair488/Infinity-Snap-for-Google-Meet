/*
 * Infinity Snap - snap detector (runs in the page's MAIN world)
 *
 * A finger snap is a very short (<~40 ms), very bright (2-6 kHz) click.
 * We watch the microphone's high-frequency energy, wait for a spike far above the
 * running noise floor, then confirm that the energy dies away again quickly.
 * Speech, music and hiss are rejected because they stay loud for longer.
 *
 * Audio never leaves the page: only a few numbers per block are computed.
 */
(() => {
  'use strict';
  if (!window.__INFINITY_SNAP__) {
    Object.defineProperty(window, '__INFINITY_SNAP__', { value: {}, enumerable: false });
  }
  const NS = window.__INFINITY_SNAP__;
  if (NS.SnapDetector) return;

  const ABS_MIN = 0.004;       // ignore spikes quieter than this (float samples, 1.0 = full scale)
  const BRIGHTNESS = 0.45;     // high-frequency energy must be this fraction of total energy
  const CONFIRM_MS = 70;       // how long we watch after a spike
  const MAX_ABOVE_MS = 45;     // snap energy must not stay above 30% of peak longer than this
  const COOLDOWN_MS = 900;     // ignore everything after a snap for this long
  const BUFFER = 512;

  class SnapDetector {
    constructor({ onSnap }) {
      this.onSnap = onSnap;
      this.sens = 6;
      this.mode = '';
      this.ctx = null;
      this.starting = false;
      this.token = 0;
      this.resetState();
    }

    get running() { return !!this.ctx; }

    resetState() {
      this.prev = 0;
      this.floor = 0.002;
      this.armed = false;
      this.peak = 0;
      this.t0 = 0;
      this.above = 0;
      this.cool = 0;
    }

    setSensitivity(s) {
      this.sens = Math.min(10, Math.max(1, Number(s) || 6));
    }

    /**
     * Pure analysis step - also used by the unit tests.
     * @param {Float32Array} x      one block of mono samples
     * @param {number} now          current time in ms
     * @param {number} blockMs      duration of the block in ms
     * @returns {boolean}           true when a snap has just been confirmed
     */
    analyse(x, now, blockMs) {
      const n = x.length;
      let sumSq = 0;
      let sumD = 0;
      let prev = this.prev;
      for (let i = 0; i < n; i++) {
        const s = x[i];
        sumSq += s * s;
        const d = s - prev;
        sumD += d * d;
        prev = s;
      }
      this.prev = prev;
      const rms = Math.sqrt(sumSq / n);
      const hf = Math.sqrt(sumD / n);

      if (now < this.cool) return false;

      if (!this.armed) {
        const ratio = 16 - 1.3 * this.sens;                  // sens 1..10 -> 14.7 .. 3
        const threshold = Math.max(ABS_MIN, this.floor * ratio);
        if (hf > threshold && hf > BRIGHTNESS * rms) {
          this.armed = true;
          this.peak = hf;
          this.t0 = now;
          this.above = blockMs;
        } else {
          const rate = hf > this.floor ? 0.005 : 0.05;       // rise slowly, fall quickly
          this.floor += (Math.max(hf, 1e-5) - this.floor) * rate;
        }
        return false;
      }

      if (hf > this.peak) this.peak = hf;
      if (hf > this.peak * 0.3) this.above += blockMs;
      if (now - this.t0 >= CONFIRM_MS) {
        const isSnap = this.above <= MAX_ABOVE_MS;
        this.armed = false;
        this.cool = now + COOLDOWN_MS;
        return isSnap;
      }
      return false;
    }

    async start(meetTrack, { raw = true, sensitivity = 6 } = {}) {
      if (this.ctx || this.starting) return;
      this.starting = true;
      const token = ++this.token;
      this.setSensitivity(sensitivity);
      let stream = null;
      let ownsStream = false;
      try {
        // Preferred: our own unprocessed mic stream. Works while Meet is muted and
        // isn't affected by Meet's noise suppression squashing the snap.
        if (raw && NS.rawGetUserMedia) {
          try {
            const settings = (meetTrack && meetTrack.getSettings && meetTrack.getSettings()) || {};
            const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
            if (settings.deviceId) audio.deviceId = { ideal: settings.deviceId };
            stream = await NS.rawGetUserMedia({ audio, video: false });
            ownsStream = true;
            this.mode = 'raw';
          } catch (e) {
            console.info('[Infinity Snap] raw mic unavailable, falling back to Meet\'s stream', e);
          }
        }
        if (!stream && meetTrack && meetTrack.readyState === 'live') {
          stream = new MediaStream([meetTrack]);
          this.mode = 'tap';
        }
        if (!stream || token !== this.token) {
          if (stream && ownsStream) stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC({ latencyHint: 'interactive' });
        const source = ctx.createMediaStreamSource(stream);
        const proc = ctx.createScriptProcessor(BUFFER, 1, 1);
        const blockMs = (BUFFER / ctx.sampleRate) * 1000;
        proc.onaudioprocess = (e) => {
          if (this.analyse(e.inputBuffer.getChannelData(0), performance.now(), blockMs)) {
            try { this.onSnap(); } catch (err) { console.warn('[Infinity Snap]', err); }
          }
        };
        source.connect(proc);
        proc.connect(ctx.destination); // outputs silence; required for the node to run

        const resume = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
        const events = ['pointerdown', 'keydown', 'click'];
        events.forEach((ev) => window.addEventListener(ev, resume, true));
        resume();

        this.resetState();
        this.ctx = ctx;
        this.nodes = { source, proc };
        this.stream = stream;
        this.ownsStream = ownsStream;
        this.cleanupListeners = () => events.forEach((ev) => window.removeEventListener(ev, resume, true));
      } catch (err) {
        console.warn('[Infinity Snap] snap detector failed to start', err);
        if (stream && ownsStream) stream.getTracks().forEach((t) => t.stop());
      } finally {
        this.starting = false;
        if (NS.pushStatus) NS.pushStatus();
      }
    }

    stop() {
      this.token++;
      if (this.cleanupListeners) this.cleanupListeners();
      if (this.nodes) {
        try { this.nodes.proc.onaudioprocess = null; this.nodes.source.disconnect(); this.nodes.proc.disconnect(); } catch (_) {}
      }
      if (this.ctx) this.ctx.close().catch(() => {});
      if (this.stream && this.ownsStream) this.stream.getTracks().forEach((t) => t.stop());
      this.ctx = null;
      this.nodes = null;
      this.stream = null;
      this.ownsStream = false;
      this.mode = '';
      this.starting = false;
      if (NS.pushStatus) NS.pushStatus();
    }
  }

  NS.SnapDetector = SnapDetector;
})();
