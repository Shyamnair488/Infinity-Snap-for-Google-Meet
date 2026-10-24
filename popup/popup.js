'use strict';

const DEFAULTS = { enabled: true, soundTrigger: true, sensitivity: 6, duration: 20, rawMic: true };
const $ = (id) => document.getElementById(id);

async function meetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.url && tab.url.startsWith('https://meet.google.com/') ? tab : null;
}

async function send(msg) {
  const tab = await meetTab();
  if (!tab) throw new Error('no-meet');
  return chrome.tabs.sendMessage(tab.id, msg);
}

function banner(text) {
  const b = $('banner');
  b.hidden = !text;
  b.textContent = text || '';
}

function setChip(name, on, text) {
  $('dot' + name).classList.toggle('on', !!on);
  $('val' + name).textContent = text;
}

const PHASE_TEXT = {
  idle: 'Ready. Snap your fingers!',
  vanishing: 'You are turning to dust…',
  gone: 'You are gone. Snap again to come back early.',
  returning: 'Coming back…'
};

function render(status) {
  const connected = status && status.pageReady;
  const dis = !connected;
  ['snapBtn', 'plateBtn', 'clearBtn'].forEach((id) => { $(id).disabled = dis; });
  if (!connected) {
    setChip('Cam', false, '-');
    setChip('Mic', false, '-');
    setChip('Room', false, '-');
    $('phaseHint').textContent = '';
    return;
  }
  setChip('Cam', status.cameraActive, status.cameraActive ? 'Active' : 'Off');
  setChip('Mic', status.listening, status.listening ? 'Listening' : 'Off');
  setChip('Room', status.hasPlate, status.hasPlate ? 'Saved' : 'Not saved');
  $('plateBtn').textContent = status.capturing ? 'Capturing…' : 'Save empty room';
  $('phaseHint').textContent = status.cameraActive
    ? PHASE_TEXT[status.phase] || ''
    : 'Turn your camera on in Meet to begin.';
}

async function refresh() {
  try {
    const status = await send({ type: 'getStatus' });
    banner('');
    render(status);
  } catch (e) {
    const tab = await meetTab().catch(() => null);
    banner(tab
      ? 'Reload this Meet tab once (the extension was just installed or updated).'
      : 'Open a Google Meet tab to use Infinity Snap.');
    render(null);
  }
}

async function action(type) {
  try {
    await send({ type });
    if (type === 'capturePlate') $('phaseHint').textContent = 'Switch to the Meet tab and step out of frame…';
    setTimeout(refresh, 250);
  } catch (_) {
    refresh();
  }
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('enabled').checked = s.enabled;
  $('soundTrigger').checked = s.soundTrigger;
  $('rawMic').checked = s.rawMic;
  $('sensitivity').value = s.sensitivity;
  $('duration').value = s.duration;
  $('sensVal').textContent = s.sensitivity;
  $('durVal').textContent = s.duration;

  const save = (patch) => chrome.storage.sync.set(patch);
  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('soundTrigger').addEventListener('change', (e) => save({ soundTrigger: e.target.checked }));
  $('rawMic').addEventListener('change', (e) => save({ rawMic: e.target.checked }));
  $('sensitivity').addEventListener('input', (e) => {
    $('sensVal').textContent = e.target.value;
    save({ sensitivity: Number(e.target.value) });
  });
  $('duration').addEventListener('input', (e) => {
    $('durVal').textContent = e.target.value;
    save({ duration: Number(e.target.value) });
  });

  $('snapBtn').addEventListener('click', () => action('snap'));
  $('plateBtn').addEventListener('click', () => action('capturePlate'));
  $('clearBtn').addEventListener('click', () => action('clearPlate'));

  refresh();
  setInterval(refresh, 1000);
}

init();
