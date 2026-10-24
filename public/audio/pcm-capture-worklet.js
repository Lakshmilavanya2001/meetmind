// Forwards mono PCM from the microphone to the main thread in ~100 ms batches.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(Math.round(sampleRate / 10));
    this.filled = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const n = Math.min(ch.length - i, this.batch.length - this.filled);
        this.batch.set(ch.subarray(i, i + n), this.filled);
        this.filled += n;
        i += n;
        if (this.filled === this.batch.length) {
          this.port.postMessage(this.batch.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
