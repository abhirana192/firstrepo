// Runs on the audio rendering thread. Forwards raw mono PCM frames to the
// main thread while "armed", gated by the AudioContext clock so a new
// track's first captured sample lines up with the loop origin to within
// one render quantum (~128 samples) instead of drifting on JS timers.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.startAt = 0;
    this.port.onmessage = (event) => {
      const { cmd, time } = event.data;
      if (cmd === "arm") {
        this.startAt = typeof time === "number" ? time : currentTime;
        this.active = true;
      } else if (cmd === "stop") {
        this.active = false;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (this.active && input && input[0] && currentTime >= this.startAt) {
      // Copy out — the underlying buffer is reused by the audio thread.
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}

registerProcessor("recorder-processor", RecorderProcessor);
