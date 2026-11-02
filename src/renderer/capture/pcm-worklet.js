// AudioWorklet: resample the microphone stream to 16 kHz mono Int16 and post
// 100 ms chunks to the capture renderer.
//
// This lives in its own file rather than a Blob URL because the renderer's CSP
// pins script-src to 'self' — a blob: worklet is refused, and Chromium surfaces
// that as "AbortError: The user aborted a request", which looks exactly like a
// microphone permission failure.

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz

class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.offset = 0;
    this.ratio = sampleRate / TARGET_RATE;
    this.carry = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const src = input[0];

    for (let i = 0; i < src.length; i++) {
      this.carry += 1;
      if (this.carry < this.ratio) continue;
      this.carry -= this.ratio;

      const clamped = Math.max(-1, Math.min(1, src[i]));
      this.chunk[this.offset++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.offset === this.chunk.length) {
        const out = this.chunk.slice(0);
        this.port.postMessage(out.buffer, [out.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PCMCapture);
