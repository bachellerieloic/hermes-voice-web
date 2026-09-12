// Microphone capture worklet: resamples the input to 16 kHz with linear interpolation and posts
// fixed-size PCM16 frames as transferable ArrayBuffers. The frame-and-flush pattern follows
// hermes-live-voice (MIT), see NOTICE.
const TARGET_RATE = 16000;
const DEFAULT_FRAME_MS = 40;

class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const frameMs = Number(options?.processorOptions?.frameMs ?? DEFAULT_FRAME_MS);
    const clampedMs = Number.isFinite(frameMs) ? Math.max(20, Math.min(50, frameMs)) : DEFAULT_FRAME_MS;
    this.frame = new Int16Array(Math.round((TARGET_RATE * clampedMs) / 1000));
    this.index = 0;
    this.phase = 0;
    this.last = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush();
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;
    const ratio = sampleRate / TARGET_RATE;
    const n = input.length;
    let t = this.phase;
    while (t < n) {
      const i = Math.floor(t);
      const frac = t - i;
      const a = i === 0 ? this.last : input[i - 1];
      const b = input[i];
      this.push(a + (b - a) * frac);
      t += ratio;
    }
    this.phase = t - n;
    this.last = input[n - 1];
    return true;
  }

  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.frame[this.index] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    this.index += 1;
    if (this.index >= this.frame.length) this.flush();
  }

  flush() {
    if (this.index === 0) return;
    const bytes = this.frame.slice(0, this.index).buffer;
    this.port.postMessage(bytes, [bytes]);
    this.index = 0;
  }
}

registerProcessor('hermes-mic', MicProcessor);
