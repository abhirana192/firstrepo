import { TRACK_COLORS } from "./noteUtils.js";

const LEAD_IN = 0.06; // seconds of scheduling headroom for Web Audio start() calls
const SCHEDULE_AHEAD = 0.2; // how far ahead the loop scheduler queues the next iteration

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

    this.loopDuration = null;
    this.loopOriginCtxTime = null;
    this._nextIterationStart = null;
    this.isPlaying = false;
    this.isRecording = false;
    this.recordingTrackId = null;
    this._recordChunks = [];

    this.onTracksChanged = null;
    this.onTransportChanged = null;
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

    // Quiet input (soft/whispered singing) is otherwise too weak to pass
    // the pitch detector's noise-floor threshold or to hear back on
    // playback. A compressor pulls quiet passages up toward audibility;
    // makeup gain then boosts overall level; a fast brickwall limiter
    // afterward keeps normal/loud singing from clipping on the way out.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -50;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.makeupGain = this.ctx.createGain();
    this.makeupGain.gain.value = 2.4;

    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.1;

    this.sourceNode.connect(this.compressor);
    this.compressor.connect(this.makeupGain);
    this.makeupGain.connect(this.limiter);
    this.processedInput = this.limiter;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
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

  get sampleRate() {
    return this.ctx.sampleRate;
  }

  // --- Transport -----------------------------------------------------

  startRecording() {
    if (this.isRecording || !this.ctx) return;
    const id = this.tracks.length + 1;
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
  }

  stopRecording() {
    if (!this.isRecording) return;
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

  play() {
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
    this._stopScheduledSources();
    this.isPlaying = false;
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

  _scheduleIteration(startAt, excludeId = null) {
    for (const track of this.tracks) {
      if (!track.buffer || track.id === excludeId) continue;
      const gain = this._trackGains.get(track.id);
      this._applyGain(track);
      const src = this.ctx.createBufferSource();
      src.buffer = track.buffer;
      src.connect(gain);
      src.start(startAt);
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

  getPlayheadTime() {
    if (!this.isPlaying || this.loopOriginCtxTime === null || this.loopDuration === null) return 0;
    const elapsed = this.ctx.currentTime - this.loopOriginCtxTime;
    return ((elapsed % this.loopDuration) + this.loopDuration) % this.loopDuration;
  }

  getRecordingElapsed() {
    if (!this.isRecording || this.recordStartCtxTime == null) return 0;
    return this.ctx.currentTime - this.recordStartCtxTime;
  }

  /** Appends a live-detected pitch sample to the in-progress take. */
  pushLivePitch(freq) {
    if (!this.isRecording || !this._pendingTrack) return;
    const time = this.getRecordingElapsed();
    this._pendingTrack.pitchData.push({ time, freq: freq > 0 ? freq : null });
  }

  getLiveRecordingPoints() {
    return this._pendingTrack ? this._pendingTrack.pitchData : null;
  }

  getRecordingColor() {
    return this._pendingTrack ? this._pendingTrack.color : "#ffffff";
  }

  _emitTracks() {
    if (this.onTracksChanged) this.onTracksChanged(this.tracks);
  }

  _emitTransport() {
    if (this.onTransportChanged) {
      this.onTransportChanged({ isPlaying: this.isPlaying, isRecording: this.isRecording, loopDuration: this.loopDuration });
    }
  }
}
