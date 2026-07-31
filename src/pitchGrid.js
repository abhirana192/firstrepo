import { MIN_MIDI, MAX_MIDI, freqToMidi, midiToNoteName } from "./noteUtils.js";

const SCROLL_WINDOW_SEC = 8; // width of the live monitor before a loop length exists
const NATURAL_NOTE_RE = /^[A-G]\d$/;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const FULL_MIDI_SPAN = MAX_MIDI - MIN_MIDI;

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Dark-mode vocal monitor grid: a vertical note axis (F2-A5) and a
 * horizontal time axis. Before a loop length is established it behaves
 * like a scrolling strip chart of the live take; once a loop exists it
 * shows the full loop width with a sweeping playhead and every track's
 * pitch curve overlaid in its own color. Supports pinch-to-zoom, drag-to-pan
 * (once zoomed), mouse-wheel zoom, and double-tap/double-click to reset.
 */
export class PitchGrid {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    this.zoom = 1;
    this.centerMidi = (MIN_MIDI + MAX_MIDI) / 2;
    this.centerTimeSec = null; // lazily set once loop duration is known
    this._lastState = {};
    this._lastLoopDurationSeen = undefined;

    this._resize();
    // ResizeObserver tracks flex/viewport changes (e.g. iOS Safari's
    // collapsing address bar) more reliably than the window resize event.
    if (window.ResizeObserver) {
      new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    } else {
      window.addEventListener("resize", () => this._resize());
    }

    this._initGestures();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.width = rect.width;
    this.height = rect.height;
  }

  resetView() {
    this.zoom = 1;
    this.centerMidi = (MIN_MIDI + MAX_MIDI) / 2;
    this.centerTimeSec = null;
  }

  /** Zoom in/out around the current view center (for +/- button controls). */
  zoomBy(factor) {
    const ranges = this._currentVisibleRanges();
    const newZoom = clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this._applyZoomAtAnchor(newZoom, { x: 0.5, y: 0.5 }, this.centerMidi, ranges.mode === "loop" ? this.centerTimeSec : null);
  }
  zoomIn() {
    this.zoomBy(1.4);
  }
  zoomOut() {
    this.zoomBy(1 / 1.4);
  }

  // --- Coordinate transforms (all take an explicit `ranges` so gesture
  // handlers and render() share identical math) ------------------------

  _currentVisibleRanges() {
    const midiSpan = FULL_MIDI_SPAN / this.zoom;
    let midiMin = clamp(this.centerMidi - midiSpan / 2, MIN_MIDI, MAX_MIDI - midiSpan);
    this.centerMidi = midiMin + midiSpan / 2;

    const state = this._lastState || {};
    let timeMin, timeSpan, mode;
    if (state.loopDuration != null) {
      mode = "loop";
      const fullTimeSpan = state.loopDuration;
      timeSpan = fullTimeSpan / this.zoom;
      if (this.centerTimeSec == null) this.centerTimeSec = fullTimeSpan / 2;
      timeMin = clamp(this.centerTimeSec - timeSpan / 2, 0, Math.max(0, fullTimeSpan - timeSpan));
      this.centerTimeSec = timeMin + timeSpan / 2;
    } else {
      mode = "scroll";
      timeSpan = SCROLL_WINDOW_SEC / this.zoom;
      timeMin = (state.nowElapsed || 0) - timeSpan;
    }
    return { midiMin, midiSpan, timeMin, timeSpan, mode };
  }

  _midiToY(midi, ranges) {
    return this.height - ((midi - ranges.midiMin) / ranges.midiSpan) * this.height;
  }
  _yToMidi(yPixel, ranges) {
    return ranges.midiMin + (1 - yPixel / this.height) * ranges.midiSpan;
  }
  _freqToY(freq, ranges) {
    return this._midiToY(freqToMidi(freq), ranges);
  }
  _timeToX(t, ranges) {
    return ((t - ranges.timeMin) / ranges.timeSpan) * this.width;
  }
  _xToTime(xPixel, ranges) {
    return ranges.timeMin + (xPixel / this.width) * ranges.timeSpan;
  }

  // --- Gestures: pinch-zoom, drag-to-pan, wheel-zoom, double-tap reset --

  _initGestures() {
    this.canvas.style.touchAction = "none";
    this._pointers = new Map();
    this._pinchStartDist = null;
    this._lastTapTime = 0;
    this._lastTapPos = null;

    this.canvas.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    this.canvas.addEventListener("pointermove", (e) => this._onPointerMove(e));
    this.canvas.addEventListener("pointerup", (e) => this._onPointerUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this._onPointerUp(e));
    this.canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    this.canvas.addEventListener("dblclick", () => this.resetView());
  }

  _pointerPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onPointerDown(e) {
    const pos = this._pointerPos(e);
    this.canvas.setPointerCapture(e.pointerId);
    this._pointers.set(e.pointerId, pos);

    if (this._pointers.size === 1) {
      this._panStart = { x: pos.x, y: pos.y, ranges: this._currentVisibleRanges() };
      const now = performance.now();
      if (this._lastTapPos && now - this._lastTapTime < 350 && Math.hypot(pos.x - this._lastTapPos.x, pos.y - this._lastTapPos.y) < 24) {
        this.resetView();
        this._lastTapTime = 0;
        this._lastTapPos = null;
      } else {
        this._lastTapTime = now;
        this._lastTapPos = pos;
      }
    } else if (this._pointers.size === 2) {
      this._beginPinch();
    }
  }

  _onPointerMove(e) {
    if (!this._pointers.has(e.pointerId)) return;
    const pos = this._pointerPos(e);
    this._pointers.set(e.pointerId, pos);

    if (this._pointers.size >= 2) {
      this._updatePinch();
    } else if (this._pointers.size === 1 && this.zoom > 1 && this._panStart) {
      this._updatePan(pos);
    }
  }

  _onPointerUp(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinchStartDist = null;
    if (this._pointers.size === 1) {
      const pos = [...this._pointers.values()][0];
      this._panStart = { x: pos.x, y: pos.y, ranges: this._currentVisibleRanges() };
    } else if (this._pointers.size === 0) {
      this._panStart = null;
    }
  }

  _beginPinch() {
    const pts = [...this._pointers.values()];
    this._pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    this._pinchStartZoom = this.zoom;
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const ranges = this._currentVisibleRanges();
    this._pinchMidiAtStart = this._yToMidi(mid.y, ranges);
    this._pinchTimeAtStart = ranges.mode === "loop" ? this._xToTime(mid.x, ranges) : null;
    this._pinchFrac = { x: mid.x / this.width, y: mid.y / this.height };
  }

  _updatePinch() {
    if (this._pinchStartDist == null) return;
    const pts = [...this._pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (dist < 1) return;
    this._applyZoomAtAnchor(
      clamp(this._pinchStartZoom * (dist / this._pinchStartDist), MIN_ZOOM, MAX_ZOOM),
      this._pinchFrac,
      this._pinchMidiAtStart,
      this._pinchTimeAtStart
    );
  }

  _updatePan(pos) {
    const { x: startX, y: startY, ranges } = this._panStart;
    const dataMidi = this._yToMidi(startY, ranges);
    const dataTime = ranges.mode === "loop" ? this._xToTime(startX, ranges) : null;
    this.centerMidi = dataMidi + ranges.midiSpan * (pos.y / this.height - 0.5);
    if (dataTime != null) {
      this.centerTimeSec = dataTime - ranges.timeSpan * (pos.x / this.width - 0.5);
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const pos = this._pointerPos(e);
    const ranges = this._currentVisibleRanges();
    const dataMidi = this._yToMidi(pos.y, ranges);
    const dataTime = ranges.mode === "loop" ? this._xToTime(pos.x, ranges) : null;
    const factor = Math.exp(-e.deltaY * 0.0015);
    this._applyZoomAtAnchor(clamp(this.zoom * factor, MIN_ZOOM, MAX_ZOOM), { x: pos.x / this.width, y: pos.y / this.height }, dataMidi, dataTime);
  }

  _applyZoomAtAnchor(newZoom, frac, anchorMidi, anchorTime) {
    this.zoom = newZoom;
    const newMidiSpan = FULL_MIDI_SPAN / this.zoom;
    this.centerMidi = anchorMidi + newMidiSpan * (frac.y - 0.5);
    if (anchorTime != null && this._lastState.loopDuration != null) {
      const newTimeSpan = this._lastState.loopDuration / this.zoom;
      this.centerTimeSec = anchorTime - newTimeSpan * (frac.x - 0.5);
    }
  }

  // --- Drawing -----------------------------------------------------------

  _drawNoteLines(ranges) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    const showAccidentals = ranges.midiSpan <= 14;
    const lo = Math.max(MIN_MIDI, Math.floor(ranges.midiMin));
    const hi = Math.min(MAX_MIDI, Math.ceil(ranges.midiMin + ranges.midiSpan));
    for (let midi = lo; midi <= hi; midi++) {
      const name = midiToNoteName(midi);
      const isNatural = NATURAL_NOTE_RE.test(name);
      if (!isNatural && !showAccidentals) continue;
      const y = this._midiToY(midi, ranges);
      ctx.strokeStyle = isNatural ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
      ctx.fillStyle = isNatural ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.14)";
      ctx.fillText(name, 4, y - 1);
    }
    ctx.restore();
  }

  // Smooth, understated pitch line: a faint wide glow pass under a thin
  // crisp core, rather than one thick neon stroke.
  _drawCurve(points, color, ranges, dim) {
    const ctx = this.ctx;
    const path = new Path2D();
    let drawing = false;
    let any = false;

    for (const p of points) {
      const x = this._timeToX(p.time, ranges);
      if (x < -10 || x > this.width + 10 || p.freq == null) {
        drawing = false;
        continue;
      }
      const y = this._freqToY(p.freq, ranges);
      if (!drawing) {
        path.moveTo(x, y);
        drawing = true;
      } else {
        path.lineTo(x, y);
      }
      any = true;
    }
    if (!any) return;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = color;

    ctx.shadowColor = color;
    ctx.shadowBlur = 9;
    ctx.lineWidth = 3;
    ctx.globalAlpha = dim ? 0.12 : 0.22;
    ctx.stroke(path);

    ctx.shadowBlur = 1.5;
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = dim ? 0.32 : 0.88;
    ctx.stroke(path);
    ctx.restore();
  }

  _drawLiveDot(freq, x, color, ranges) {
    const ctx = this.ctx;
    const y = this._freqToY(freq, ranges);
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawPlayhead(x) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.height);
    ctx.stroke();
    ctx.restore();
  }

  _drawZoomHint() {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "10.5px -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    const label = this.zoom > 1.01 ? `${this.zoom.toFixed(1)}x · double-tap to reset` : "pinch to zoom";
    ctx.fillText(label, this.width - 6, this.height - 6);
    ctx.restore();
  }

  /**
   * @param {object} state
   * @param {Array} state.tracks
   * @param {number|null} state.loopDuration
   * @param {number} state.playheadTime
   * @param {boolean} state.isRecording
   * @param {number|null} state.recordingTrackId
   * @param {Array} state.liveRecordingPoints - pitch points for the in-progress take
   * @param {number} state.nowElapsed - elapsed seconds for scrolling/live mode
   * @param {number} state.liveFreq - current live-detected frequency, or -1
   * @param {string} state.liveColor
   */
  render(state) {
    this._lastState = state;
    if (state.loopDuration !== this._lastLoopDurationSeen) {
      this._lastLoopDurationSeen = state.loopDuration;
      this.resetView();
    }

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, this.width, this.height);

    const ranges = this._currentVisibleRanges();
    this._drawNoteLines(ranges);

    const { tracks, loopDuration, playheadTime, isRecording, liveRecordingPoints, liveFreq, liveColor } = state;

    for (const track of tracks) {
      if (!track.enabled) continue;
      this._drawCurve(track.pitchData, track.color, ranges, track.muted);
    }

    if (isRecording && liveRecordingPoints) {
      this._drawCurve(liveRecordingPoints, liveColor, ranges, false);
    }

    if (loopDuration !== null) {
      const x = this._timeToX(playheadTime, ranges);
      this._drawPlayhead(x);
    }

    if (liveFreq > 0) {
      const x = loopDuration !== null ? this._timeToX(playheadTime, ranges) : this.width - 6;
      this._drawLiveDot(liveFreq, x, liveColor, ranges);
    }

    this._drawZoomHint();
  }
}
