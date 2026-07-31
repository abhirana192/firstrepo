import { MIN_FREQ, MAX_FREQ, MIN_MIDI, MAX_MIDI, midiToFreq, midiToNoteName } from "./noteUtils.js";

const SCROLL_WINDOW_SEC = 8; // width of the live monitor before a loop length exists
const NATURAL_NOTE_RE = /^[A-G]\d$/;

/**
 * Dark-mode vocal monitor grid: a vertical note axis (F2-A5, log-scaled)
 * and a horizontal time axis. Before a loop length is established it
 * behaves like a scrolling strip chart of the live take; once a loop
 * exists it shows the full loop width with a sweeping playhead and every
 * track's pitch curve overlaid in its own color.
 */
export class PitchGrid {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this._resize();
    // ResizeObserver tracks flex/viewport changes (e.g. iOS Safari's
    // collapsing address bar) more reliably than the window resize event.
    if (window.ResizeObserver) {
      new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    } else {
      window.addEventListener("resize", () => this._resize());
    }
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.width = rect.width;
    this.height = rect.height;
  }

  _freqToY(freq) {
    const clamped = Math.min(Math.max(freq, MIN_FREQ), MAX_FREQ);
    const t = Math.log2(clamped / MIN_FREQ) / Math.log2(MAX_FREQ / MIN_FREQ);
    return this.height - t * this.height;
  }

  _drawNoteLines() {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = "10px -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    for (let midi = MIN_MIDI; midi <= MAX_MIDI; midi++) {
      const name = midiToNoteName(midi);
      const y = this._freqToY(midiToFreq(midi));
      const isNatural = NATURAL_NOTE_RE.test(name);
      ctx.strokeStyle = isNatural ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
      if (isNatural) {
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        ctx.fillText(name, 4, y - 1);
      }
    }
    ctx.restore();
  }

  _timeToX(t, loopDuration, nowElapsed) {
    if (loopDuration !== null) {
      return (t / loopDuration) * this.width;
    }
    return this.width - (nowElapsed - t) * (this.width / SCROLL_WINDOW_SEC);
  }

  _drawCurve(points, color, loopDuration, nowElapsed, dim) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = dim ? 0.35 : 1;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;

    let drawing = false;
    ctx.beginPath();
    for (const p of points) {
      const x = this._timeToX(p.time, loopDuration, nowElapsed);
      if (x < -10 || x > this.width + 10) {
        drawing = false;
        continue;
      }
      if (p.freq == null) {
        drawing = false;
        continue;
      }
      const y = this._freqToY(p.freq);
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawLiveDot(freq, x, color) {
    const ctx = this.ctx;
    const y = this._freqToY(freq);
    ctx.save();
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawPlayhead(x) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.height);
    ctx.stroke();
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
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, this.width, this.height);

    this._drawNoteLines();

    const { tracks, loopDuration, playheadTime, isRecording, recordingTrackId, liveRecordingPoints, nowElapsed, liveFreq, liveColor } = state;

    for (const track of tracks) {
      if (!track.enabled) continue;
      this._drawCurve(track.pitchData, track.color, loopDuration, nowElapsed, track.muted);
    }

    if (isRecording && liveRecordingPoints) {
      this._drawCurve(liveRecordingPoints, liveColor, loopDuration, nowElapsed, false);
    }

    if (loopDuration !== null) {
      const x = this._timeToX(playheadTime, loopDuration, nowElapsed);
      this._drawPlayhead(x);
    }

    if (liveFreq > 0) {
      const x = loopDuration !== null ? this._timeToX(playheadTime, loopDuration, nowElapsed) : this.width - 6;
      this._drawLiveDot(liveFreq, x, liveColor);
    }
  }
}
