// YIN pitch detector (de Cheveigné & Kawahara, 2002), bounded to the
// vocal range we care about so it stays cheap enough for 60fps on a
// phone. Plain autocorrelation was tried first and reliably misidentified
// clean tones as an octave (sometimes two) off — a clean periodic signal
// correlates almost equally strongly at every integer multiple of its
// true period, so a raw argmax has no principled way to prefer the real
// fundamental over a subharmonic tie. YIN's cumulative mean normalized
// difference function specifically corrects for that by normalizing each
// lag's error against the running average of all shorter lags, which
// structurally favors the shortest (true) period instead.

const MIN_FREQ_HZ = 55;   // below the C2 grid floor, gives the parabolic fit some headroom
const MAX_FREQ_HZ = 1100; // above A5, same reason
const ANALYSIS_WINDOW = 1536; // samples differenced at each lag
const RMS_SILENCE_THRESHOLD = 0.005;
const YIN_THRESHOLD = 0.15; // standard YIN absolute threshold (de Cheveigné & Kawahara use 0.1-0.15)

/**
 * @param {Float32Array} buffer time-domain samples from an AnalyserNode
 * @param {number} sampleRate
 * @returns {number} detected frequency in Hz, or -1 if silent/unvoiced
 */
export function detectPitch(buffer, sampleRate) {
  const n = buffer.length;

  let rms = 0;
  for (let i = 0; i < n; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / n);
  if (rms < RMS_SILENCE_THRESHOLD) return -1;

  const minLag = Math.floor(sampleRate / MAX_FREQ_HZ);
  const maxLag = Math.ceil(sampleRate / MIN_FREQ_HZ);
  const window = Math.min(ANALYSIS_WINDOW, n - maxLag - 1);
  if (window < 64) return -1;

  // Step 1: difference function d(tau) = sum (x[j] - x[j+tau])^2
  const d = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let sum = 0;
    for (let j = 0; j < window; j++) {
      const diff = buffer[j] - buffer[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // Step 2: cumulative mean normalized difference function.
  // d'(tau) = d(tau) / ((1/tau) * sum_{j=1..tau} d(j))
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[minLag] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    runningSum += d[tau];
    if (tau >= minLag) {
      cmnd[tau] = d[tau] / (runningSum / tau);
    }
  }

  // Step 3: absolute threshold — take the first tau below threshold, then
  // walk forward to its local minimum (the dip usually continues a little
  // past the first sub-threshold sample).
  let tauEstimate = -1;
  for (let tau = minLag; tau <= maxLag; tau++) {
    if (cmnd[tau] < YIN_THRESHOLD) {
      while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate === -1) return -1; // no sufficiently periodic candidate — unvoiced/silence

  // Step 4: parabolic interpolation around the chosen minimum for
  // sub-sample precision.
  let betterTau = tauEstimate;
  if (tauEstimate > minLag && tauEstimate < maxLag) {
    const x1 = cmnd[tauEstimate - 1];
    const x2 = cmnd[tauEstimate];
    const x3 = cmnd[tauEstimate + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a !== 0) betterTau = tauEstimate - b / (2 * a);
  }

  const freq = sampleRate / betterTau;
  if (freq < MIN_FREQ_HZ * 0.8 || freq > MAX_FREQ_HZ * 1.2) return -1;
  return freq;
}
