// Encodes an AudioBuffer as a 16-bit PCM WAV Blob. No compressed codec
// (mp3/aac) is available without a bundled encoder library, and WAV needs
// none — every platform can open it, which is what matters for a download.
export function audioBufferToWavBlob(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // The saturator can legitimately drive a track's stored samples slightly
  // past ±1 (it only guarantees the *live* output stage stays safe), and
  // summing multiple tracks for a mixdown can push things further still.
  // Encoding a raw sample >1 with a hard clamp would be audible digital
  // clipping, so find the peak across a *copy* of the data first — never
  // mutate the caller's buffer, which may still be live for playback — and
  // scale the copy down if needed before quantizing to 16-bit PCM.
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(Float32Array.from(buffer.getChannelData(c)));

  const ceiling = 0.98;
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  }
  if (peak > ceiling) {
    const scale = ceiling / peak;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) ch[i] *= scale;
    }
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const clamped = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
