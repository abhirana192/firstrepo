import { AudioEngine } from "./audioEngine.js";
import { PitchGrid } from "./pitchGrid.js";
import { TrackPanel } from "./trackPanel.js";
import { detectPitch } from "./pitchDetector.js";
import { PitchSmoother } from "./pitchSmoother.js";
import { audioBufferToWavBlob, downloadBlob } from "./wavEncoder.js";

const engine = new AudioEngine();
const grid = new PitchGrid(document.getElementById("pitchCanvas"));
const trackPanel = new TrackPanel(
  document.getElementById("trackList"),
  document.getElementById("trackEmptyHint"),
  engine
);

const overlay = document.getElementById("notePermOverlay");
const enableBtn = document.getElementById("enableBtn");
const statusText = document.getElementById("statusText");
const loopInfo = document.getElementById("loopInfo");
const recordBtn = document.getElementById("recordBtn");
const playBtn = document.getElementById("playBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");
const downloadMixBtn = document.getElementById("downloadMixBtn");

let timeDomainBuffer = null;
let transportState = { isPlaying: false, isRecording: false, loopDuration: null };
const pitchSmoother = new PitchSmoother();

// Restore the last-used gain onto the engine itself before init() runs, so
// it's baked into the makeup-gain node at creation time. This part has no
// DOM dependency; the slider *UI* sync happens later in
// initOptionalFeatures(), after the engine (and thus the gain node) exists.
try {
  const storedGain = parseFloat(localStorage.getItem("vocalPracticeInputGain"));
  if (!Number.isNaN(storedGain)) engine.inputGain = storedGain;
} catch (err) {
  console.error("Reading stored gain failed (non-fatal):", err);
}

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function updateTransportUI() {
  const hasLoop = transportState.loopDuration !== null;
  recordBtn.classList.toggle("active", transportState.isRecording);
  playBtn.classList.toggle("playing", transportState.isPlaying && !transportState.isRecording);
  playBtn.disabled = !hasLoop || transportState.isRecording;
  stopBtn.disabled = !(transportState.isPlaying || transportState.isRecording);
  resetBtn.disabled = engine.tracks.length === 0;
  if (downloadMixBtn) downloadMixBtn.disabled = engine.tracks.length === 0;

  if (transportState.isRecording) {
    statusText.textContent = hasLoop ? "Recording overdub…" : "Recording take 1 — this sets the loop length…";
  } else if (transportState.isPlaying) {
    statusText.textContent = "Playing loop";
  } else if (hasLoop) {
    statusText.textContent = `Ready — ${engine.tracks.length} layer${engine.tracks.length === 1 ? "" : "s"}`;
  } else {
    statusText.textContent = "Record your first take to set the loop length";
  }

  loopInfo.textContent = hasLoop ? `Loop: ${fmtTime(transportState.loopDuration)}` : "";
}

engine.onTransportChanged = (t) => {
  transportState = t;
  updateTransportUI();
};

engine.onTracksChanged = (tracks) => {
  trackPanel.render(tracks);
  updateTransportUI();
};

// --- Core transport: wired first and unconditionally, so a missing or
// stale element anywhere else on the page (e.g. an older cached index.html
// paired with a newer main.js) can never prevent recording/playback from
// working — the failure mode that broke overdubbing entirely last time.

enableBtn.addEventListener("click", async () => {
  enableBtn.disabled = true;
  enableBtn.textContent = "Requesting mic…";
  try {
    await engine.init();
    timeDomainBuffer = new Float32Array(engine.analyser.fftSize);
    overlay.classList.add("hidden");
    recordBtn.disabled = false;
    statusText.textContent = "Record your first take to set the loop length";
    initOptionalFeatures();
  } catch (err) {
    console.error(err);
    enableBtn.disabled = false;
    enableBtn.textContent = "🎤 Enable Mic & Audio";
    statusText.textContent = "Microphone access failed — check permissions and retry";
  }
});

recordBtn.addEventListener("click", () => {
  if (transportState.isRecording) {
    engine.stopRecording();
  } else {
    pitchSmoother.buf = [];
    engine.startRecording();
  }
});

playBtn.addEventListener("click", () => engine.play());
stopBtn.addEventListener("click", () => engine.stop());
resetBtn.addEventListener("click", () => {
  if (confirm("Clear all layers and start a new loop?")) engine.resetLoop();
});

// --- Everything below is supplementary UI. Each piece is wrapped so that
// if one element is missing or one feature throws, the rest (including
// the core transport above) keeps working regardless.

function initOptionalFeatures() {
  try {
    const gainSlider = document.getElementById("gainSlider");
    const gainValue = document.getElementById("gainValue");
    if (gainSlider && gainValue) {
      // engine.inputGain was already restored (and baked into the makeup-
      // gain node by engine.init()) before this ran — just sync the slider
      // to reflect it.
      gainSlider.value = String(engine.inputGain);
      gainValue.textContent = `${engine.inputGain.toFixed(1)}x`;
      gainSlider.disabled = false;
      gainSlider.addEventListener("input", () => {
        const value = parseFloat(gainSlider.value);
        gainValue.textContent = `${value.toFixed(1)}x`;
        engine.setInputGain(value);
        localStorage.setItem("vocalPracticeInputGain", String(value));
      });
    }
  } catch (err) {
    console.error("Gain slider setup failed (non-fatal):", err);
  }
}

try {
  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const zoomResetBtn = document.getElementById("zoomResetBtn");
  if (zoomInBtn && zoomOutBtn && zoomResetBtn) {
    zoomInBtn.addEventListener("click", () => grid.zoomIn());
    zoomOutBtn.addEventListener("click", () => grid.zoomOut());
    zoomResetBtn.addEventListener("click", () => grid.resetView());
  }
} catch (err) {
  console.error("Zoom controls setup failed (non-fatal):", err);
}

try {
  if (downloadMixBtn) {
    downloadMixBtn.addEventListener("click", async () => {
      downloadMixBtn.disabled = true;
      const originalText = downloadMixBtn.textContent;
      downloadMixBtn.textContent = "Rendering…";
      try {
        const mixBuffer = await engine.renderMixBuffer();
        if (!mixBuffer) {
          alert("Nothing is currently audible to mix — check that at least one layer isn't muted.");
        } else {
          downloadBlob(audioBufferToWavBlob(mixBuffer), "vocal-practice-mix.wav");
        }
      } finally {
        downloadMixBtn.textContent = originalText;
        downloadMixBtn.disabled = engine.tracks.length === 0;
      }
    });
  }
} catch (err) {
  console.error("Download mix setup failed (non-fatal):", err);
}

let updateSeekBarVisual = null;

try {
  const seekBar = document.getElementById("seekBar");
  const seekBarFill = document.getElementById("seekBarFill");
  const seekBarHandle = document.getElementById("seekBarHandle");
  const seekTimeCurrent = document.getElementById("seekTimeCurrent");
  const seekTimeTotal = document.getElementById("seekTimeTotal");
  if (seekBar && seekBarFill && seekBarHandle && seekTimeCurrent && seekTimeTotal) {
    let dragging = false;

    const fracFromEvent = (e) => {
      const rect = seekBar.getBoundingClientRect();
      return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    };

    const setVisual = (frac) => {
      seekBarFill.style.width = `${frac * 100}%`;
      seekBarHandle.style.left = `${frac * 100}%`;
    };

    seekBar.addEventListener("pointerdown", (e) => {
      if (engine.loopDuration === null || engine.isRecording) return;
      dragging = true;
      seekBar.setPointerCapture(e.pointerId);
      const frac = fracFromEvent(e);
      setVisual(frac);
      engine.seekTo(frac * engine.loopDuration);
    });
    seekBar.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const frac = fracFromEvent(e);
      setVisual(frac);
      engine.seekTo(frac * engine.loopDuration);
    });
    const endDrag = () => { dragging = false; };
    seekBar.addEventListener("pointerup", endDrag);
    seekBar.addEventListener("pointercancel", endDrag);

    updateSeekBarVisual = () => {
      const hasLoop = engine.loopDuration !== null;
      seekBar.classList.toggle("disabled", !hasLoop);
      seekTimeTotal.textContent = hasLoop ? fmtTime(engine.loopDuration) : "0:00";
      if (dragging) return; // don't fight the user's finger mid-drag
      const t = engine.isPlaying ? engine.getPlayheadTime() : engine.isRecording ? engine.getRecordingElapsed() % (engine.loopDuration || 1) : 0;
      seekTimeCurrent.textContent = fmtTime(t);
      setVisual(hasLoop ? t / engine.loopDuration : 0);
    };
  }
} catch (err) {
  console.error("Seek bar setup failed (non-fatal):", err);
}

function frame() {
  if (engine.ctx && timeDomainBuffer) {
    engine.getLiveTimeDomainData(timeDomainBuffer);
    const rawFreq = detectPitch(timeDomainBuffer, engine.sampleRate);
    const freq = pitchSmoother.process(rawFreq);

    if (engine.isRecording) {
      engine.pushLivePitch(freq);
    }

    engine.tick();

    grid.render({
      tracks: engine.tracks,
      loopDuration: engine.loopDuration,
      playheadTime: engine.isPlaying ? engine.getPlayheadTime() : engine.getRecordingElapsed(),
      isRecording: engine.isRecording,
      recordingTrackId: engine.recordingTrackId,
      liveRecordingPoints: engine.getLiveRecordingPoints(),
      nowElapsed: engine.isRecording ? engine.getRecordingElapsed() : engine.getPlayheadTime(),
      liveFreq: freq,
      liveColor: engine.getRecordingColor(),
    });
  }
  if (updateSeekBarVisual) updateSeekBarVisual();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
