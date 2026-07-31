// Autocorrelation-based pitch detector (ACF2+ style), bounded to the
// vocal range we care about so it stays cheap enough for 60fps on a phone.

const MIN_FREQ_HZ = 55;   // below the C2 grid floor, gives the parabolic fit some headroom
const MAX_FREQ_HZ = 1100; // above A5, same reason
const ANALYSIS_WINDOW = 1536; // samples correlated at each lag (needs the bigger analyser buffer to fit)
const RMS_SILENCE_THRESHOLD = 0.005;

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

  let bestLag = -1;
  let bestCorr = 0;
  const corr = new Float32Array(maxLag + 2);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      sum += buffer[i] * buffer[i + lag];
    }
    corr[lag] = sum;
    if (sum > bestCorr) {
      bestCorr = sum;
      bestLag = lag;
    }
  }

  if (bestLag <= minLag || bestLag >= maxLag) return -1;

  // Normalize against zero-lag energy to reject noise / weak periodicity.
  let energy = 0;
  for (let i = 0; i < window; i++) energy += buffer[i] * buffer[i];
  const confidence = energy > 0 ? bestCorr / energy : 0;
  if (confidence < 0.35) return -1;

  // Parabolic interpolation around the peak for sub-sample lag precision.
  const x1 = corr[bestLag - 1];
  const x2 = corr[bestLag];
  const x3 = corr[bestLag + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  const refinedLag = a !== 0 ? bestLag - b / (2 * a) : bestLag;

  const freq = sampleRate / refinedLag;
  if (freq < MIN_FREQ_HZ * 0.8 || freq > MAX_FREQ_HZ * 1.2) return -1;
  return freq;
}
