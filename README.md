# Vocal Practice — Pitch Tracker & Looper

A mobile-friendly, dark-mode vocal practice tool for iOS Safari and Android
Chrome. It shows a real-time pitch-tracking grid (F2 – A5) as you sing, and
lets you build up color-coded, multi-track vocal loops with per-track
mute/solo/enable controls.

No build step, no framework, no dependencies — plain HTML/CSS/JS modules
served as static files.

## How it works

- **Pitch grid** (`src/pitchGrid.js`): a `<canvas>` with a log-scaled note
  axis from F2 to A5 and a time axis. While your first take is recording it
  behaves like a scrolling strip chart; once a loop length exists it shows
  the whole loop with a sweeping playhead.
- **Pitch detection** (`src/pitchDetector.js`): bounded autocorrelation
  (ACF2+ style) run every animation frame against `AnalyserNode` time-domain
  data — real-time, no external library.
- **Recording** (`src/recorderWorkletProcessor.js` + `src/audioEngine.js`):
  an `AudioWorkletNode` streams raw PCM to the main thread. Capture is
  "armed" with a target `AudioContext` time, and playback of existing layers
  is scheduled off the same clock origin, so a new overdub lines up with
  earlier layers to within a single ~128-sample audio render quantum instead
  of drifting on `setTimeout`.
- **Looper model**: the first take you record sets the loop length. Every
  later "Record" tap restarts that loop (existing layers play back per
  their mute/solo/enable state) while capturing a new layer on top — classic
  hardware-looper workflow, and the simplest way to guarantee sample-accurate
  alignment between layers.
- **Track routing** (`src/audioEngine.js`): each track gets its own
  persistent `GainNode`. Mute/Solo/Layer-toggle just update that gain's
  target value live — no need to re-schedule audio — so routing changes take
  effect immediately during playback.
- **Track colors**: Cyan, Lime, Orange, Magenta, then Yellow/Purple/Red/Teal
  for additional layers (`TRACK_COLORS` in `src/noteUtils.js`).

## Project structure

```
index.html                     Markup + mobile viewport/meta setup
style.css                      Dark-mode, mobile-first layout
src/
  main.js                      Wires DOM, AudioEngine, PitchGrid, TrackPanel; the render loop
  audioEngine.js                AudioContext, mic capture, loop scheduler, mute/solo routing
  recorderWorkletProcessor.js  AudioWorklet processor (runs on the audio thread)
  pitchDetector.js             Autocorrelation pitch detection
  pitchGrid.js                 Canvas rendering of the note/time grid + pitch curves
  trackPanel.js                Track list UI (Mute/Solo/Toggle/Delete)
  noteUtils.js                 Note/frequency math, F2–A5 range, track color palette
```

## Running it locally

Any static file server works — the app is plain ES modules, no bundler
required.

```bash
# from the project root
python3 -m http.server 8080
# or: npx serve -l 8080
```

Then open `http://localhost:8080` in a desktop browser to sanity-check the
UI (you'll still need to allow mic access).

## Testing from your phone

Mobile browsers only allow microphone access (`getUserMedia`) on a
**secure context**: `https://` or `localhost`. Your phone visiting your
computer's LAN IP over plain `http://` will **not** be allowed to use the
mic, even on the same Wi-Fi. Pick one of these:

### Option A — quick tunnel (simplest, recommended)

Get a temporary public HTTPS URL that proxies to your local server:

```bash
python3 -m http.server 8080
# in another terminal:
npx localtunnel --port 8080
# or, if you have ngrok installed/authenticated:
ngrok http 8080
```

Open the `https://...` URL it prints on your phone. Done — no certificates
to install.

### Option B — LAN + trusted local HTTPS cert (works offline)

1. Install [mkcert](https://github.com/FiloSottile/mkcert) and generate a
   cert for your machine's LAN IP:
   ```bash
   mkcert -install
   mkcert 192.168.1.23   # replace with your computer's LAN IP
   ```
2. Serve with TLS, e.g. with Node:
   ```bash
   npx http-server -S -C 192.168.1.23.pem -K 192.168.1.23-key.pem -p 8080
   ```
3. On your phone (same Wi-Fi), install/trust the mkcert root CA (mkcert
   prints instructions — usually AirDrop/email the `rootCA.pem` and trust it
   under iOS Settings → General → About → Certificate Trust Settings), then
   visit `https://192.168.1.23:8080`.

This is more setup than Option A but doesn't depend on an external tunnel
service.

### Notes for on-device testing

- Tap **"Enable Mic & Audio"** first — mobile browsers require a user
  gesture before `AudioContext` can start and before the mic permission
  prompt will fire.
- **Use headphones or earbuds.** Playing loop audio out of the phone speaker
  while the mic is live will bleed into the next recording and confuse the
  pitch tracker.
- If Safari shows a mic permission prompt every reload, check
  Settings → Safari → Microphone Access is set to "Allow".
- Recording is capped in real time — recording longer than the loop length
  during an overdub is automatically clipped to the loop length so layers
  can never drift out of sync.

## Known limitations

- The looper always restarts a fresh pass from the top when you hit
  Record/Play; there's no mid-loop punch-in.
- Backgrounding the tab/app (screen lock, app switch) can suspend the
  `AudioContext` on iOS; reopen the page and tap Enable again if audio
  stops responding.
- Pitch detection assumes a single monophonic voice (standard for vocal
  practice); it will not track polyphony/chords.
