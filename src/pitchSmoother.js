// Autocorrelation pitch detection occasionally misfires for a frame or
// two — a breath, a consonant, a mic click — jumping an octave or more
// from the real note and back. A raw per-frame reading would draw that as
// a sharp vertical spike straight through the curve. A causal median-of-5
// filter rejects any outlier that doesn't last at least three consecutive
// frames, while passing real, sustained note changes through with only
// ~2 frames of added latency (well under 50ms, imperceptible visually).
const WINDOW = 5;

export class PitchSmoother {
  constructor() {
    this.buf = [];
  }

  process(rawFreq) {
    if (rawFreq <= 0) {
      this.buf = [];
      return -1;
    }
    this.buf.push(rawFreq);
    if (this.buf.length > WINDOW) this.buf.shift();
    if (this.buf.length < WINDOW) return this.buf[this.buf.length - 1];
    const mid = Math.floor(WINDOW / 2);
    return [...this.buf].sort((a, b) => a - b)[mid];
  }
}
