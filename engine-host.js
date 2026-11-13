// Daytona USA 2 engine host (Claude 2026-11-11).
// Loads the WASM engine (build/web/dist/daytona2.js), imports the user's ROM
// ZIP inside the page, and provides the host interface that the WASM platform
// layer calls every field (web/native/platform_web_target.c):
//   present(packet)  - upload and draw the frame packet with WebGPU
//   nextField()      - promise resolved when the next field is due; the
//                      engine stack is suspended meanwhile (JSPI)
//   audio(ptr, n)    - n stereo int16 frames at 44.1 kHz from SCSP + DSB2
// Pacing follows the arcade field rate (57.524 Hz) with a fixed-step clock,
// so speed never depends on the monitor's refresh rate.

export const FIELD_MS = 17.385;
// 60 Hz mode (?hz=60): the game runs at 60 fields/s, as Supermodel does by
// default (RefreshRate = 60): 4.3% faster than the arcade, one field per
// refresh on 60/120/240 Hz displays. The sound board keeps its real speed
// (M3_SOUND_FIELD_US=16667: 735 samples a field), as Supermodel's own sound
// thread does, so the music is neither faster nor higher.
export const FIELD_MS_60 = 1000 / 60;

export class EngineHost {
  constructor({ renderer, audio, input, link, onField = () => {}, onStatus = () => {} }) {
    Object.assign(this, { renderer, audio, input, link, onField, onStatus });
    this.module = null; this.paused = false; this.waiter = null; this.next = 0;
    this.fieldMs = FIELD_MS;
    // Vsync presentation (default; ?vsync=0 turns it off for the tab): as a blocking
    // swap with vsync (Supermodel), each field is drawn on a display refresh
    // of its own and the next field waits until it has been, so two fields
    // never land in one refresh (a dropped image and a doubled one: the
    // "micro-stops"). The field clock stays the same.
    this.vsyncPresent = (() => { try { const q = new URLSearchParams(location.search).get('vsync'); if (q) sessionStorage.setItem('d2-vsync', q); return sessionStorage.getItem('d2-vsync') !== '0'; } catch { return true; } })();
    this.pendingDraw = false; this.lastRefresh = 0; this.refreshGap = 1e9; this.afterDraw = null; this.vsyncDraws = 0; this.directDraws = 0;
    // Display lock (with vsync): the fields follow the display's refreshes in
    // an exact ratio p/q (p fields every q refreshes) chosen nearest the
    // field rate, e.g. 10/13 on 75 Hz (57.69 Hz, +0.3%), 23/24 on 60 Hz
    // (57.50 Hz), 2/5 on 144 Hz (57.60 Hz). The pattern of refreshes each
    // image stays up then repeats exactly; a free-running 57.524 Hz clock
    // drifts against it and stumbles every few seconds. The sound's small
    // rate difference is absorbed by the audio output's rate control.
    this.lock = null; this.refreshTimes = []; this.lockedFields = 0;
    // Frame skipping (2026-11-12, as Daytona USA Web's SimulationClock): when the
    // display or the GPU gives fewer refreshes than fields (a 50 Hz display, a GPU
    // that only makes 45 frames/s), the fields stop waiting for refreshes and run
    // on the timer at full speed; each refresh draws the newest field and the
    // ones in between are not drawn (upload() still applies them). Off while the
    // refreshes keep up (hysteresis: on after 1 s slower than the fields by 6%,
    // off after 2 s within 2%), so a capable machine keeps the exact lock above.
    // ?skip=0 turns it off for the tab; ?rafhz=N (test only) emulates an N Hz display.
    const q = new URLSearchParams(location.search);
    this.skipAllowed = q.get('skip') !== '0'; this.rafHz = Number(q.get('rafhz')) || 0;
    this.skipping = false; this.skipSince = 0; this.skippedDraws = 0; this.skipEntries = 0;
    this.fields = 0; this.frameTimes = []; this.lastPresent = 0; this.slow = [];
    // Per-field trace ring (8192 fields, ~2.4 min) to find hitches: engine time,
    // present time, gap between presents, timer lateness and GPU upload volume.
    const N = 8192; this.trace = { N, n: 0, engine: new Float32Array(N), present: new Float32Array(N), gap: new Float32Array(N), late: new Float32Array(N), rows: new Uint32Array(N), verts: new Uint32Array(N), chunks: new Uint32Array(N) };
  }
  async load(scriptUrl = './daytona2.js') {
    const host = this;
    const Module = {
      noInitialRun: true,
      onExit: code => console.error('[engine] exit', code, new Error().stack),
      onAbort: what => console.error('[engine] abort', what),
      print: t => console.log(t), printErr: t => console.warn(t),
      daytonaHost: {
        present: packet => host.present(packet),
        nextField: () => host.nextField(),
        mustWait: () => host.mustWait(),
        audio: (ptr, frames) => host.audio?.push(host.module.HEAP16, ptr, frames),
        link: host.link,
      },
    };
    globalThis.Module = Module;
    await new Promise((resolve, reject) => {
      Module.onRuntimeInitialized = resolve;
      const s = document.createElement('script'); s.src = scriptUrl; s.onerror = () => reject(new Error('Engine script failed to load'));
      document.head.appendChild(s);
    });
    this.module = Module;
    return Module;
  }
  // Import the ROM ZIP (Uint8Array) into /roms with the native validation.
  importROM(zipBytes) {
    const M = this.module;
    try { M.FS.mkdir('/roms'); } catch {}
    const ptr = M._malloc(zipBytes.length);
    M.HEAPU8.set(zipBytes, ptr);
    const dir = M.stringToNewUTF8 ? M.stringToNewUTF8('/roms') : allocString(M, '/roms');
    const code = M._dayto_web_import_rom(ptr, zipBytes.length, dir);
    M._free(ptr); M._free(dir);
    const missing = code === 2 ? M.UTF8ToString(M._dayto_web_import_missing()) : '';
    return { ok: code === 0, code, missing };
  }
  writeFile(path, bytes) { this.module.FS.writeFile(path, bytes); }
  readFile(path) { try { return this.module.FS.readFile(path); } catch { return null; } }
  start(env = {}) {
    const M = this.module;
    // environ is built when the module starts; set variables through libc so getenv() sees them.
    const all = { DAYTO_ROM_DIR: '/roms', M3_SOUND_THREAD: '0', DAYTO_COMM_ASYNC_TICK: '1', ...env };
    for (const [k, v] of Object.entries(all)) { const a = M.stringToNewUTF8(k), b = M.stringToNewUTF8(String(v)); M._setenv(a, b, 1); M._free(a); M._free(b); }
    this.inputPtr = M._dayto_web_input_ptr();
    this.next = performance.now();
    M.callMain([]);   // returns when the engine first suspends (JSPI)
  }
  present(packet) {
    const M = this.module, t0 = performance.now();
    if (this.resumedAt) this.engineMs = (this.engineMs || 0) * 0.98 + (t0 - this.resumedAt) * 0.02;
    if (this.input) this.input.write(M.HEAPU8, this.inputPtr);
    const t1 = performance.now();
    if (this.renderer) this.renderer.upload(M.HEAPU8, packet);
    const t2 = performance.now();
    // Vsync presentation: drawn on the next refresh (refreshLoop) while the
    // display is refreshing; at once otherwise (hidden or occluded window).
    if (this.vsyncPresent) this.refreshLoop();
    // While skipping, also a slow refresh (a GPU at 30 frames/s) draws only the newest field.
    if (this.renderer && this.vsyncPresent && (this.displayRefreshing(t2) || (this.skipping && t2 - this.lastRefresh < 100))) { if (this.pendingDraw) this.skippedDraws++; this.pendingDraw = true; }
    else if (this.renderer) { this.renderer.render(); this.directDraws++; }
    const now = performance.now();
    if (now - t0 > 12 && this.slow.length < 64) this.slow.push({ field: this.trace.n, input: +(t1 - t0).toFixed(1), upload: +(t2 - t1).toFixed(1), render: +(now - t2).toFixed(1), ...Object.fromEntries(Object.entries(this.renderer?.timing || {}).map(([k, v]) => [k, +v.toFixed(1)])) });
    this.presentMs = (this.presentMs || 0) * 0.98 + (now - t0) * 0.02;
    const tr = this.trace, i = tr.n++ % tr.N, st = this.renderer?.stats;
    tr.engine[i] = this.resumedAt ? t0 - this.resumedAt : 0; tr.present[i] = now - t0; tr.gap[i] = this.lastPresent ? now - this.lastPresent : 0;
    tr.late[i] = this.lateMs || 0; if (st) { tr.rows[i] = st.textureRows; tr.verts[i] = st.vertexUploads; tr.chunks[i] = st.tileChunks; }
    if (this.lastPresent) { this.frameTimes.push(now - this.lastPresent); if (this.frameTimes.length > 120) this.frameTimes.shift(); }
    this.lastPresent = now; this.fields++;
    this.onField(this);
  }
  // Fixed-step pacing: a field is due every FIELD_MS. When the page fell far
  // behind (tab hidden, debugger), resynchronize instead of racing to catch up.
  // Benchmark knob: in unpaced mode suspend only every `burst` fields.
  mustWait() { if (!this.unpaced) return true; this.burstN = ((this.burstN || 0) + 1) % (this.burst || 1); if (this.burstN) { this.resumedAt = performance.now(); return false; } return true; }
  nextField() {
    const resolveAt = r => () => { this.resumedAt = performance.now(); this.lateMs = this.resumedAt - this.next; r(); };
    this.next += this.fieldMs;
    const now = performance.now();
    if (now - this.next > 250) this.next = now;
    if (this.unpaced) { this.next = now; this.earliest = -Infinity; return new Promise(r => this.yieldNow(resolveAt(r))); }
    // Rate cap (2026-11-12): the field's ideal time on a virtual clock at the
    // lock's own rate (else FIELD_MS), behind by at most 250 ms (catching up);
    // no path may start it more than one step early. Without it, fields the
    // timer ran during main-thread hitches were not taken from the refreshes
    // the lock had counted, and a busy page ran 62-72 Hz (linked play, 64.5 Hz).
    const step = this.locked(now) ? 1000 * this.lock.q / (this.lock.hz * this.lock.p) : this.fieldMs;
    this.ideal = Math.max((this.ideal ?? now) + step, now - 250);
    this.earliest = this.ideal - step;
    // Behind schedule: run the next field at once, but through a macrotask so the
    // page (input, rAF, network) is never starved by a chain of microtasks.
    if (!this.paused && !this.drawPending(now) && !this.locked(now) && this.next <= now + 0.5 && this.earliest <= now + 0.5) { this.immediate = (this.immediate || 0) + 1; return new Promise(r => this.yieldNow(resolveAt(r))); }
    this.waits = (this.waits || 0) + 1;
    return new Promise(resolve => { this.waiter = resolveAt(resolve); this.schedule(); });
  }
  // Refreshing normally: the last refresh came less than 25 ms after the one
  // before and less than 25 ms ago. A throttled display (occluded window, ~1
  // to 20 refreshes/s) must not hold the fields back: the timer runs them.
  // With a lock, also the recent refreshes must come at the lock's period
  // (average within 10%): a throttled or stuttering display falls back to
  // the timer and draws at once, as without vsync.
  displayRefreshing(now) {
    if (!(this.lastRefresh > 0 && this.refreshGap < 25 && now - this.lastRefresh < 25)) return false;
    return !this.lock || Math.abs(this.gapAvg - 1000 / this.lock.hz) < 0.1 * 1000 / this.lock.hz;
  }
  locked(now) { return !this.skipping && !!this.lock && this.displayRefreshing(now); }
  // p/q nearest the target rate for the measured refresh period, smallest q
  // within 0.5% (else the nearest); null when no ratio is within 2%.
  chooseLock(refreshMs) {
    const hz = 1000 / refreshMs, target = 1000 / this.fieldMs;
    let best = null;
    for (let q = 1; q <= 32; q++) {
      const p = Math.round(target * q / hz); if (p < 1 || p > 2 * q) continue;
      const err = Math.abs(hz * p / q - target) / target;
      if (!best || err < best.err - 1e-9) best = { p, q, err };
      if (err < 0.005) break;
    }
    return best && best.err < 0.02 ? { p: best.p, q: best.q, err: best.err, hz, acc: 0, due: 0 } : null;
  }
  drawPending(now) { return !this.skipping && this.pendingDraw && this.displayRefreshing(now); }
  updateSkip(now) {
    if (!this.skipAllowed || this.paused || this.refreshCount < 60) { this.skipSince = 0; return; }
    const slow = this.gapAvg > this.fieldMs * 1.06, fast = this.gapAvg < this.fieldMs * 1.02;
    if (this.skipping ? !fast : !slow) { this.skipSince = 0; return; }
    if (!this.skipSince) { this.skipSince = now; return; }
    if (now - this.skipSince < (this.skipping ? 2000 : 1000)) return;
    this.skipping = !this.skipping; this.skipSince = 0; if (this.skipping) this.skipEntries++;
    if (this.lock) { this.lock.acc = 0; this.lock.due = 0; }
    this.next = now;
    console.info(`[engine] frame skipping ${this.skipping ? 'on' : 'off'}: display ${(1000 / this.gapAvg).toFixed(1)} Hz, fields ${(1000 / this.fieldMs).toFixed(1)} Hz`);
  }
  refreshLoop() {
    if (this.refreshing) return;
    this.refreshing = true;
    let lastT = 0, due = 0;
    const period = this.rafHz ? 1000 / this.rafHz : 0;
    const raf = period ? f => { const now = performance.now(); due = Math.max(due + period, now); setTimeout(() => f(performance.now()), due - now); } : f => requestAnimationFrame(f);
    const frame = t => {
      raf(frame);
      const now = performance.now();
      this.refreshGap = this.lastRefresh ? now - this.lastRefresh : 1e9;
      const stale = this.refreshGap >= 25;
      this.gapAvg = this.gapAvg ? this.gapAvg + (Math.min(this.refreshGap, 100) - this.gapAvg) * 0.1 : Math.min(this.refreshGap, 100); this.refreshCount = (this.refreshCount || 0) + 1;
      this.lastRefresh = now;
      this.updateSkip(now);
      // Refresh period: median of the last 90 refreshes (re-chosen if it moves by >2%).
      const d = t - lastT; lastT = t;
      if (!stale && d > 3 && d < 25) {
        this.refreshTimes.push(d); if (this.refreshTimes.length > 90) this.refreshTimes.shift();
        if (this.refreshTimes.length === 90 && (!this.lock || Math.abs(1000 / this.lock.hz - [...this.refreshTimes].sort((a, b) => a - b)[45]) / (1000 / this.lock.hz) > 0.02)) {
          this.lock = this.chooseLock([...this.refreshTimes].sort((a, b) => a - b)[45]);
        }
      }
      if (this.pendingDraw) {
        this.pendingDraw = false; this.vsyncDraws++;
        this.renderer.render();
        const f = this.afterDraw; this.afterDraw = null; if (f) f();
      }
      const L = this.lock;
      if (!L || this.paused || this.skipping || !this.displayRefreshing(now)) return;
      L.acc += L.p * Math.max(1, Math.round(d / (1000 / L.hz)));   // refreshes since the last one
      while (L.acc >= L.q) { L.acc -= L.q; L.due++; }
      // No catching up (as Supermodel): a field the engine could not start in
      // time is not run twice in a row later.
      if (L.due > 1) L.due = 1;
      if (L.due && this.waiter && now >= this.earliest) { L.due--; this.lockedFields++; this.next = now; const w = this.waiter; this.waiter = null; w(); }
    };
    raf(frame);
  }
  schedule() {
    // rAF gives display-aligned wakeups; a timer keeps the 57.5 Hz clock when
    // rAF is throttled or absent (occluded window), as Daytona USA Web's
    // SimulationClock does. Whichever fires first and finds the field due runs it.
    // At most one pending timer and one pending rAF: earlier versions armed
    // both on every tick, and leftover ticks kept re-arming on later fields,
    // so pending callbacks grew without bound (GC pauses of 0.2-1.7 s).
    const tick = () => {
      if (!this.waiter) return;
      if (this.paused) { this.arm(tick, 50); return; }
      const early = this.earliest - performance.now();   // rate cap (nextField)
      if (early > 0.5) { this.arm(tick, early); return; }
      // The previous field is still waiting for its refresh: this field starts
      // once it is drawn (or after 25 ms if refreshes stop).
      if (this.drawPending(performance.now())) { this.afterDraw = tick; this.arm(tick, 25); return; }
      // Display lock: the refresh loop starts the field; this timer only takes
      // over if the refreshes stop (hidden or occluded window).
      if (this.locked(performance.now())) {
        const now = performance.now();
        if (this.lock.due) { this.lock.due--; this.lockedFields++; this.next = now; const w = this.waiter; this.waiter = null; w(); return; }
        // Safety net: a field later than the lock's longest normal wait (its
        // longest hold, ceil(q/p) refreshes) plus 3/4 of a refresh means a
        // refresh the browser skipped: it runs on the timer, so the lock never
        // slows the game.
        const r = 1000 / this.lock.hz, limit = r * Math.ceil(this.lock.q / this.lock.p) - this.fieldMs + r * 0.75;
        const late = now - this.next;
        if (late > limit) { this.lockMissed = (this.lockMissed || 0) + 1; const w = this.waiter; this.waiter = null; w(); return; }
        this.arm(tick, Math.max(1, limit - late + 0.5)); return;
      }
      const wait = this.next - performance.now();
      if (wait <= 0.5) { const w = this.waiter; this.waiter = null; w(); return; }
      // The last 2 ms are covered with macrotask polls: Windows timers wake
      // up to ~4 ms late, which made field delivery uneven.
      if (wait <= 2) { this.yieldNow(tick); return; }
      if (wait > 6 && !this.rafPending) { this.rafPending = true; requestAnimationFrame(() => { this.rafPending = false; tick(); }); }
      this.arm(tick, wait - 2);
    };
    tick();
  }
  arm(fn, ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = 0; fn(); }, ms);
  }
  yieldNow(resolve) {
    if (!this.channel) { this.channel = new MessageChannel(); this.channel.port1.onmessage = () => { const q = this.queue; this.queue = []; q.forEach(f => f()); }; this.queue = []; }
    this.queue.push(resolve); this.channel.port2.postMessage(0);
  }
  // Page restart or exit (Claude 2026-11-12): Chrome keeps a page whose engine
  // is suspended (JSPI) alive after a reload, WASM and JS heaps included (~1 GB
  // per reload; linked play reloads between races). stop() ends the engine's
  // stack: the pending suspension is woken and every later one rejects, so the
  // exception unwinds out of the WASM.
  stop() {
    if (this.stopped || !this.module) return;
    this.stopped = true;
    const fail = () => Promise.reject(new Error('engine stopped'));
    this.nextField = fail; this.mustWait = () => true;
    if (this.link) { this.link.wait = fail; for (const w of this.link.waiters || []) { clearTimeout(w.timer); w.resolve(1); } this.link.waiters = []; }
    clearTimeout(this.timer); this.afterDraw = null;
    const w = this.waiter, q = this.queue || []; this.waiter = null; this.queue = [];
    if (w) w(); q.forEach(f => f());
  }
  setPaused(paused) { this.paused = paused; if (!paused) this.next = performance.now(); }
  fps() {
    if (this.frameTimes.length < 10) return 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return 1000 / avg;
  }
}
function allocString(M, s) {
  const bytes = new TextEncoder().encode(s + '\0'); const p = M._malloc(bytes.length); M.HEAPU8.set(bytes, p); return p;
}
