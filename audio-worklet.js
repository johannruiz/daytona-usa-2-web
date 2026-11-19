// Stereo output for the arcade sound (Claude 2026-11-11; shared ring 2026-11-18, as Scud Race Web).
// Reads the engine's audio ring in shared memory (WebAudioRing in
// web/native/platform_web_target.c: write, read, frames, dropped, then int16
// L/R pairs; positions count frames and only grow). The sound board's thread
// writes it; this processor alone moves `read`.
// Rate control (2026-11-12): the engine's fields follow the display (see
// engine-host.js, display lock), so the sound arrives a little faster or
// slower than the output plays it (the two clocks always drift). As
// Supermodel's Audio.cpp does, the queue is held near its target by playing
// up to 1% faster or slower (linear interpolation), so it neither runs dry
// nor builds up delay. Adaptive target (2026-11-14): each underrun raises it,
// calm periods lower it again.
class Daytona2Audio extends AudioWorkletProcessor {
  constructor() {
    super(); this.ring = null; this.frac = 0; this.level = 0; this.primed = false;
    this.target = 3072; this.rate = 1; this.underruns = 0; this.silent = 0; this.blocks = 0; this.calm = 0;
    this.port.onmessage = e => {
      const { memory, ptr } = e.data; const b = memory.buffer;
      const head = new Int32Array(b, ptr, 4), frames = head[2] || 32768;
      this.ring = { memory, ptr, head, frames, data: new Int16Array(b, ptr + 16, frames * 2) };
      this.read = Atomics.load(head, 0); Atomics.store(head, 1, this.read);   // start at the newest sound
    };
  }
  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], g = this.ring;
    if (!g) { L.fill(0); if (R !== L) R.fill(0); return true; }
    const write = Atomics.load(g.head, 0), mask = g.frames - 1, k = 1 / 32768;
    let count = (write - this.read) | 0;
    if (count > g.frames) { this.read = write - g.frames; count = g.frames; }   // never behind the writer by a whole ring
    if (!this.primed && count >= Math.max(3072, this.target >> 1)) { this.primed = true; this.level = count; }   // ~70 ms to absorb field jitter
    this.level += (count - this.level) * 0.02;
    const error = (this.level - this.target) / this.target;
    this.rate = 1 + Math.max(-0.01, Math.min(0.01, error * 0.02));
    // Too much queued (a long stall, or the tab came back): drop to the target at once.
    if (this.primed && count > this.target * 4) { this.read = write - this.target; count = this.target; this.level = count; }
    const d = g.data;
    for (let i = 0; i < L.length; i++) {
      if (this.primed && count > 1) {
        const a = this.read & mask, b = (this.read + 1) & mask, f = this.frac;
        const la = d[2 * a] * k, ra = d[2 * a + 1] * k;
        L[i] = la + (d[2 * b] * k - la) * f; R[i] = ra + (d[2 * b + 1] * k - ra) * f;
        this.frac += this.rate;
        while (this.frac >= 1 && count > 1) { this.frac -= 1; this.read++; count--; }
      } else {
        if (this.primed) { this.underruns++; this.target = Math.min(13312, this.target + 1536); this.calm = 0; }
        L[i] = 0; R[i] = 0; this.silent++; if (count <= 1) this.primed = false;
      }
    }
    Atomics.store(g.head, 1, this.read | 0);
    if (++this.calm >= 3445 && this.target > 3072) { this.calm = 0; this.target = Math.max(3072, this.target - 512); }
    if (++this.blocks % 344 === 0) this.port.postMessage({ underruns: this.underruns, silent: this.silent, level: Math.round(this.level), target: this.target, dropped: Atomics.load(g.head, 3) });
    return true;
  }
}
registerProcessor('daytona2-audio', Daytona2Audio);
