// Daytona USA 2 engine host (Claude 2026-11-11; pthreads build 2026-11-18,
// from Scud Race Web's). The WASM engine (daytona2.js, pthreads) runs in its
// own Worker (engine-worker.js); this page only draws, plays, reads the
// controls and paces the fields. The two share the engine's memory (a
// SharedArrayBuffer, which needs a cross-origin isolated page: coi-sw.js on
// GitHub Pages). Per field (web/native/platform_web_target.c):
//   - the engine publishes the frame packet and sends 'present': present()
//     uploads it to WebGPU and writes the controls into the input record;
//   - the engine waits on a futex; nextField() decides when the next field is
//     due (display lock p/q, rate cap, frame skipping: unchanged from the
//     JSPI build) and release() lets it run (Atomics.notify);
//   - the sound board's thread fills an audio ring that the AudioWorklet reads.
// The engine never runs on this thread, so a field's 5-10 ms of work no longer
// holds back the page, its input or the frame just drawn (the JSPI build ran
// it on this thread, between the page's own tasks).

export const FIELD_MS = 17.385;   // the arcade: 57.524 fields/s (Model 3 video timing), the default since 2026-11-18
// 60 Hz mode (?hz=60, single play only): the game runs at 60 fields/s, as Supermodel does by
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
    this.skipAllowed = q.get('skip') !== '0'; this.rafHz = Number(q.get('rafhz')) || 0; this.everyRefresh = q.get('everyrefresh') === '1';
    this.fixedT = q.has('interpt') ? Number(q.get('interpt')) : null;   // tests: Smooth draws every image this far between the last two fields
    this.linkPace = q.get('linkpace') === '1';   // test only: linked play's pacing in single play (main.js sets it when linked)
    // Tests (2026-11-18): ?late=0 never starts a field before the previous image is
    // drawn, ?late=1 always (when its refresh passed); ?owe=0 drops a field the
    // lock could not start instead of owing it (see refreshLoop and schedule).
    this.lateMode = q.get('late') ?? 'auto'; this.oweFields = q.get('owe') === '0' ? 1 : 2; this.engRecent = [0, 0, 0];
    this.skipping = false; this.skipSince = 0; this.skippedDraws = 0; this.skipEntries = 0;
    this.fields = 0; this.frameTimes = []; this.lastPresent = 0; this.slow = [];
    // Per-field trace ring (8192 fields, ~2.4 min) to find hitches: engine time,
    // present time, gap between presents, timer lateness and GPU upload volume.
    const N = 8192; this.trace = { N, n: 0, engine: new Float32Array(N), present: new Float32Array(N), gap: new Float32Array(N), late: new Float32Array(N), scene: new Float32Array(N), field: new Uint32Array(N), board: new Float32Array(N), boardWait: new Float32Array(N), rows: new Uint32Array(N), verts: new Uint32Array(N), chunks: new Uint32Array(N) };
  }
  // Start the engine worker and wait for its module (pthreads preloaded).
  async load(scriptUrl = './daytona2.js') {
    if (!globalThis.crossOriginIsolated) throw new Error('This page is not cross-origin isolated, so the engine cannot share memory with it. Reload the page once (the page installs a helper that enables it), or use a current Chrome or Edge.');
    this.worker = new Worker('./engine-worker.js', { name: 'daytona2-engine' });
    this.replies = new Map(); this.replyId = 0;
    const ready = new Promise((resolve, reject) => { this.onReady = resolve; this.onFail = reject; });
    this.worker.onmessage = e => this.message(e.data);
    this.worker.onerror = e => { console.error('[engine worker]', e.message || e); this.onFail?.(new Error('Engine worker failed: ' + (e.message || 'error'))); };
    this.worker.postMessage({ t: 'init', script: new URL(scriptUrl, location.href).href });
    const r = await ready;
    this.memory = r.memory; this.cores = r.cores;
    this.ctlPtr = r.control; this.inputPtr = r.input; this.audioPtr = r.audio; this.ramPtr = r.ram; this.packetPtr = r.packet; this.ffbPtr = r.ffb || 0;
    this.views();
    // Compatibility with the shell (main.js): what it used to read from the module.
    const host = this;
    // The engine's functions cannot be called from here while it runs: these
    // read what platform_present publishes in the control block every field.
    const word = i => () => host.ctl[i] >>> 0;
    this.module = {
      daytonaHost: { set saveRequested(v) { if (v) Atomics.store(host.ctl, CTL.save, 1); }, get saveRequested() { return false; }, set audio(f) { host.audio = null; } },
      _dayto_web_rumble_strong: () => host.ctlF[CTL.rumbleStrong], _dayto_web_rumble_weak: () => host.ctlF[CTL.rumbleWeak], _dayto_web_wheel_force: () => host.ctlF[CTL.wheelForce],
      _dayto_web_link_phase: word(CTL.linkPhase),
      _dayto_web_contact_human: word(CTL.contactHuman), _dayto_web_contact_skipped: word(CTL.contactSkipped), _dayto_web_contact_departed: word(CTL.contactDeparted),
      _dayto_web_contact_closest: () => host.ctlF[CTL.contactClosest], _dayto_web_contact_mask: word(CTL.contactMask), _dayto_web_wall_reset_skipped: word(CTL.wallResetSkipped),
      _dayto_web_ram_ptr: () => host.ctl[CTL.ramPtr] >>> 0, _dayto_web_frame_packet: () => host.ctl[CTL.packet] >>> 0,   // set once main() runs
      get HEAPU8() { return host.heap(); },
      FS: { mkdir() {}, readFile: () => { throw new Error('The engine files live in its worker: use host.readFile()'); } },
    };
    if (this.link?.shared) this.worker.postMessage({ t: 'link', shared: this.link.shared, layout: this.link.layout });
    return this.module;
  }
  views() {
    const b = this.memory.buffer; this.heapU8 = new Uint8Array(b);
    this.ctl = new Int32Array(b, this.ctlPtr, CTL.words); this.ctlF = new Float32Array(b, this.ctlPtr, CTL.words);
    this.ffb = this.ffbPtr ? new Float32Array(b, this.ffbPtr, 8) : null;   // wheel effects (platform_web_target.c dayto_web_ffb)
    if (this.interpOn) Atomics.store(this.ctl, CTL.interp, 1);   // set before the engine's memory was known
  }
  // The engine's memory may grow: the views follow it.
  heap() { if (this.heapU8.byteLength !== this.memory.buffer.byteLength) this.views(); return this.heapU8; }
  message(d) {
    if (d.t === 'present') { this.onPresent(d.packet); return; }
    if (d.t === 'log') { (/error|fail|mismatch|abort|exception/i.test(d.text) ? console.warn : console.log)(d.text); return; }
    if (d.t === 'reply') { const f = this.replies.get(d.id); this.replies.delete(d.id); f?.(d.value); return; }
    if (d.t === 'link') { this.linkMessage(d); return; }
    if (d.t === 'backup') { this.backupSaved?.(d.bytes, d.path); return; }
    if (d.t === 'ready') { this.onReady(d); return; }
    if (d.t === 'started') { this.startedAt = performance.now(); return; }
    if (d.t === 'exit') { console.error('[engine] exit', d.code); this.exited = true; return; }
    if (d.t === 'abort' || d.t === 'error') { console.error('[engine]', d.what || d.message); this.exited = true; this.onFail?.(new Error(d.what || d.message)); return; }
  }
  linkMessage(d) {
    const l = this.link; if (!l) return;
    if (d.op === 'open') l.open(d.nodes, d.node);
    else if (d.op === 'close') l.close();
    else if (d.op === 'joined') l.setJoined(d.state);
    else if (d.op === 'linked') l.setLinked();
    else if (d.op === 'publish') l.publish(d.seq, new Uint8Array(d.block));
    else if (d.op === 'stats') l.motionStats = d.stats;
    else if (d.op === 'pose') { const log = l.poseLog; if (log) for (const r of d.rows) if (log.length < 200000) log.push(r); }
    else if (d.op === 'racing') { l.racing = d.on; try { l.onRacing?.(d.on); } catch {} }
  }
  request(msg, transfer) { const id = ++this.replyId; return new Promise(res => { this.replies.set(id, res); this.worker.postMessage({ ...msg, id }, transfer || []); }); }
  // Large data goes straight into the engine's shared memory (engine-worker.js 'alloc').
  async put(bytes) {
    const ptr = await this.request({ t: 'alloc', size: bytes.length });
    if (!ptr) throw new Error('The engine is out of memory.');
    this.heap().set(bytes, ptr); return ptr;
  }
  // Import the ROM ZIP (Uint8Array) with the native validation: each region is
  // assembled in the block the engine keeps (rom_import_web.c).
  async importROM(zipBytes) { const ptr = await this.put(zipBytes); return this.request({ t: 'import', ptr, size: zipBytes.length }); }
  // A prepared region (?devroms=1), handed to main() as it is.
  async writeRegion(name, bytes) { const ptr = await this.put(bytes); return this.request({ t: 'region', name, ptr, size: bytes.length }); }
  writeFile(path, bytes) { return this.request({ t: 'writeFile', path, bytes }); }
  readFile(path) { return this.request({ t: 'readFile', path }); }   // before the engine starts only
  start(env = {}) {
    // The sound board on its own thread (as natively), now that threads exist.
    const all = { DAYTO_ROM_DIR: '/roms', M3_SOUND_THREAD: '1', M3_RENDER_THREADS: '1', DAYTO_COMM_ASYNC_TICK: '1', ...env };   // M3_RENDER_THREADS: the software rasterizer (unused with WebGPU) never asks for more threads than the pool has
    Atomics.store(this.ctl, CTL.unpaced, this.unpaced ? 1 : 0); Atomics.store(this.ctl, CTL.burst, this.burst || 1);
    this.audio?.attach?.(this.memory, this.audioPtr);
    this.next = performance.now();
    this.worker.postMessage({ t: 'start', env: all });
    this.updateSpin();
  }
  // A packet is ready and the engine waits: draw it, then let the next field run when due.
  // Each packet is taken once, by its count (ctl 1, which the engine raises after
  // writing ctl 2): from the engine's message or, first, from the refresh loop's
  // own check (2026-11-19, see refreshLoop). Unpaced (benchmarks) every message.
  onPresent(packet) {
    if (this.stopped) return;
    if (!this.unpaced) {
      const n = Atomics.load(this.ctl, CTL.presented);
      if (n === this.presentedSeen) return;   // already taken at a refresh
      this.presentedSeen = n; packet = Atomics.load(this.ctl, CTL.packet) >>> 0;
    }
    this.present(packet);
    if (this.unpaced && (this.burst || 1) > 1) { this.resumedAt = performance.now(); return; }   // the engine did not wait
    this.nextField().then(() => this.release(), () => {});
  }
  release() {
    if (this.stopped) return;
    this.inFlight = true;   // until its packet arrives (display interpolation)
    Atomics.add(this.ctl, CTL.go, 1); Atomics.notify(this.ctl, CTL.go);
  }
  present(packet) {
    this.inFlight = false;
    const heap = this.heap(), t0 = performance.now();
    // The engine's own time for the field (its thread), not the page's wait.
    this.engineMs = (this.engineMs || 0) * 0.98 + (this.ctl[CTL.engineUs] / 1000) * 0.02;
    if (Atomics.exchange(this.ctl, CTL.resync, 0)) this.next = t0;   // a lockstep link wait: re-time from now
    if (this.input) this.input.write(heap, this.inputPtr);
    const t1 = performance.now();
    if (this.renderer) this.renderer.upload(heap, packet);
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
    tr.engine[i] = this.ctl[CTL.engineUs] / 1000; this.engRecent[tr.n % 3] = tr.engine[i]; tr.scene[i] = this.ctl[CTL.sceneWaitUs] / 1000; tr.field[i] = this.ctl[CTL.field]; tr.board[i] = this.ctl[CTL.soundUs] / 1000; tr.boardWait[i] = this.ctl[21] / 1000; tr.present[i] = now - t0; tr.gap[i] = this.lastPresent ? now - this.lastPresent : 0;
    tr.late[i] = this.lateMs || 0; if (st) { tr.rows[i] = st.textureRows; tr.verts[i] = st.vertexUploads; tr.chunks[i] = st.tileChunks; }
    if (this.lastPresent) { this.frameTimes.push(now - this.lastPresent); if (this.frameTimes.length > 120) this.frameTimes.shift(); }
    this.lastPresent = now; this.fields++;
    this.onField(this);
  }
  // Fixed-step pacing: a field is due every FIELD_MS. When the page fell far
  // behind (tab hidden, debugger), resynchronize instead of racing to catch up.
  // Benchmark knob: in unpaced mode suspend only every `burst` fields.
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
    this.earliest = this.ideal - step; this.step = step;
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
    return !this.lock || Math.abs(this.refreshAvg - 1000 / this.lock.hz) < 0.1 * 1000 / this.lock.hz;
  }
  locked(now) { return !this.skipping && !!this.lock && this.displayRefreshing(now); }
  // Display refresh period from gaps between rAF times (2026-11-18). Each gap
  // spans a whole number of refreshes: one, or more when a field kept the main
  // thread busy (on a 240 Hz display a 7-12 ms field skips two or three). The
  // period is the largest one that every gap is close to a multiple of, then
  // the mean of the gaps per refresh, where Chrome's 0.1 ms rounding cancels out.
  // The median used before read 60 Hz as 59.88 and 240 Hz as 238.1 (or, with
  // slow fields, 240 Hz as 80); the rate cap then held the fields back and an
  // image was repeated every ~8 s at 60 Hz. Falls back to the median when no
  // period fits (a variable-refresh display).
  static refreshPeriod(gaps) {
    const sorted = [...gaps].sort((a, b) => a - b), base = sorted[4], med = sorted[sorted.length >> 1];
    for (let k = 1; k <= 6; k++) {
      const c = base / k; if (c < 3) break;
      let sum = 0, n = 0;
      for (const g of gaps) { const m = Math.round(g / c); if (m >= 1 && Math.abs(g - m * c) < 0.25) { sum += g / m; n++; } }
      if (n >= gaps.length * 0.9) return sum / n;
    }
    return med;
  }
  // A refresh the lock gives a field may come up to half a refresh before the
  // rate cap's virtual clock (2026-11-18): the measured refresh rate is only
  // nearly exact, and without this margin its error added up field after
  // field until a refresh could no longer start its field (a repeated image
  // every ~8 s at 60 Hz, ~0.5 s at 240 Hz). A field started that way pulls
  // the virtual clock back to the real refreshes, so the error never adds up;
  // the lock's own p/q count still keeps the fields from running ahead. Only
  // a refresh gets the margin: a field the timer starts keeps the exact cap.
  lockSlack() { return 500 / this.lock.hz; }
  startLocked(now, refresh = true) {
    this.lock.due--; this.lockedFields++; this.next = now;
    if (refresh && this.earliest > now) { this.ideal = now + this.step; this.earliest = now; this.realigned = (this.realigned || 0) + 1; }
    const w = this.waiter; this.waiter = null; return w;
  }
  // p/q nearest the target rate for the measured refresh period, smallest q
  // within 0.15% (else the nearest, q up to 32: a longer pattern broke at 165 Hz
  // with 10 ms fields in the simulation); null when no ratio is within
  // 2%. 0.15% since the arcade rate became the default (2026-11-18, as Scud
  // Race Web): every display runs 57.524 Hz closely, and linked cabinets on
  // different displays stay within 1.5 ms/s of each other: 60 Hz 23/24 (57.50,
  // was 21/22 = 57.27), 75 Hz 23/30 (57.50, was 10/13 = 57.69), 120 Hz 12/25,
  // 144 Hz 2/5 and 240 Hz 6/25 (57.60); 165 Hz keeps 7/20 (57.75).
  // Linked play (linkPace, 2026-11-18): only ratios at or above the arcade rate, up
  // to +0.5%. The netcode places a remote car from its records' arrival times
  // against a 17.385 ms field (central_motion.h, base: the lowest offset of the
  // last 2 s), so a cabinet slower than that fell behind its own clock and the
  // others showed it ahead: 57.4 fields/s put the rival ~1 u ahead at 0 ms
  // (error 1.6 against 1.3 at an exact 57.5); JSPI and the first pthreads runs
  // ran 57.7 and were fine.
  chooseLock(refreshMs) {
    const hz = 1000 / refreshMs, target = 1000 / this.fieldMs;
    let best = null;
    for (let q = 1; q <= 32; q++) {
      const p = this.linkPace ? Math.ceil(target * q / hz - 1e-9) : Math.round(target * q / hz); if (p < 1 || p > 2 * q) continue;
      const err = Math.abs(hz * p / q - target) / target;
      if (this.linkPace && err > 0.005) continue;
      if (!best || err < best.err - 1e-9) best = { p, q, err };
      if (err < 0.0015) break;
    }
    return best && best.err < 0.02 ? { p: best.p, q: best.q, err: best.err, hz, acc: 0, due: 0 } : null;
  }
  drawPending(now) { return !this.skipping && this.pendingDraw && this.displayRefreshing(now); }
  // Late start only when the field cannot be ready before the next refresh
  // anyway: the shortest of the last three fields (engine time) would end
  // after it. A quick field started at once replaced the waiting image before
  // it was shown (one image held three refreshes, then a jump of two fields:
  // 54 irregular images in a 90 s race on a busy PC); it waits for the draw
  // instead, and the lock owes it (oweFields).
  startLate(now) {
    if (this.lateMode === '0') return false;
    if (this.lateMode === '1') return true;
    const next = this.lastRefresh + 1000 / this.lock.hz;
    return now + Math.min(...this.engRecent) > next + 1;
  }
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
    // Emulated display (test only): refreshes on an exact grid, time-stamped like
    // Chrome's rAF (the refresh's own time, rounded down to 0.1 ms).
    const raf = period ? f => { const now = performance.now(); due += period; if (due < now - 4 * period) due = now; const at = due; setTimeout(() => f(Math.floor(at * 10) / 10), Math.max(0, at - now)); } : f => requestAnimationFrame(f);
    const frame = t => {
      raf(frame);
      // A packet the engine finished before this refresh is taken now, not when its
      // message arrives (2026-11-19). On the user's 75 Hz display ~2.6% of the
      // engine's messages reached the page ~8 ms late, always just after the next
      // refresh: the image missed it and the one before stayed three refreshes
      // (the stutters the user marked in a race; the engine had taken 4-6 ms).
      if (!this.unpaced && this.ctl && this.presentedSeen !== undefined && Atomics.load(this.ctl, CTL.presented) !== this.presentedSeen) {
        this.polledPresents = (this.polledPresents || 0) + 1; this.onPresent();
      }
      const now = performance.now();
      this.refreshGap = this.lastRefresh ? now - this.lastRefresh : 1e9;
      const stale = this.refreshGap >= 25;
      this.gapAvg = this.gapAvg ? this.gapAvg + (Math.min(this.refreshGap, 100) - this.gapAvg) * 0.1 : Math.min(this.refreshGap, 100); this.refreshCount = (this.refreshCount || 0) + 1;
      this.lastRefresh = now;
      this.updateSkip(now);
      // Refresh period over the last 90 refreshes (lock re-chosen if it moves by >2%);
      // see refreshPeriod().
      const d = t - lastT; lastT = t;
      // Refresh regularity for the lock (2026-11-18): the gaps between rAF times
      // per refresh they span. While a field runs (7-12 ms) Chrome skips the
      // refreshes in between and runs one rAF later; on fast displays (240 Hz)
      // the callbacks' own gaps then strayed over 10% from the refresh period
      // and the lock switched off (fields on the timer: as if without vsync).
      if (!stale && d > 0 && d < 100 && this.lock) {
        const per = d / Math.max(1, Math.round(d * this.lock.hz / 1000));
        this.refreshAvg = this.refreshAvg ? this.refreshAvg + (per - this.refreshAvg) * 0.1 : per;
      }
      // Long-term refresh period (2026-11-18): time over the refreshes counted in
      // it (gaps rounded to whole refreshes), a window of ~10-20 s. On some
      // displays the 90-gap estimate below wanders by 1-2% (a 69.2 Hz display read
      // 68.6-70.4 Hz): a ratio kept or re-chosen from it ran the game at 56.6 or
      // 58.2 fields/s. The short estimate only detects a new display (>2%).
      if (this.lock && d > 0 && d < 100) {
        this.longT = (this.longT || 0) + d; this.longN = (this.longN || 0) + Math.max(1, Math.round(d * this.lock.hz / 1000));
        if (this.longT > 20000) { this.longT /= 2; this.longN /= 2; }
      }
      if (!stale && d > 3 && d < 25) {
        this.refreshTimes.push(d); if (this.refreshTimes.length > 90) this.refreshTimes.shift();
        if (this.refreshTimes.length === 90) {
          const period = EngineHost.refreshPeriod(this.refreshTimes);
          if (!this.lock || Math.abs(1000 / this.lock.hz - period) / (1000 / this.lock.hz) > 0.02) { this.lock = this.chooseLock(period); this.longT = this.longN = 0; }
          else if (this.longT > 5000) {
            // Same ratio at the long-term rate, unless that rate takes it well off the
            // arcade rate and another ratio is much closer (a display first measured
            // at 68.6 Hz kept 26/31 at 69.2 Hz: 58.0 fields/s). Hysteresis: two ratios
            // ~0.3% off on either side never trade places.
            const long = this.longT / this.longN;
            this.lock.hz = 1000 / long;
            const target = 1000 / this.fieldMs, err = Math.abs(this.lock.hz * this.lock.p / this.lock.q - target) / target;
            const slow = this.linkPace && this.lock.hz * this.lock.p / this.lock.q < target * 0.999;
            const next = err > 0.005 || slow ? this.chooseLock(long) : null;
            if (next && (slow || next.err < err / 2)) { next.due = this.lock.due; this.lock = next; this.relocks = (this.relocks || 0) + 1; }
          }
        }
      }
      const L = this.lock, active = !!L && !this.paused && !this.skipping && this.displayRefreshing(now);
      // Display interpolation (the Smooth motion option, from Scud Race Web 2026-11-19): each refresh the
      // lock moves the game clock by exactly p/q of a field, so its accumulator before
      // this refresh's step (acc/q) is how far the picture is between the last two
      // fields, one field behind: t = acc/q while the engine keeps up (no field due but
      // not released, none released and not presented yet; else t reaches 1 and the
      // newest field stays). The same step every refresh: motion at the display's
      // rate with no drift. Off (t = 1) without the lock.
      let interpT = 1;
      const interp = (this.interp && this.renderer?.interp || this.everyRefresh) && active;   // everyRefresh (?everyrefresh=1, tests): draw every refresh with t = 1
      if (interp) interpT = Math.min(1, Math.max(0, L.due + (this.inFlight ? 1 : 0) + L.acc / L.q));
      if (interp && this.fixedT !== null) interpT = this.fixedT;
      if (active) {
        L.acc += L.p * Math.max(1, Math.round(d / (1000 / L.hz)));   // refreshes since the last one
        while (L.acc >= L.q) { L.acc -= L.q; L.due++; }
      }
      // Fixed image phase on fast displays (2026-11-18): when each field spans two
      // or more refreshes (120 Hz and up), its image waits for the refresh that
      // starts the next field instead of the first one after the field ends. A
      // field takes 7-12 ms, so that first refresh moved by one (4.2 ms at
      // 240 Hz) from field to field: an uneven cadence. Never held longer than
      // the lock's longest gap between fields.
      const hold = !interp && active && L.q >= 2 * L.p && !L.due && this.pendingDraw && (this.held = (this.held || 0) + 1) < Math.ceil(L.q / L.p);
      if (interp && this.fields) {   // every refresh, between the last two fields
        this.pendingDraw = false; this.vsyncDraws++; this.interpDraws = (this.interpDraws || 0) + 1; this.held = 0;
        this.renderer.render(interpT); this.lastInterpT = interpT;
        (this.interpHist ??= new Uint32Array(11))[Math.round(interpT * 10)]++;   // diagnostics (test tools)
        const f = this.afterDraw; this.afterDraw = null; if (f) this.yieldNow(f);
      } else if (this.pendingDraw && !hold) {
        this.pendingDraw = false; this.vsyncDraws++; this.held = 0;
        this.renderer.render();
        const f = this.afterDraw; this.afterDraw = null; if (f) this.yieldNow(f);   // after this frame is handed over
      }
      if (!active) return;
      // No catching up (as Supermodel): a field the engine could not start in
      // time is not run twice in a row later.
      // One field owed at most (2026-11-18): a field whose start a late image held
      // back is run at the pattern's next spare refresh (one that would show an
      // image twice) instead of being lost: the game keeps its speed with no
      // image replaced (see schedule's late start).
      if (L.due > this.oweFields) L.due = this.oweFields;
      // The field starts in a task of its own (2026-11-14), not inside this refresh's
      // rendering step: resuming the engine here (a microtask, 7-12 ms) held back the
      // frame just drawn, so it reached the screen late at random (uneven cadence).
      if (L.due && this.waiter && now >= this.earliest - this.lockSlack()) this.yieldNow(this.startLocked(now));
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
      // Late field (2026-11-18, kept apart from Scud's core): when a refresh that was
      // due for this field already passed while the engine still ran the previous
      // one (a slow field, 13-17 ms in a race), it starts at once instead of after
      // the next refresh draws the previous image, a whole refresh later. Without
      // it every slow field on a 75 Hz display lost a field: the counter fell to
      // 55.6 in a race (chrome_dips.mjs DRIVE=1), where JSPI stayed above 56.8.
      // Only when the field would end after the next refresh anyway (startLate);
      // a quick one waits for the draw and the lock owes it (oweFields).
      if (this.drawPending(performance.now())) {
        const now = performance.now(), L = this.lock;
        if (this.locked(now) && L.due && this.startLate(now)) { this.lateStarts = (this.lateStarts || 0) + 1; this.startLocked(now, false)(); return; }
        this.afterDraw = tick; this.arm(tick, 25); return;
      }
      // Display lock: the refresh loop starts the field; this timer only takes
      // over if the refreshes stop (hidden or occluded window).
      if (this.locked(performance.now())) {
        const now = performance.now();
        if (this.lock.due) { this.startLocked(now, false)(); return; }
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
      if (wait > 6 && !this.rafPending) { this.rafPending = true; requestAnimationFrame(() => { this.rafPending = false; this.yieldNow(tick); }); }
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
  // Page restart or exit: the engine stops at its next wait and its worker
  // (with the pthreads) is ended, so a reload never keeps the old engine's
  // memory (the JSPI build kept ~1 GB per reload, 2026-11-12).
  stop() {
    if (this.stopped || !this.worker) return;
    this.stopped = true;
    Atomics.store(this.ctl, CTL.stop, 1); Atomics.add(this.ctl, CTL.go, 1); Atomics.notify(this.ctl, CTL.go);
    clearTimeout(this.timer); this.afterDraw = null; this.waiter = null; this.queue = [];
    setTimeout(() => { try { this.worker.terminate(); } catch {} }, 50);
  }
  setPaused(paused) { this.paused = paused; if (!paused) this.next = performance.now(); this.updateSpin(); }
  // Smooth motion (display interpolation, from Scud Race Web 2026-11-19): the engine
  // pairs the scene's instances with the previous scene's only while it is on (ctl 15,
  // web_bridge.cpp publish).
  set interp(on) { this.interpOn = !!on; if (this.ctl) Atomics.store(this.ctl, CTL.interp, on ? 1 : 0); }
  get interp() { return !!this.interpOn; }
  // Engine busy wait (ctl 22, platform_web_target.c wait_for_page), as Scud
  // Race Web (2026-11-18): on while the game runs in a visible tab, so the CPU
  // keeps its clock between fields (a regular cadence); off when paused or
  // hidden. Sleeping instead, at 75 Hz: 57.2 fields/s and an engine p99 of 11 ms
  // (slow fields after each sleep: an irregular cadence); busy: 57.5 and 7.2.
  // ?spin=0 turns it off (less CPU: ~56% of a core for the game process
  // against ~125%).
  updateSpin() {
    if (!this.ctl) return;
    const allowed = this.spinAllowed ??= new URLSearchParams(location.search).get('spin') !== '0';
    const on = allowed && !this.paused && !this.stopped && !document.hidden && !this.unpaced;
    Atomics.store(this.ctl, CTL.spin, on ? 1 : 0);
    if (!this.spinWatch) { this.spinWatch = true; document.addEventListener('visibilitychange', () => this.updateSpin()); }
  }
  fps() {
    if (this.frameTimes.length < 10) return 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return 1000 / avg;
  }
}
// WebControl in web/native/platform_web_target.c (32-bit words).
export const CTL = Object.freeze({ go: 0, presented: 1, packet: 2, save: 3, stop: 4, unpaced: 5, burst: 6, engineUs: 7, field: 8, waitUs: 9, resync: 10, soundUs: 11,
  rumbleStrong: 12, rumbleWeak: 13, wheelForce: 14, interp: 15, sceneWaitUs: 19, linkPhase: 20, boardWaitUs: 21, spin: 22,
  contactHuman: 23, contactSkipped: 24, contactDeparted: 25, contactClosest: 26, contactMask: 27, wallResetSkipped: 28, ramPtr: 29, words: 40 });
