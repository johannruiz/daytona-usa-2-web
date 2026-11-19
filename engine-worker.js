// Daytona USA 2 engine worker (Claude 2026-11-18, from Scud Race Web's).
//
// The WASM engine (daytona2.js, Emscripten pthreads) runs here, in a dedicated
// Worker, never on the page's main thread. This worker is the module's main
// runtime thread; the sound board and the scene builder are its pthreads.
//
// Before main() starts the worker answers the page's messages (ROM import,
// files, the link's shared buffer). Once main() runs it never returns to its
// event loop: the engine waits between fields on a futex in shared memory
// (web/native/platform_web_target.c) that the page (engine-host.js) releases
// when the next field is due. From then on:
//   - engine -> page: postMessage (each packet, logs, saved backups, link sends);
//   - page -> engine: shared memory only (control block, input record, the
//     link's records), since no message reaches this worker any more.
// So no JSPI, and the engine's work never blocks the page.

let M = null, roms = null, link = null, started = false;
const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const log = text => post({ t: 'log', text: String(text) });

// ---- the central link transport, engine side (src/comm/central_link.c, DAYTO_WEB) ----
// The page's CentralLinkNet (central-link-net.js) owns the WebRTC links and
// keeps every node's records, joined states and transit estimates in a
// SharedArrayBuffer (LAYOUT, mirrored there). This side reads it directly;
// what the engine does (publish, join, link) goes to the page as messages.
// Its own records are also written here, so the engine reads its block back
// at once.
function makeLink(shared, layout) {
  const L = layout, head = new Int32Array(shared, 0, L.headWords), joined = new Int32Array(shared, L.joined, L.nodes);
  const pub = new Float64Array(shared, L.pub, L.nodes), transit = new Float64Array(shared, L.transit, L.nodes);
  const tags = new Float64Array(shared, L.tags, L.nodes * L.ring), blocks = new Uint8Array(shared, L.blocks, L.nodes * L.ring * L.slot);
  let me = 0;
  const poses = [], flushPoses = () => { post({ t: 'link', op: 'pose', rows: poses.splice(0) }); };
  const poseSink = { get length() { return 0; }, push(r) { poses.push(r); flushPoses(); } };
  return {
    open(nodes, node) { me = node; post({ t: 'link', op: 'open', nodes, node }); return Atomics.load(head, L.OPEN) === 1; },
    close() { Atomics.store(joined, me, 2); post({ t: 'link', op: 'close' }); },
    setJoined(state) { Atomics.store(joined, me, state); post({ t: 'link', op: 'joined', state }); },
    joined(j) { return Atomics.load(joined, j); },
    setLinked() { Atomics.store(head, L.LINKED, 1); post({ t: 'link', op: 'linked' }); },
    linked() { return Atomics.load(head, L.LINKED) === 1; },
    publish(seq, block) {
      const i = me * L.ring + seq % L.ring; tags[i] = -1; blocks.set(block.subarray(0, L.slot), i * L.slot); tags[i] = seq;
      if (seq + 1 > pub[me]) pub[me] = seq + 1;
      post({ t: 'link', op: 'publish', seq, block }, [block.buffer]);
    },
    published(j) { return pub[j]; },
    // Lockstep only: wait for node j's record `want` (0), or give up (1) when it
    // left or stayed silent for timeoutMs. The page bumps head[NOTIFY] on every
    // record and state change.
    wait(j, want, timeoutMs) {
      const end = performance.now() + timeoutMs;
      for (;;) {
        if (pub[j] > want) return 0;
        if (Atomics.load(joined, j) === 2) return 1;
        const left = end - performance.now(); if (left <= 0) return 1;
        const seen = Atomics.load(head, L.NOTIFY);
        if (pub[j] > want) return 0;
        Atomics.wait(head, L.NOTIFY, seen, Math.min(left, 50));
      }
    },
    // A copy, kept only if the slot's tag stayed the same meanwhile (the page
    // sets it to -1 while it rewrites the slot).
    fetch(j, want) {
      const i = j * L.ring + want % L.ring; if (tags[i] !== want) return null;
      const out = blocks.slice(i * L.slot, (i + 1) * L.slot); return tags[i] === want ? out : null;
    },
    transitFields(j) { return transit[j]; },
    set motionStats(v) { post({ t: 'link', op: 'stats', stats: v }); },
    set racing(on) { post({ t: 'link', op: 'racing', on: !!on }); },
    onRacing: null,
    // tp_pose_js (test only): rows recorded while the page asks (head[POSE]),
    // sent to its link.poseLog at once (the test tool stamps each row on arrival).
    get poseLog() { if (Atomics.load(head, 3) !== 1) { if (poses.length) flushPoses(); return null; } return poseSink; },
  };
}

const daytonaHost = {
  // platform_present: a packet is ready in shared memory. The first one also
  // releases the /roms files: main() has copied every region into its own
  // memory and keeps only those copies (~230 MB less, 2026-11-18).
  present(packet, field) {
    if (roms !== null) { dropRomFiles(); roms = null; }
    post({ t: 'present', packet, field });
  },
  // backup_web.c saved the cabinet backup: hand the bytes to the page (IndexedDB).
  backupSaved(path) { try { const b = M.FS.readFile(path); post({ t: 'backup', path, bytes: b }, [b.buffer]); } catch (e) { log('[backup] ' + e); } },
  get link() { return link; },
};
function dropRomFiles() {
  let freed = 0;
  try { for (const n of M.FS.readdir('/roms')) if (n.endsWith('.bin')) { freed += M.FS.stat('/roms/' + n).size; M.FS.unlink('/roms/' + n); } } catch {}
  if (freed) log(`[engine] ROM files released: ${(freed / 1048576).toFixed(0)} MB`);
}
function mkdirs(path) { const parts = path.split('/').slice(1, -1); let p = ''; for (const s of parts) { p += '/' + s; try { M.FS.mkdir(p); } catch {} } }

self.onmessage = async e => {
  const d = e.data;
  try {
    if (d.t === 'init') {
      importScripts(d.script);
      M = await createDaytonaEngine({
        noInitialRun: true,
        mainScriptUrlOrBlob: d.script,
        print: t => log(t), printErr: t => log(t),
        onExit: code => post({ t: 'exit', code }),
        onAbort: what => post({ t: 'abort', what: String(what) }),
        daytonaHost,
      });
      post({ t: 'ready', memory: M.wasmMemory, control: M._dayto_web_control_ptr(), input: M._dayto_web_input_ptr(), audio: M._dayto_web_audio_ring(), ram: M._dayto_web_ram_ptr(), packet: M._dayto_web_frame_packet(), cores: navigator.hardwareConcurrency || 0 });
    } else if (d.t === 'alloc') {
      // Memory (2026-11-18): the page writes large data (the ROM ZIP, dev ROM
      // regions) straight into the engine's shared memory. Nothing large ever
      // becomes a JS object here: this worker never returns to its event loop
      // once main() runs, so its JS garbage was never collected (~330 MB).
      post({ t: 'reply', id: d.id, value: M._malloc(d.size) });
    } else if (d.t === 'import') {
      const dir = M.stringToNewUTF8('/roms'), code = M._dayto_web_import_rom(d.ptr, d.size, dir);
      M._free(d.ptr); M._free(dir);
      post({ t: 'reply', id: d.id, value: { ok: code === 0, code, missing: code === 2 ? M.UTF8ToString(M._dayto_web_import_missing()) : '' } });
    } else if (d.t === 'region') {
      const name = M.stringToNewUTF8(d.name), ok = M._dayto_web_set_region(name, d.ptr, d.size); M._free(name);
      post({ t: 'reply', id: d.id, value: !!ok });
    } else if (d.t === 'writeFile') {
      mkdirs(d.path); M.FS.writeFile(d.path, d.bytes); if (d.path.startsWith('/roms/')) roms = '/roms';
      if (d.id !== undefined) post({ t: 'reply', id: d.id, value: true });
    } else if (d.t === 'readFile') {
      let bytes = null; try { bytes = M.FS.readFile(d.path); } catch {}
      post({ t: 'reply', id: d.id, value: bytes });
    } else if (d.t === 'link') {
      link = makeLink(d.shared, d.layout);
    } else if (d.t === 'start') {
      if (started) return; started = true;
      // environ is built when the module starts: set variables through libc so getenv() sees them.
      for (const [k, v] of Object.entries(d.env)) { const a = M.stringToNewUTF8(k), b = M.stringToNewUTF8(String(v)); M._setenv(a, b, 1); M._free(a); M._free(b); }
      post({ t: 'started' });
      M.callMain([]);   // returns only when the engine exits
    }
  } catch (err) {
    if (err && err.name === 'ExitStatus') { post({ t: 'exit', code: err.status }); return; }
    if (err === 'unwind') return;
    post({ t: 'error', message: String(err && err.stack || err) });
  }
};
