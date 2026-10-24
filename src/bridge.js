/*
 * Infinity Snap - bridge (isolated world).
 * The page script (MAIN world) cannot use chrome.* APIs, and the popup cannot reach the
 * page's JavaScript directly. This tiny script relays between the two:
 *   popup  --chrome.tabs.sendMessage-->  bridge  --window.postMessage-->  page script
 *   chrome.storage settings  ------------^
 */
(() => {
  'use strict';
  const CH = 'infinity-snap';
  const DEFAULTS = { enabled: true, soundTrigger: true, sensitivity: 6, duration: 20, rawMic: true };

  let lastStatus = null;
  const waiters = [];

  const post = (msg) => window.postMessage({ channel: CH, from: 'bridge', ...msg }, location.origin);

  const pushSettings = () => {
    try {
      chrome.storage.sync.get(DEFAULTS).then((s) => post({ type: 'settings', settings: s })).catch(() => {});
    } catch (_) { /* extension context invalidated (e.g. extension was reloaded) */ }
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.channel !== CH || d.from !== 'page') return;
    if (d.type === 'hello') pushSettings();
    if (d.type === 'status') {
      lastStatus = d.status;
      while (waiters.length) waiters.shift()(lastStatus);
    }
  });

  pushSettings();
  chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'sync') pushSettings(); });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'snap':
      case 'capturePlate':
      case 'clearPlate':
        post({ type: msg.type });
        sendResponse({ ok: true });
        return false;
      case 'getStatus': {
        let done = false;
        const finish = (s) => {
          if (done) return;
          done = true;
          sendResponse(s || { pageReady: false });
        };
        waiters.push(finish);
        post({ type: 'getStatus' });
        setTimeout(() => finish(lastStatus), 400);
        return true; // async response
      }
      default:
        return false;
    }
  });
})();
