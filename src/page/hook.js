/*
 * Infinity Snap - camera hook & orchestration (runs in the page's MAIN world,
 * at document_start, i.e. before Google Meet's own scripts).
 *
 * Meet asks the browser for the camera with navigator.mediaDevices.getUserMedia().
 * We wrap that call: the real camera track goes into our WebGL pipeline and Meet
 * receives the pipeline's canvas track instead. Everyone in the call (and your own
 * self-view) therefore sees the effect, with no virtual camera driver needed.
 */
(() => {
  'use strict';
  if (!window.__INFINITY_SNAP__) {
    Object.defineProperty(window, '__INFINITY_SNAP__', { value: {}, enumerable: false });
  }
  const NS = window.__INFINITY_SNAP__;
  if (NS.hooked) return;
  NS.hooked = true;

  const CH = 'infinity-snap';
  const GUM_PROTO = window.MediaDevices && window.MediaDevices.prototype;
  if (!GUM_PROTO || !GUM_PROTO.getUserMedia || !navigator.mediaDevices) return;

  NS.settings = { enabled: true, soundTrigger: true, sensitivity: 6, duration: 20, rawMic: true };
  NS.pipelines = NS.pipelines || new Set();
  NS.liveTracks = new Set();
  NS.audioSeen = false;
  NS.lastAudioTrack = null;
  NS.capturing = false;

  const origGUM = GUM_PROTO.getUserMedia;
  NS.rawGetUserMedia = (constraints) => origGUM.call(navigator.mediaDevices, constraints);

  /* ---------------------------------------------------------------- UI */

  let toastEl = null;
  let toastTimer = 0;
  NS.toast = (msg, ms = 2600) => {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.setAttribute('role', 'status');
        Object.assign(toastEl.style, {
          position: 'fixed', left: '50%', bottom: '104px', transform: 'translateX(-50%)',
          zIndex: '2147483647', padding: '10px 18px', borderRadius: '999px',
          background: 'rgba(18,16,30,.94)', color: '#fff', font: '500 14px/1.3 system-ui, sans-serif',
          border: '1px solid #e8b84a', boxShadow: '0 6px 24px rgba(0,0,0,.45)',
          pointerEvents: 'none', transition: 'opacity .25s', opacity: '0', maxWidth: '90vw', textAlign: 'center'
        });
        (document.body || document.documentElement).appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, ms);
    } catch (_) { /* never break the page */ }
  };

  /* ------------------------------------------------------ status / bridge */

  NS.status = () => {
    const ps = [...NS.pipelines];
    const active = ps.find((p) => p.phase() !== 'idle');
    return {
      pageReady: true,
      cameraActive: ps.length > 0,
      phase: active ? active.phase() : 'idle',
      hasPlate: ps.some((p) => p.hasPlate),
      listening: NS.detector ? NS.detector.running : false,
      micMode: NS.detector ? NS.detector.mode : '',
      capturing: NS.capturing
    };
  };

  NS.pushStatus = () => {
    try { window.postMessage({ channel: CH, from: 'page', type: 'status', status: NS.status() }, location.origin); } catch (_) {}
  };

  /* --------------------------------------------------------------- actions */

  NS.snapAll = (source) => {
    if (!NS.settings.enabled) return false;
    let any = false;
    NS.pipelines.forEach((p) => { any = p.snap(NS.settings.duration) || any; });
    if (!any && source === 'manual') NS.toast('Turn your camera on first 📷');
    return any;
  };

  NS.capturePlate = async () => {
    if (!NS.pipelines.size) { NS.toast('Turn your camera on first 📷'); return; }
    if (NS.capturing) return;
    NS.capturing = true;
    NS.pushStatus();
    try {
      for (let i = 5; i > 0; i--) {
        NS.toast(`Step out of the frame… saving the empty room in ${i}`, 1200);
        await new Promise((r) => setTimeout(r, 1000));
      }
      NS.toast('Hold still…', 1000);
      for (const p of [...NS.pipelines]) await p.capturePlate();
      NS.toast('Empty room saved ✓  Now snap!', 3500);
    } catch (e) {
      console.warn('[Infinity Snap] capture failed', e);
      NS.toast('Could not save the room, try again');
    } finally {
      NS.capturing = false;
      NS.pushStatus();
    }
  };

  NS.clearPlate = () => {
    NS.pipelines.forEach((p) => p.clearPlate());
    NS.toast('Saved room cleared');
  };

  /* -------------------------------------------------------- snap detector */

  NS.detector = new NS.SnapDetector({ onSnap: () => NS.snapAll('sound') });

  function syncDetector() {
    const s = NS.settings;
    const want = s.enabled && s.soundTrigger && NS.audioSeen && NS.liveTracks.size > 0;
    const d = NS.detector;
    if (want && !d.running && !d.starting) {
      d.start(NS.lastAudioTrack, { raw: s.rawMic, sensitivity: s.sensitivity });
    } else if (!want && (d.running || d.starting)) {
      d.stop();
    }
    NS.pushStatus();
  }

  NS.applySettings = (incoming) => {
    const prev = NS.settings;
    NS.settings = { ...prev, ...incoming };
    NS.detector.setSensitivity(NS.settings.sensitivity);
    if (prev.rawMic !== NS.settings.rawMic && NS.detector.running) NS.detector.stop();
    syncDetector();
  };

  /* ------------------------------------------------------ track bookkeeping */

  /** Track a Meet-owned track so we know when the call has let go of the camera/mic. */
  function watch(track) {
    NS.liveTracks.add(track);
    const drop = () => { if (NS.liveTracks.delete(track)) syncDetector(); };
    track.addEventListener('ended', drop);
    const stop = track.stop.bind(track);
    track.stop = () => { stop(); drop(); };
  }

  async function wrapVideo(src) {
    const s = src.getSettings();
    const pipe = new NS.FxPipeline(src, { plateKey: String(s.deviceId || 'default').slice(0, 24) });
    try {
      await pipe.start();
    } catch (e) {
      pipe.destroy();
      throw e;
    }
    const outTrack = pipe.canvas.captureStream(NS.FX.CAPTURE_FPS).getVideoTracks()[0];

    let refs = 0;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      pipe.destroy();
      try { src.stop(); } catch (_) {}
    };

    // Make the canvas track look like the camera track to Meet.
    const patch = (t) => {
      const base = t.getSettings.bind(t);
      t.getSettings = () => {
        const o = {
          ...base(), deviceId: s.deviceId, groupId: s.groupId, facingMode: s.facingMode,
          width: pipe.W, height: pipe.H, frameRate: NS.FX.CAPTURE_FPS, aspectRatio: pipe.W / pipe.H
        };
        Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]);
        return o;
      };
      t.applyConstraints = () => Promise.resolve();
      Object.defineProperty(t, 'label', { get: () => src.label, configurable: true });
    };

    // Reference-count clones so the pipeline lives until the last copy is stopped.
    const adopt = (t) => {
      refs++;
      patch(t);
      NS.liveTracks.add(t);
      const stop = t.stop.bind(t);
      let done = false;
      t.stop = () => {
        stop();
        if (done) return;
        done = true;
        NS.liveTracks.delete(t);
        if (--refs === 0) cleanup();
        syncDetector();
      };
      const clone = t.clone.bind(t);
      t.clone = () => adopt(clone());
      return t;
    };

    src.addEventListener('ended', () => {
      outTrack.stop();
      outTrack.dispatchEvent(new Event('ended'));
    });
    return adopt(outTrack);
  }

  async function processStream(stream) {
    const audio = stream.getAudioTracks();
    const video = stream.getVideoTracks();

    audio.forEach((a) => { NS.audioSeen = true; NS.lastAudioTrack = a; watch(a); });

    let outVideo = null;
    if (video.length && NS.settings.enabled) {
      try {
        outVideo = await wrapVideo(video[0]);
      } catch (e) {
        console.warn('[Infinity Snap] effect pipeline failed, using the plain camera', e);
      }
    }
    if (video.length && !outVideo) video.forEach(watch);

    syncDetector();
    if (!outVideo) return stream;
    return new MediaStream(stream.getTracks().map((t) => (t === video[0] ? outVideo : t)));
  }

  GUM_PROTO.getUserMedia = function (constraints) {
    return origGUM.call(this, constraints).then(processStream);
  };

  /* ------------------------------------------------------------ messaging */

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.channel !== CH || d.from !== 'bridge') return;
    switch (d.type) {
      case 'settings': NS.applySettings(d.settings || {}); break;
      case 'snap': NS.snapAll('manual'); break;
      case 'capturePlate': NS.capturePlate(); break;
      case 'clearPlate': NS.clearPlate(); break;
      case 'getStatus': NS.pushStatus(); break;
      default: break;
    }
  });

  // Keyboard fallbacks: Alt+Shift+S = snap, Alt+Shift+R = save the empty room.
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyS') { e.preventDefault(); NS.snapAll('manual'); }
    else if (e.code === 'KeyR') { e.preventDefault(); NS.capturePlate(); }
  }, true);

  // Ask the isolated-world bridge for the saved settings (it also pushes them proactively).
  window.postMessage({ channel: CH, from: 'page', type: 'hello' }, location.origin);
})();
