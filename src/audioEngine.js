import { TRACK_COLORS } from "./noteUtils.js";

const LEAD_IN = 0.06; // seconds of scheduling headroom for Web Audio start() calls
const SCHEDULE_AHEAD = 0.2; // how far ahead the loop scheduler queues the next iteration

// tanh-shaped soft clipper: near-identity for quiet/moderate input, rounds
// off smoothly toward the driven gain's high end instead of hard-clipping.
// A lower drive keeps the pass-band closer to true identity (a tanh curve
// normalized to its endpoint inherently adds a bit of gain near zero —
// higher drive means more of it, which is part of what made an earlier
// version of this chain louder than intended).
function buildSoftClipCurve() {
  const n = 2048;
  const drive = 0.8;
  const norm = Math.tanh(drive);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

// Scales `data` down in place if its peak exceeds `ceiling`; leaves it
// untouched otherwise so quieter takes aren't attenuated unnecessarily.
function normalizePeak(data, ceiling) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak <= ceiling) return;
  const scale = ceiling / peak;
  for (let i = 0; i < data.length; i++) data[i] *= scale;
}

/**
 * Loop-based multi-track vocal recorder/looper.
 *
 * The first recorded take defines the loop length. Every subsequent
 * "Record" starts that same loop playing back (respecting mute/solo/layer
 * toggles) while simultaneously capturing a new layer, both keyed off a
 * single AudioContext-clock origin so layers stay sample-aligned instead
 * of drifting on JS timers.
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.micStream = null;
    this.sourceNode = null;
    this.analyser = null;
    this.recorderNode = null;
    this.masterGain = null;

    this.tracks = []; // { id, name, color, buffer, pitchData, muted, soloed, enabled, durationSec }
    this._trackGains = new Map(); // id -> persistent GainNode
    this._activeSources = []; // sources scheduled for the current/next loop iteration
    // Monotonic, never reused — tracks.length + 1 would reassign a
    // deleted track's old id to the next recording, colliding with any
    // surviving track that still has it (corrupting the gain-node map and
    // making mute/solo/delete affect the wrong track).
    this._nextTrackId = 1;

    this.loopDuration = null;
    this.loopOriginCtxTime = null;
    this._nextIterationStart = null;
    this.isPlaying = false;
    this.isRecording = false;
    this.recordingTrackId = null;
    this._recordChunks = [];
    this._lastKnownPlayheadTime = 0; // persists the scrub position across stop/start, for punch-in
    this._isPunchIn = false;
    this._punchInTrackId = null;
    this._punchInStartPoint = 0;

    // How loud AGC leaves the raw mic signal varies a lot by device, so
    // there's no single correct default — this is user-adjustable live via
    // setInputGain() rather than guessed once in code.
    this.inputGain = 2.5;

    this.onTracksChanged = null;
    this.onTransportChanged = null;
    this.onRecordingStalled = null;
  }

  async init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();

    // Echo cancellation and noise suppression apply adaptive filtering that
    // can distort the waveform pitch detection relies on, so those stay
    // off. Auto gain control is left on (the default) — phone mic input
    // without it is often too quiet to detect or hear back on playback.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false },
      });
    } catch (err) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    this.micStream = stream;

    await this.ctx.audioWorklet.addModule("src/recorderWorkletProcessor.js");

    this.sourceNode = this.ctx.createMediaStreamSource(stream);

    // getUserMedia's autoGainControl is already doing the primary loudness
    // normalization on-device (real hardware AGC, unlike the synthetic
    // fake-audio-capture used in testing, which doesn't simulate it — that
    // gap is exactly what let the previous, much hotter version of this
    // chain go unnoticed: stacking a second full normalizer on top of AGC
    // compounded into audibly "too much gain"). This chain is now a light
    // supplementary touch on top of AGC, not a second normalizer: a gentle
    // compressor for safety headroom, a modest makeup nudge, and a soft-
    // saturation curve as a true (non-harsh) ceiling for stray peaks.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 2.5;
    this.compressor.attack.value = 0.02;
    this.compressor.release.value = 0.2;

    this.makeupGain = this.ctx.createGain();
    this.makeupGain.gain.value = this.inputGain;

    this.saturator = this.ctx.createWaveShaper();
    this.saturator.curve = buildSoftClipCurve();
    this.saturator.oversample = "4x";

    this.sourceNode.connect(this.compressor);
    this.compressor.connect(this.makeupGain);
    this.makeupGain.connect(this.saturator);
    this.processedInput = this.saturator;

    // A bigger analysis window gives the pitch detector enough cycles of
    // a low bass note to autocorrelate reliably (2048 samples starts
    // running out of headroom well before F2, contributing to low notes
    // getting dropped).
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    this.processedInput.connect(this.analyser);

    this.recorderNode = new AudioWorkletNode(this.ctx, "recorder-processor");
    this.processedInput.connect(this.recorderNode);
    this.recorderNode.port.onmessage = (event) => {
      if (this.isRecording) this._recordChunks.push(event.data);
    };

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.ctx.destination);

    // Some mobile browsers only keep pulling nodes for processing while
    // they're part of a graph that reaches the destination. The analyser
    // and recorder never output audible sound of their own, so route them
    // to the destination through a silent (zero-gain) sink purely to keep
    // them actively processing on every render quantum.
    this._silentSink = this.ctx.createGain();
    this._silentSink.gain.value = 0;
    this.analyser.connect(this._silentSink);
    this.recorderNode.connect(this._silentSink);
    this._silentSink.connect(this.ctx.destination);

    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  getLiveTimeDomainData(target) {
    this.analyser.getFloatTimeDomainData(target);
  }

  /** Live-adjustable input gain (applies instantly, no restart needed). */
  setInputGain(value) {
    this.inputGain = value;
    if (this.makeupGain) {
      this.makeupGain.gain.linearRampToValueAtTime(value, this.ctx.currentTime + 0.05);
    }
  }

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  // --- Transport -----------------------------------------------------

  /**
   * Mobile browsers (iOS Safari in particular) can silently suspend the
   * AudioContext during any sufficiently long blocking pause — a native
   * confirm() dialog, backgrounding the tab, a screen lock — with no event
   * telling the page it happened. If that occurs, the whole audio graph
   * simply stops processing: the recorder worklet never fires, so
   * recording looks like it starts (isRecording flips true, the UI
   * updates) but silently captures nothing. Every entry point that starts
   * audio activity resumes defensively first rather than assuming the
   * context is already running.
   */
  async _ensureRunning() {
    if (this.ctx && this.ctx.state !== "running") {
      try {
        // resume() has been observed to hang indefinitely rather than
        // reject in some mobile states; never let it block recording
        // from at least attempting to proceed.
        await Promise.race([this.ctx.resume(), new Promise((resolve) => setTimeout(resolve, 800))]);
      } catch (err) {
        console.error("AudioContext resume failed:", err);
      }
    }
  }

  async startRecording() {
    if (this.isRecording || !this.ctx) return;
    await this._ensureRunning();
    if (this.isRecording || !this.ctx) return; // re-check: state may have changed during the await
    const id = this._nextTrackId++;
    const track = {
      id,
      name: `Track ${id}`,
      color: TRACK_COLORS[(id - 1) % TRACK_COLORS.length],
      buffer: null,
      pitchData: [],
      muted: false,
      soloed: false,
      enabled: true,
      durationSec: 0,
    };

    const gain = this.ctx.createGain();
    gain.connect(this.masterGain);
    this._trackGains.set(id, gain);

    this._recordChunks = [];
    this.recordingTrackId = id;
    this._pendingTrack = track;

    if (this.loopDuration === null) {
      // First take: starts immediately, defines the loop length once stopped.
      const startAt = this.ctx.currentTime + 0.02;
      this.recorderNode.port.postMessage({ cmd: "arm", time: startAt });
      this.recordStartCtxTime = startAt;
      this.isRecording = true;
      this.isPlaying = false;
      this.loopOriginCtxTime = startAt;
    } else {
      // Overdub: (re)start the whole loop now and arm recording at the
      // same instant so the new layer lines up with existing ones.
      this._stopScheduledSources();
      const startAt = this.ctx.currentTime + LEAD_IN;
      this.loopOriginCtxTime = startAt;
      this._nextIterationStart = startAt;
      this.recordStartCtxTime = startAt;
      this.recorderNode.port.postMessage({ cmd: "arm", time: startAt });
      this.isRecording = true;
      this.isPlaying = true;
      this._scheduleIteration(startAt, /* excludeId */ id);
      this._nextIterationStart = startAt + this.loopDuration;
    }

    this._emitTransport();

    // Recording having started (isRecording=true, UI updated) doesn't
    // guarantee audio is actually flowing — a context that's stuck
    // suspended, or that resume() silently failed to wake, produces no
    // worklet messages at all, with no exception anywhere to catch. That
    // previously left the app showing "Recording…" indefinitely with no
    // way out short of a reload. Check shortly after starting whether any
    // audio has actually arrived, and self-recover if not.
    clearTimeout(this._watchdogTimer);
    this._watchdogTimer = setTimeout(() => this._checkRecordingHealth(id), 1200);
  }

  /**
   * Punch-in: re-record into an *existing* track starting from wherever
   * the scrub bar currently sits, rather than creating a new layer. Only
   * the punched-in region gets replaced — audio (and its pitch curve)
   * before the start point and after wherever you stop are left exactly
   * as they were, same as punch-in on a tape deck.
   */
  async startPunchIn(trackId) {
    if (this.isRecording || !this.ctx || this.loopDuration === null) return;
    const track = this.tracks.find((t) => t.id === trackId);
    if (!track || !track.buffer) return;
    await this._ensureRunning();
    if (this.isRecording || !this.ctx) return;

    this._isPunchIn = true;
    this._punchInTrackId = trackId;
    this._punchInStartPoint = this.getPlayheadTime();
    // Live curve rendering just needs a { pitchData, color } shape — reuse
    // the target track's own color so it reads as "this layer" while
    // recording, not a new one.
    this._pendingTrack = { pitchData: [], color: track.color };

    this._stopScheduledSources();
    const startAt = this.ctx.currentTime + LEAD_IN;
    this.loopOriginCtxTime = startAt - this._punchInStartPoint;
    this.recordStartCtxTime = startAt;
    this.recorderNode.port.postMessage({ cmd: "arm", time: startAt });
    this.isRecording = true;
    this.isPlaying = true;
    this.recordingTrackId = trackId;
    this._recordChunks = [];
    // Existing tracks (including the one being punched into) already have
    // a gain node from when they were first recorded — reuse it rather
    // than creating a new one, which would silently orphan the original.
    this._scheduleIteration(startAt, /* excludeId */ trackId);
    this._nextIterationStart = startAt + (this.loopDuration - this._punchInStartPoint);

    this._emitTransport();

    clearTimeout(this._watchdogTimer);
    this._watchdogTimer = setTimeout(() => this._checkRecordingHealth(trackId), 1200);
  }

  _checkRecordingHealth(expectedId) {
    if (!this.isRecording || this.recordingTrackId !== expectedId) return; // already resolved normally
    if (this._recordChunks.length > 0) return; // audio is flowing, all good
    console.error("Recording watchdog: no audio captured after 1.2s — recovering from a stuck AudioContext");
    this._recoverFromStalledRecording();
  }

  async _recoverFromStalledRecording() {
    this.recorderNode.port.postMessage({ cmd: "stop" });
    this.isRecording = false;
    this._recordChunks = [];
    // A punch-in's pending object has no `id` (it reuses the target
    // track's existing gain node rather than owning one) — this correctly
    // no-ops for that case and only cleans up a newly-created track's gain.
    const staleId = this._pendingTrack?.id;
    if (staleId != null) {
      this._trackGains.get(staleId)?.disconnect();
      this._trackGains.delete(staleId);
    }
    this.recordingTrackId = null;
    this._pendingTrack = null;
    this._isPunchIn = false;
    this._punchInTrackId = null;
    this._emitTransport();
    // Try to leave the context in a working state for the next attempt.
    await this._ensureRunning();
    if (this.onRecordingStalled) this.onRecordingStalled();
  }

  stopRecording() {
    if (!this.isRecording) return;
    clearTimeout(this._watchdogTimer);
    this.recorderNode.port.postMessage({ cmd: "stop" });
    this.isRecording = false;

    let total = 0;
    for (const chunk of this._recordChunks) total += chunk.length;
    const data = new Float32Array(total);
    let offset = 0;
    for (const chunk of this._recordChunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    this._recordChunks = [];

    if (this._isPunchIn) {
      this._finalizePunchIn(data);
      this._isPunchIn = false;
      this.recordingTrackId = null;
      this._pendingTrack = null;
      this._emitTracks();
      this._emitTransport();
      return;
    }

    const track = this._pendingTrack;
    const durationSec = data.length / this.sampleRate;

    if (this.loopDuration === null && durationSec < 0.15) {
      // Too short to be a usable loop (e.g. an accidental tap) — discard
      // rather than lock in a near-zero loop length, which would make the
      // scheduler spin forever trying to advance by ~0 seconds each frame.
      this.recordingTrackId = null;
      this._pendingTrack = null;
      this._trackGains.get(track.id)?.disconnect();
      this._trackGains.delete(track.id);
      this._emitTransport();
      return;
    }

    // The capture chain's saturator is tuned for headroom on the *live*
    // output stage, but the samples it writes can still land a hair past
    // ±1. Normalize once here so both loop playback and every future
    // export inherit a safe buffer, instead of relying on each downstream
    // consumer to guard against it separately.
    normalizePeak(data, 0.98);

    if (this.loopDuration === null) {
      const buffer = this.ctx.createBuffer(1, data.length, this.sampleRate);
      buffer.copyToChannel(data, 0);
      track.buffer = buffer;
      track.durationSec = durationSec;
      this.loopDuration = durationSec;
      this.tracks.push(track);
      this._nextIterationStart = this.loopOriginCtxTime + this.loopDuration;
      this.isPlaying = true;
      this._scheduleIteration(this.loopOriginCtxTime);
    } else {
      const clipSamples = Math.min(data.length, Math.round(this.loopDuration * this.sampleRate));
      const buffer = this.ctx.createBuffer(1, Math.max(clipSamples, 1), this.sampleRate);
      buffer.copyToChannel(data.subarray(0, clipSamples), 0);
      track.buffer = buffer;
      track.durationSec = clipSamples / this.sampleRate;
      this.tracks.push(track);
    }

    this.recordingTrackId = null;
    this._pendingTrack = null;
    this._emitTracks();
    this._emitTransport();
  }

  // Merges a punch-in take into its target track: the recorded region
  // (clipped to the loop boundary, same as any overdub) replaces exactly
  // that slice of the buffer and pitch curve; everything before the punch
  // point and after wherever it stopped is left untouched, same as
  // punch-in on a tape deck.
  _finalizePunchIn(data) {
    const track = this.tracks.find((t) => t.id === this._punchInTrackId);
    if (!track) return; // track was deleted mid-take — nothing sane to merge into

    normalizePeak(data, 0.98);

    const startSample = Math.round(this._punchInStartPoint * this.sampleRate);
    const maxAvailable = Math.max(0, Math.round(this.loopDuration * this.sampleRate) - startSample);
    const newSamples = Math.min(data.length, maxAvailable);
    const endSample = startSample + newSamples;
    const endPoint = endSample / this.sampleRate;

    const oldData = track.buffer.getChannelData(0);
    const finalLength = Math.max(oldData.length, endSample, 1);
    const merged = new Float32Array(finalLength);
    merged.set(oldData.subarray(0, Math.min(startSample, oldData.length)), 0);
    if (newSamples > 0) merged.set(data.subarray(0, newSamples), startSample);
    if (oldData.length > endSample) merged.set(oldData.subarray(endSample), endSample);

    const buffer = this.ctx.createBuffer(1, finalLength, this.sampleRate);
    buffer.copyToChannel(merged, 0);
    track.buffer = buffer;
    track.durationSec = finalLength / this.sampleRate;

    const newPoints = this._pendingTrack ? this._pendingTrack.pitchData : [];
    const before = track.pitchData.filter((p) => p.time < this._punchInStartPoint);
    const after = track.pitchData.filter((p) => p.time >= endPoint);
    track.pitchData = [...before, ...newPoints, ...after];
  }

  async play() {
    if (!this.ctx || this.loopDuration === null || this.isPlaying) return;
    await this._ensureRunning();
    if (!this.ctx || this.loopDuration === null || this.isPlaying) return;
    this._stopScheduledSources();
    const startAt = this.ctx.currentTime + LEAD_IN;
    this.loopOriginCtxTime = startAt;
    this._nextIterationStart = startAt;
    this.isPlaying = true;
    this._scheduleIteration(startAt);
    this._nextIterationStart = startAt + this.loopDuration;
    this._emitTransport();
  }

  stop() {
    if (this.isRecording) this.stopRecording();
    if (this.isPlaying) this._lastKnownPlayheadTime = this.getPlayheadTime();
    this._stopScheduledSources();
    this.isPlaying = false;
    this._emitTransport();
  }

  /**
   * Jumps playback to a specific point in the loop (scrubbing). Not
   * meaningful mid-recording — a new take's timing is defined by when it
   * started, not by the playhead — so this is a no-op while recording.
   */
  async seekTo(time) {
    if (!this.ctx || this.loopDuration === null || this.isRecording) return;
    await this._ensureRunning();
    if (!this.ctx || this.loopDuration === null || this.isRecording) return;
    const t = ((time % this.loopDuration) + this.loopDuration) % this.loopDuration;
    this._stopScheduledSources();
    const startAt = this.ctx.currentTime + LEAD_IN;
    // Choose the origin so the playhead reads `t` the instant playback
    // actually starts, then schedule this first (partial) pass from that
    // offset into each track's buffer; every full pass after it goes
    // through the normal tick()/_scheduleIteration(..., 0) path.
    this.loopOriginCtxTime = startAt - t;
    this.isPlaying = true;
    this._scheduleIteration(startAt, null, t);
    this._nextIterationStart = startAt + (this.loopDuration - t);
    this._emitTransport();
  }

  resetLoop() {
    this.stop();
    for (const gain of this._trackGains.values()) gain.disconnect();
    this._trackGains.clear();
    this.tracks = [];
    this.loopDuration = null;
    this.loopOriginCtxTime = null;
    this._nextIterationStart = null;
    this._nextTrackId = 1; // a full reset is a fresh session — safe (and expected) to renumber from Track 1
    this._lastKnownPlayheadTime = 0;
    this._emitTracks();
    this._emitTransport();
  }

  deleteTrack(id) {
    this.tracks = this.tracks.filter((t) => t.id !== id);
    const gain = this._trackGains.get(id);
    if (gain) {
      gain.disconnect();
      this._trackGains.delete(id);
    }
    if (this.tracks.length === 0) {
      this.loopDuration = null;
      this.loopOriginCtxTime = null;
      this._nextTrackId = 1; // nothing left — fresh session, renumber from Track 1
      this.stop();
    }
    this._emitTracks();
  }

  setMute(id, muted) {
    const t = this.tracks.find((t) => t.id === id);
    if (!t) return;
    t.muted = muted;
    this._applyGain(t);
    this._emitTracks();
  }

  setSolo(id, soloed) {
    const t = this.tracks.find((t) => t.id === id);
    if (!t) return;
    t.soloed = soloed;
    for (const track of this.tracks) this._applyGain(track);
    this._emitTracks();
  }

  setEnabled(id, enabled) {
    const t = this.tracks.find((t) => t.id === id);
    if (!t) return;
    t.enabled = enabled;
    this._applyGain(t);
    this._emitTracks();
  }

  // --- Internal scheduling --------------------------------------------

  _effectiveGain(track) {
    const anySoloed = this.tracks.some((t) => t.soloed);
    if (!track.enabled) return 0;
    if (anySoloed) return track.soloed && !track.muted ? 1 : 0;
    return track.muted ? 0 : 1;
  }

  _applyGain(track) {
    const gain = this._trackGains.get(track.id);
    if (!gain) return;
    const target = this._effectiveGain(track);
    gain.gain.linearRampToValueAtTime(target, this.ctx.currentTime + 0.02);
  }

  _scheduleIteration(startAt, excludeId = null, offset = 0) {
    for (const track of this.tracks) {
      if (!track.buffer || track.id === excludeId) continue;
      // A track can be shorter than the loop (an overdub stopped early);
      // if the seek offset lands past its own audio, there's nothing of
      // this track left to play for the remainder of this pass.
      if (offset >= track.buffer.duration) continue;
      const gain = this._trackGains.get(track.id);
      this._applyGain(track);
      const src = this.ctx.createBufferSource();
      src.buffer = track.buffer;
      src.connect(gain);
      src.start(startAt, offset);
      this._activeSources.push(src);
    }
  }

  _stopScheduledSources() {
    for (const src of this._activeSources) {
      try {
        src.stop();
      } catch (e) {
        /* already stopped */
      }
      src.disconnect();
    }
    this._activeSources = [];
  }

  /** Call once per animation frame from the main render loop. */
  tick() {
    if (!this.isPlaying || this.loopDuration === null) return;
    while (this._nextIterationStart < this.ctx.currentTime + SCHEDULE_AHEAD) {
      this._scheduleIteration(this._nextIterationStart, this.isRecording ? this.recordingTrackId : null);
      this._nextIterationStart += this.loopDuration;
    }
  }

  /**
   * Returns the current position in the loop. While playing, that's the
   * live playhead; while stopped, it's wherever playback last was —
   * needed so scrubbing to a spot, stopping, then punching in starts
   * exactly where you left the scrub bar rather than snapping to 0.
   */
  getPlayheadTime() {
    if (!this.isPlaying || this.loopOriginCtxTime === null || this.loopDuration === null) {
      return this._lastKnownPlayheadTime || 0;
    }
    const elapsed = this.ctx.currentTime - this.loopOriginCtxTime;
    const t = ((elapsed % this.loopDuration) + this.loopDuration) % this.loopDuration;
    this._lastKnownPlayheadTime = t;
    return t;
  }

  getRecordingElapsed() {
    if (!this.isRecording || this.recordStartCtxTime == null) return 0;
    return this.ctx.currentTime - this.recordStartCtxTime;
  }

  /** Appends a live-detected pitch sample to the in-progress take. */
  pushLivePitch(freq) {
    if (!this.isRecording || !this._pendingTrack) return;
    // A punch-in's own elapsed time starts at 0, but its position on the
    // loop's timeline starts at the punch-in point.
    const time = (this._isPunchIn ? this._punchInStartPoint : 0) + this.getRecordingElapsed();
    this._pendingTrack.pitchData.push({ time, freq: freq > 0 ? freq : null });
  }

  getLiveRecordingPoints() {
    return this._pendingTrack ? this._pendingTrack.pitchData : null;
  }

  getRecordingColor() {
    return this._pendingTrack ? this._pendingTrack.color : "#ffffff";
  }

  // --- Export ------------------------------------------------------------

  /** Raw AudioBuffer for a single track, regardless of its mute state. */
  getTrackBuffer(id) {
    const track = this.tracks.find((t) => t.id === id);
    return track && track.buffer ? track.buffer : null;
  }

  /**
   * Offline-renders exactly what's currently audible (same mute/solo/
   * enabled routing as live playback) into a single mixed-down AudioBuffer.
   */
  async renderMixBuffer() {
    if (this.loopDuration == null) return null;
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const length = Math.max(1, Math.round(this.loopDuration * this.sampleRate));
    const offlineCtx = new OfflineCtx(1, length, this.sampleRate);

    let anyAudible = false;
    for (const track of this.tracks) {
      if (!track.buffer) continue;
      const gain = this._effectiveGain(track);
      if (gain <= 0) continue;
      anyAudible = true;
      const src = offlineCtx.createBufferSource();
      src.buffer = track.buffer;
      const g = offlineCtx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(offlineCtx.destination);
      src.start(0);
    }
    if (!anyAudible) return null;

    // Summing multiple tracks at unity gain can exceed ±1 (OfflineAudioContext
    // doesn't clip on its own); audioBufferToWavBlob normalizes on export if
    // needed, so no extra handling is required here.
    return offlineCtx.startRendering();
  }

  _emitTracks() {
    if (this.onTracksChanged) this.onTracksChanged(this.tracks);
  }

  _emitTransport() {
    if (this.onTransportChanged) {
      this.onTransportChanged({
        isPlaying: this.isPlaying,
        isRecording: this.isRecording,
        loopDuration: this.loopDuration,
        isPunchIn: this._isPunchIn,
        punchInTrackId: this._punchInTrackId,
      });
    }
  }
}
