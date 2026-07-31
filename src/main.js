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
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");
const downloadMixBtn = document.getElementById("downloadMixBtn");
const gainSlider = document.getElementById("gainSlider");
const gainValue = document.getElementById("gainValue");

let timeDomainBuffer = null;
let transportState = { isPlaying: false, isRecording: false, loopDuration: null };

// Restore last-used gain (device mic levels vary a lot; no single default
// is right for everyone, so this is meant to be tuned live and remembered).
const storedGain = parseFloat(localStorage.getItem("vocalPracticeInputGain"));
if (!Number.isNaN(storedGain)) {
  engine.inputGain = storedGain;
  gainSlider.value = String(storedGain);
}
gainValue.textContent = `${parseFloat(gainSlider.value).toFixed(1)}x`;

gainSlider.addEventListener("input", () => {
  const value = parseFloat(gainSlider.value);
  gainValue.textContent = `${value.toFixed(1)}x`;
  engine.setInputGain(value);
  localStorage.setItem("vocalPracticeInputGain", String(value));
});
const pitchSmoother = new PitchSmoother();

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
  downloadMixBtn.disabled = engine.tracks.length === 0;

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

enableBtn.addEventListener("click", async () => {
  enableBtn.disabled = true;
  enableBtn.textContent = "Requesting mic…";
  try {
    await engine.init();
    timeDomainBuffer = new Float32Array(engine.analyser.fftSize);
    overlay.classList.add("hidden");
    recordBtn.disabled = false;
    gainSlider.disabled = false;
    statusText.textContent = "Record your first take to set the loop length";
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

zoomInBtn.addEventListener("click", () => grid.zoomIn());
zoomOutBtn.addEventListener("click", () => grid.zoomOut());
zoomResetBtn.addEventListener("click", () => grid.resetView());

playBtn.addEventListener("click", () => engine.play());
stopBtn.addEventListener("click", () => engine.stop());
resetBtn.addEventListener("click", () => {
  if (confirm("Clear all layers and start a new loop?")) engine.resetLoop();
});

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
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
