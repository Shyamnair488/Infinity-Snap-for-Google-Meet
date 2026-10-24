# 🫰 Infinity Snap for Google Meet

Snap your fingers in a Google Meet call and **turn to dust**, Endgame-style. Particles sweep off your body as glowing ash, the empty room is left behind, and after **20 seconds** the ash pulls back together and you return.

Everyone in the call sees it (and so do you in your self-view), because the effect is drawn into the camera stream Meet sends. No virtual camera, no server, no extra app.

> Independent fan project. Not affiliated with Google, Marvel or Disney.

## Install (developer mode, 2 minutes)

1. Download or clone this repo (or unzip `infinity-snap.zip`).
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder that contains `manifest.json`.
5. Open (or **reload**) your Google Meet tab. The extension only hooks the camera when Meet starts it, so reload after installing.

Requires Chrome / Edge / Brave 111 or newer.

## First-time setup: save your empty room (recommended)

To make *only you* vanish (and not the whole picture), the extension needs one photo of the room without you in it.

1. Join or open a Meet call with your camera on. Keep the camera still.
2. Click the extension icon, then **Save empty room** (or press `Alt+Shift+R`).
3. You get a 5-second countdown. Step out of the frame and stay out until you see "Empty room saved ✓".

It is remembered for next time (per camera, in your browser only). Re-save it if you move the camera or the lighting changes a lot. Without a saved room, the whole frame turns to dust and the background goes dark.

## Using it

- **Snap your fingers** near your microphone. That's it.
- Or click **Snap now** in the popup, or press `Alt+Shift+S`.
- You stay gone for the configured time (default 20 s, range 12-60 s), then the ash re-forms.
- Snap again while you're gone to come back early.

Timeline: flash → ~6 s of dissolving → empty room → ~3.6 s of ash re-forming → live camera.

### Popup settings

| Setting | What it does |
|---|---|
| Enabled | Master switch. Turn on **before** your camera starts; toggle the Meet camera off/on to apply. |
| Trigger on the sound of a snap | Listen for snaps. Off = manual button/shortcut only. |
| Snap sensitivity | Raise it if real snaps are missed, lower it if keyboard clicks or claps trigger it. |
| Gone for | Total vanish time in seconds. |
| Separate raw mic stream | Opens a private, unprocessed mic stream just for snap detection so it works while you're muted in Meet. Turn off to listen on Meet's own mic stream instead (then snaps are not detected while muted). |

## How it works

```
manifest.json                 MV3 manifest (content scripts on meet.google.com, popup, storage)
src/page/hook.js              MAIN world, document_start: wraps getUserMedia, wires everything together
src/page/fx-engine.js         WebGL pipeline: camera -> canvas.captureStream(); particle dust shader
src/page/snap-detector.js     Web Audio snap detector (spike + fast-decay + brightness test)
src/bridge.js                 Isolated world: relays popup messages and chrome.storage settings to the page
popup/                        Popup UI (status, buttons, settings)
tests/                        Detector tests on synthetic audio + a smoke test of the hook
```

1. `hook.js` runs before Meet's own scripts and wraps `navigator.mediaDevices.getUserMedia`. The real camera track is fed to a hidden `<video>`, drawn through WebGL, and Meet receives `canvas.captureStream()` as its camera track (with `getSettings`/`label` mirrored so Meet treats it like the real camera).
2. On a snap, the current frame is frozen and split into small cells. If you saved the empty room, cells that differ from it (you) become particles; the room is drawn behind them. Each particle waits for the dust front to reach it, then drifts up and to the side on the wind, turns ash-grey with an ember glow, and fades.
3. Returning plays the same math in reverse, then crossfades to the live camera.
4. Snap detection looks for a short, bright, loud click above the running noise floor that dies away within ~45 ms. Speech, music and hiss stay loud longer and are rejected.

## Honest limitations

- **Snap = sound.** Detection is based on the audio of the snap, not on seeing your hand. (Reliable camera-only snap recognition isn't practical: the motion lasts a frame or two.) A loud clap can also trigger it.
- **Background subtraction is simple.** Auto-exposure shifts, a moving camera, or other people entering the shot can leave ghosts or dissolve extra things. Lock exposure if your camera allows it, and re-save the room if it looks off.
- **Keep Meet visible.** Browsers throttle hidden tabs. The effect uses a Web Worker timer to keep going, but if the Meet tab is in the background and the call is silent, frame rate may drop.
- **Meet can change.** This relies on Meet using `getUserMedia` for the camera, which it does today.
- The code has unit tests for the detector and a smoke test for the hook; the WebGL effect needs a real Chrome to see. If something looks off, open DevTools on the Meet tab and look for `[Infinity Snap]` messages.

## Troubleshooting

| Problem | Fix |
|---|---|
| Popup says "Reload this Meet tab" | Reload the Meet tab once after installing/updating. |
| Camera chip says Off | Turn your camera on in Meet. If it still says Off, toggle the camera off and on once. |
| Snaps aren't detected | Check the Mic chip says *Listening*. Raise sensitivity. Snap closer to the mic. Try turning the raw mic option off/on. |
| Triggers on claps/keyboard | Lower sensitivity. |
| Ghost outline of you remains | Re-save the empty room with the camera still and lighting steady. |
| Whole picture turns to dust | No saved room (or the saved room no longer matches). Save it again. |

## Development

```bash
npm test        # detector + smoke tests (Node 18+)
npm run lint    # syntax check
npm run pack    # builds infinity-snap.zip (needs `zip`)
```

Tweak the look in `src/page/fx-engine.js` (`CFG` at the top: sweep time, particle life, return time, mask threshold; the GLSL strings control motion and colour).

## Publish to GitHub

```bash
cd infinity-snap
git init
git add .
git commit -m "Infinity Snap v1.0.0"
git branch -M main
git remote add origin https://github.com/<your-user>/infinity-snap.git
git push -u origin main
# optional: publish a downloadable zip via the Release workflow
git tag v1.0.0 && git push origin v1.0.0
```

`.github/workflows/ci.yml` runs lint + tests on every push; `release.yml` attaches a zip to each `v*` tag.

## Publish to the Chrome Web Store (optional)

You need: a developer account (one-time US$5), the zip from `npm run pack`, a 128×128 icon (included), at least one 1280×800 screenshot, a short description, and a link to `PRIVACY.md`.

Permission justifications to paste into the review form:
- `storage`: saves your settings.
- Host access to `https://meet.google.com/*`: required to wrap the camera stream and listen for the snap on Google Meet. No other sites.
- Microphone use (via the page's existing permission): detect the sound of a snap locally; audio is never recorded or sent.

Expect extra review attention because the extension replaces the camera track and uses the microphone; being open source with a clear privacy policy helps.

## License

MIT. See `LICENSE`.
