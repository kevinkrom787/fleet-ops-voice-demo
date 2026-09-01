// Downsamples mic input (native AudioContext sample rate, e.g. 48000) to the
// 24kHz mono PCM16 that Deepgram's Voice Agent API expects, and batches samples
// before posting them to the main thread to keep message traffic reasonable.
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 24000;
    this.ratio = sampleRate / this.targetRate;
    this.acc = 0;
    this.batch = [];
    this.batchTargetSize = 2400; // ~100ms at 24kHz
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.acc += 1;
        if (this.acc >= this.ratio) {
          this.acc -= this.ratio;
          const s = Math.max(-1, Math.min(1, input[i]));
          this.batch.push(s < 0 ? s * 0x8000 : s * 0x7fff);
        }
      }
      if (this.batch.length >= this.batchTargetSize) {
        const int16 = new Int16Array(this.batch.length);
        for (let i = 0; i < this.batch.length; i++) int16[i] = this.batch[i];
        this.port.postMessage(int16.buffer, [int16.buffer]);
        this.batch = [];
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
