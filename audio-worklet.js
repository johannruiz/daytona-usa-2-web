// Ring-buffered stereo output for the arcade sound (Claude 2026-11-11).
// Rate control (2026-11-12): the engine's fields follow the display (see
// engine-host.js, display lock), so the sound arrives a little faster or
// slower than the output plays it (+0.3% at 57.69 Hz on a 75 Hz display, and
// the two clocks always drift). As Supermodel's Audio.cpp does, the queue is
// held near its target by playing up to 1% faster or slower (linear
// interpolation), so it neither runs dry nor builds up delay.
class Daytona2Audio extends AudioWorkletProcessor {
  constructor() {
    super(); this.size = 44100; this.l = new Float32Array(this.size); this.r = new Float32Array(this.size);
    this.read = 0; this.write = 0; this.count = 0; this.primed = false; this.frac = 0; this.level = 0;
    this.target = 3072; this.rate = 1; this.underruns = 0; this.silent = 0; this.blocks = 0; this.calm = 0;
    this.port.onmessage = e => {
      const d = e.data; const n = d.length >> 1;
      for (let i = 0; i < n; i++) {
        if (this.count >= this.size) { this.read = (this.read + 1) % this.size; this.count--; }   // drop oldest
        this.l[this.write] = d[2 * i]; this.r[this.write] = d[2 * i + 1]; this.write = (this.write + 1) % this.size; this.count++;
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    if (!this.primed && this.count >= Math.max(3072, this.target >> 1)) { this.primed = true; this.level = this.count; }   // after an underrun, half the (raised) target   // ~70 ms to absorb field jitter
    // Smoothed queue level -> playback rate within +-1%.
    this.level += (this.count - this.level) * 0.02;
    const error = (this.level - this.target) / this.target;
    this.rate = 1 + Math.max(-0.01, Math.min(0.01, error * 0.02));
    for (let i = 0; i < L.length; i++) {
      if (this.primed && this.count > 1) {
        const a = this.read, b = (a + 1) % this.size, f = this.frac;
        L[i] = this.l[a] + (this.l[b] - this.l[a]) * f; R[i] = this.r[a] + (this.r[b] - this.r[a]) * f;
        this.frac += this.rate;
        while (this.frac >= 1 && this.count > 1) { this.frac -= 1; this.read = (this.read + 1) % this.size; this.count--; }
      } else {
        // Adaptive queue (2026-11-14): each underrun raises the target by ~35 ms (up to
        // ~300 ms), so a slow device (an iPhone in Low Power Mode) stops cutting out
        // again and again; every 10 s without one lowers it by ~12 ms, down to ~70 ms.
        if (this.primed) { this.underruns++; this.target = Math.min(13312, this.target + 1536); this.calm = 0; }
        L[i] = 0; R[i] = 0; this.silent++; if (this.count <= 1) this.primed = false; }
    }
    if (++this.calm >= 3445 && this.target > 3072) { this.calm = 0; this.target = Math.max(3072, this.target - 512); }
    // Diagnostics once a second (2026-11-14): underruns (the queue ran dry while playing) and silent frames.
    if (++this.blocks % 344 === 0) this.port.postMessage({ underruns: this.underruns, silent: this.silent, level: Math.round(this.level), target: this.target });
    return true;
  }
}
registerProcessor('daytona2-audio', Daytona2Audio);
