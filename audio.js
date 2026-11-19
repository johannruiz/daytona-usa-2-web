// Browser audio for Daytona USA 2 (Claude 2026-11-11; shared ring 2026-11-18, as Scud Race Web).
// 44.1 kHz stereo from the engine: the sound board's thread writes an int16
// ring in the engine's shared memory (web/native/platform_web_target.c) and
// the AudioWorklet reads it there directly (audio-worklet.js), so no sample
// passes through this page's thread.
export class AudioOutput {
  constructor() { this.context = null; this.node = null; this.muted = false; this.volume = 1; this.ring = null; }
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
    if (this.ring) this.node.port.postMessage(this.ring);
  }
  // The engine's memory and the ring's address (EngineHost.start).
  attach(memory, ptr) { this.ring = { memory, ptr }; this.node?.port.postMessage(this.ring); }
  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = this.muted ? 0 : v; }
  setMuted(m) { this.muted = m; this.setVolume(this.volume); }
}
