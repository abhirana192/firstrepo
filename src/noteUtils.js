// Music-theory helpers: MIDI <-> frequency <-> note name, and the fixed
// F2 - A5 display range used by the pitch grid.

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiToNoteName(midi) {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

// F2 = MIDI 41 (~87.31 Hz), A5 = MIDI 81 (880 Hz) — the practice range
// requested for the vocal monitor grid.
export const MIN_MIDI = 41;
export const MAX_MIDI = 81;
export const MIN_FREQ = midiToFreq(MIN_MIDI);
export const MAX_FREQ = midiToFreq(MAX_MIDI);

// Bright, distinct per-track palette. Cycles if more layers are recorded.
export const TRACK_COLORS = [
  "#00e5ff", // Track 1 - Cyan
  "#76ff03", // Track 2 - Lime Green
  "#ff9100", // Track 3 - Orange
  "#ff00e5", // Track 4 - Magenta
  "#ffea00", // Track 5 - Yellow
  "#7c4dff", // Track 6 - Purple
  "#ff1744", // Track 7 - Red
  "#1de9b6", // Track 8 - Teal
];
