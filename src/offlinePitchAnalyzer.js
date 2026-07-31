import { detectPitch } from "./pitchDetector.js";

const ANALYSIS_SAMPLE_RATE = 8000; // "phone quality" — plenty above the ~1.3kHz ceiling detectPitch cares about
const HOP_SEC = 0.05; // 20 points/sec: smooth enough for a reference curve, without live-frame-rate cost
const YIELD_EVERY = 40; // hand control back to the browser this often so the page stays responsive

// Cheap decimation (no anti-alias filtering) — adequate for pitch tracking,
// where we only care about content well below the new Nyquist frequency,
// not fidelity.
function downsample(channelData, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const outLength = Math.floor(channelData.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    out[i] = channelData[Math.floor(i * ratio)];
  }
  return out;
}

/**
 * Analyzes pitch across an entire AudioBuffer (e.g. an imported reference
 * track), yielding {time, freq} points at a fixed hop rate. Runs in
 * chunks via requestAnimationFrame so a multi-minute file doesn't freeze
 * the page — onProgress(fraction) reports 0..1 for a progress indicator.
 *
 * @param {AudioBuffer} buffer
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<Array<{time: number, freq: number|null}>>}
 */
export async function analyzeBufferPitch(buffer, onProgress) {
  const original = buffer.getChannelData(0);
  const data = downsample(original, buffer.sampleRate, ANALYSIS_SAMPLE_RATE);
  const hopSamples = Math.round(HOP_SEC * ANALYSIS_SAMPLE_RATE);
  const windowSamples = Math.min(data.length, 2048); // ~256ms at 8kHz, ample for this range

  const points = [];
  let processed = 0;
  const totalHops = Math.max(1, Math.floor((data.length - windowSamples) / hopSamples) + 1);

  for (let i = 0; i + windowSamples <= data.length; i += hopSamples) {
    const chunk = data.subarray(i, i + windowSamples);
    const freq = detectPitch(chunk, ANALYSIS_SAMPLE_RATE);
    points.push({ time: i / ANALYSIS_SAMPLE_RATE, freq: freq > 0 ? freq : null });

    processed++;
    if (processed % YIELD_EVERY === 0) {
      if (onProgress) onProgress(Math.min(1, processed / totalHops));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  if (onProgress) onProgress(1);
  return points;
}
