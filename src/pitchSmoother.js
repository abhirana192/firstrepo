// Autocorrelation pitch detection occasionally misfires for a single
// frame — a breath, a consonant, a mic click — jumping an octave or more
// from the real note and back within ~30ms. A raw per-frame reading would
// draw that as a sharp vertical spike straight through the curve. A
// causal median-of-3 filter rejects any outlier that doesn't last at
// least two consecutive frames, while passing real, sustained note
// changes through with only ~1 frame of added latency.
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
    if (this.buf.length > 3) this.buf.shift();
    if (this.buf.length < 3) return this.buf[this.buf.length - 1];
    return [...this.buf].sort((a, b) => a - b)[1];
  }
}
