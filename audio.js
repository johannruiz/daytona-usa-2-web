// Browser audio for Daytona USA 2 (Claude 2026-11-11): 44.1 kHz stereo from
// the engine, converted to float and sent to an AudioWorklet ring buffer.
export class AudioOutput {
  constructor() { this.context = null; this.node = null; this.muted = false; this.volume = 1; }
  async start() {
    // resume() stays pending while the browser's autoplay policy blocks sound (no user
    // gesture yet in this page, e.g. a guest whose race starts from the network): never
    // wait for it, or the engine never starts (2026-11-14). A later gesture resumes it.
    if (this.context) { this.context.resume().catch(() => {}); return; }
    this.context = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    await this.context.audioWorklet.addModule('./audio-worklet.js');
    this.node = new AudioWorkletNode(this.context, 'daytona2-audio', { outputChannelCount: [2] });
    this.node.port.onmessage = e => { this.stats = e.data; };   // underruns, silent frames, queue level (audio-worklet.js)
    this.gain = this.context.createGain(); this.node.connect(this.gain).connect(this.context.destination);
    this.setVolume(this.volume);
  }
  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = this.muted ? 0 : v; }
  setMuted(m) { this.muted = m; this.setVolume(this.volume); }
  push(heap16, ptr, frames) {
    if (!this.node || this.context.state !== 'running') return;
    const src = heap16.subarray(ptr >> 1, (ptr >> 1) + frames * 2), out = new Float32Array(frames * 2);
    for (let i = 0; i < out.length; i++) out[i] = src[i] / 32768;
    this.node.port.postMessage(out, [out.buffer]);
  }
}
