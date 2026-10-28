// Downmixes to mono, resamples to targetRate by box-averaging (adequate anti-aliasing for
// speech at 48k -> 16k), and posts Int16 PCM chunks of chunkMs to the main thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.ratio = sampleRate / (o.targetRate || 16000);
    this.chunk = Math.round((o.targetRate || 16000) * (o.chunkMs || 200) / 1000);
    this.buf = new Int16Array(this.chunk);
    this.n = 0;
    this.acc = 0;
    this.accN = 0;
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const a = input[0];
    const b = input[1];
    for (let i = 0; i < a.length; i++) {
      this.acc += b ? (a[i] + b[i]) * 0.5 : a[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.accN));
        this.acc = 0;
        this.accN = 0;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.chunk) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
          this.buf = new Int16Array(this.chunk);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
