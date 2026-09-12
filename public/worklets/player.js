// Playback worklet: queues 24 kHz PCM16 chunks, resamples to the context rate and reports how many
// milliseconds were actually rendered so a barge-in can tell the server what the user heard.
// The drain-the-queue design follows the google-adk realtime example and the played-ms accounting
// follows hermes-live-voice (both MIT), see NOTICE.
const SOURCE_RATE = 24000;
const PREBUFFER_SAMPLES = Math.round(SOURCE_RATE * 0.08);
const MAX_WAIT_CALLS = 40;
const REPORT_INTERVAL_SEC = 0.1;

class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset();
    this.port.onmessage = (event) => {
      if (event.data === 'clear') {
        this.reset();
        return;
      }
      this.queue.push(new Int16Array(event.data));
      this.queued += this.queue[this.queue.length - 1].length;
      this.hadData = true;
    };
  }

  reset() {
    this.queue = [];
    this.head = 0;
    this.queued = 0;
    this.playing = false;
    this.waitCalls = 0;
    this.hadData = false;
    this.cur = 0;
    this.next = 0;
    this.phase = 1;
    this.consumed = 0;
    this.sinceReport = 0;
  }

  readSample() {
    if (this.queue.length === 0) return null;
    const chunk = this.queue[0];
    const value = chunk[this.head] / 32768;
    this.head += 1;
    this.queued -= 1;
    this.consumed += 1;
    if (this.head >= chunk.length) {
      this.queue.shift();
      this.head = 0;
    }
    return value;
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const ratio = SOURCE_RATE / sampleRate;

    if (!this.playing) {
      if (this.queued >= PREBUFFER_SAMPLES || (this.queued > 0 && this.waitCalls >= MAX_WAIT_CALLS)) {
        this.playing = true;
        this.waitCalls = 0;
      } else {
        if (this.queued > 0) this.waitCalls += 1;
        out.fill(0);
        return true;
      }
    }

    for (let i = 0; i < out.length; i += 1) {
      while (this.phase >= 1) {
        const sample = this.readSample();
        if (sample === null) {
          this.finish(out, i);
          return true;
        }
        this.cur = this.next;
        this.next = sample;
        this.phase -= 1;
      }
      out[i] = this.cur + (this.next - this.cur) * this.phase;
      this.phase += ratio;
    }
    this.report(out.length);
    return true;
  }

  finish(out, from) {
    out.fill(0, from);
    this.playing = false;
    this.phase = 1;
    this.report(from, true);
    if (this.hadData) {
      this.hadData = false;
      this.port.postMessage({ type: 'drained', ms: Math.round((this.consumed / SOURCE_RATE) * 1000) });
    }
  }

  report(renderedFrames, force = false) {
    this.sinceReport += renderedFrames / sampleRate;
    if (!force && this.sinceReport < REPORT_INTERVAL_SEC) return;
    this.sinceReport = 0;
    this.port.postMessage({ type: 'played', ms: Math.round((this.consumed / SOURCE_RATE) * 1000) });
  }
}

registerProcessor('hermes-player', PlayerProcessor);
