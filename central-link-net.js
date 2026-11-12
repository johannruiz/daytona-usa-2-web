// Central link over WebRTC for Daytona USA 2 web (Claude 2026-11-11).
// Browser transport of src/comm/central_link.c (DAYTO_WEB build): the host
// cabinet is node 0 (MASTER) and the central relay. Every field each cabinet
// publishes one record (node, sequence, 848-byte block); the host forwards
// every record to all cabinets. The engine waits (JSPI) for the record of
// each node DAYTO_CENTRAL_DELAY fields back, so all cabinets see the other
// cars with one fixed latency. Rooms use PeerJS signalling, as Daytona USA
// Web does (web/site/vendor/peerjs.min.js); data flows peer to peer.
// Asynchronous mode (default, Claude 2026-11-12, after Daytona USA Web's
// MotionChannel/LatestFlow): field records travel on a second, negotiated,
// unordered channel without retransmissions; a late record is never
// waited for and a congested channel drops records instead of queueing
// them. The engine poses remote cars from whatever has arrived
// (src/comm/central_motion.h). Control messages stay on the reliable channel.
const RING = 32, SLOT = 848, PREFIX = 'd2pe-';
const MAX_NODES = 16;   // Daytona USA 2 links 2-16 cabinets (CL_MAX_NODES in src/comm/central_link.c)
const MOTION_LABEL = 'd2-motion-v1', MOTION_BUFFER_LIMIT = 16384, FIELD_HZ = 60;
// Test-only: this cabinet's own network is bad: ?netsim=delayMs,jitterMs,lossPercent
// delays (and drops records) on everything it receives and sends, once per direction.
const NETSIM = (() => { const m = /[?&]netsim=([\d.]+)(?:,([\d.]+))?(?:,([\d.]+))?/.exec(globalThis.location?.search || '');
  return m ? { delay: +m[1], jitter: +(m[2] || 0), loss: +(m[3] || 0) / 100 } : null; })();
// Public STUN servers, as Daytona USA Web's DEFAULT_ICE (turn-client.js). Its TURN
// relay needs D1's Firebase-authenticated worker and is not used here yet.
const PEER_OPTIONS = { config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] } };

function loadPeerJS() {
  if (globalThis.Peer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = './vendor/peerjs.min.js';
    s.onload = resolve; s.onerror = () => reject(new Error('PeerJS failed to load')); document.head.appendChild(s);
  });
}
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

export class CentralLinkNet {
  constructor() {
    this.isHost = false; this.peer = null; this.conns = []; this.hostConn = null;
    this.nodes = 0; this.node = 0; this.delay = 2;
    this.joinedState = Array(MAX_NODES).fill(0); this.isLinked = false;
    this.tags = [...Array(MAX_NODES)].map(() => new Float64Array(RING).fill(-1));
    this.blocks = [...Array(MAX_NODES)].map(() => [...Array(RING)].map(() => new Uint8Array(SLOT)));
    this.pub = Array(MAX_NODES).fill(0); this.waiters = [];
    this.session = false;
    this.rtt = Array(MAX_NODES).fill(null); this.motionSent = 0; this.motionDropped = 0; this.motionReceived = 0; this.reliableRecords = 0;
    this.pingTimer = null; this.netsimLast = 0;
    this.lastRecordAt = Array(MAX_NODES).fill(0); this.recordCount = Array(MAX_NODES).fill(0); this.firstSeq = Array(MAX_NODES).fill(-1);
    this.onSession = () => {}; this.onStatus = () => {}; this.onConnect = () => {}; this.onDisconnect = () => {};
    this.onMessage = () => {}; this.onFailure = () => {}; this.onSignaling = () => {};
  }
  // ---- rooms (PeerJS signalling; room.js owns admission, seats and chat) ----
  // Before the race every DataConnection only carries room messages; when the
  // host starts, the admitted connections become central link nodes 1..N-1.
  // reuse: the room code to open again after a page restart; the signalling
  // server may still hold the old page's id for a few seconds, so retry.
  async host(reuse) {
    await loadPeerJS(); this.isHost = true; const room = reuse || code();
    for (let attempt = 0; ; attempt++) {
      this.peer = new Peer(PREFIX + room, PEER_OPTIONS);
      try { await new Promise((res, rej) => { this.peer.on('open', res); this.peer.on('error', rej); }); break; }
      catch (e) { try { this.peer.destroy(); } catch {} if (!reuse || e?.type !== 'unavailable-id' || attempt >= 40) throw e; await new Promise(r => setTimeout(r, 1000)); }
    }
    this.peer.on('connection', c => this.attach(c));
    this.peer.on('disconnected', () => { this.onSignaling(false); try { this.peer.reconnect(); } catch {} });
    this.peer.on('open', () => this.onSignaling(true));
    return room;
  }
  async join(room) {
    await loadPeerJS(); this.peer = new Peer(PEER_OPTIONS);
    await new Promise((res, rej) => { this.peer.on('open', res); this.peer.on('error', rej); });
    this.peer.on('error', e => { if (e?.type === 'peer-unavailable') this.onFailure('That room is not available. Check the invitation.'); });
    const c = this.peer.connect(PREFIX + room, { reliable: true, serialization: 'binary' });
    this.hostConn = c; this.attach(c);
    c.on('error', e => this.onFailure('Connection error: ' + (e?.type || e)));
  }
  attach(c) {
    c.on('open', () => { this.openMotion(c); this.onConnect(c); });
    c.on('data', d => this.simulate(d, c));
    c.on('close', () => { if (this.session) this.leave(this.isHost ? c.node : 0); this.onDisconnect(c); });
  }
  // Both ends create the same negotiated channel id, so no datachannel event
  // reaches PeerJS (as Daytona USA Web's motionChannelId).
  openMotion(c) {
    const pc = c.peerConnection; if (!pc?.createDataChannel || c.motion) return;
    const max = pc.sctp?.maxChannels ?? 65535, id = [16, 17, 2, 3].find(n => n < max && n !== c.dataChannel?.id);
    if (id === undefined) return;
    try {
      const m = pc.createDataChannel(MOTION_LABEL, { negotiated: true, id, ordered: false, maxRetransmits: 0 });
      m.binaryType = 'arraybuffer'; c.motion = m;
      m.onmessage = e => { this.motionReceived++; this.simulate(e.data, c); };
      m.onclose = () => { if (c.motion === m) c.motion = null; };
    } catch { c.motion = null; }
  }
  // Records prefer the motion channel; a full send buffer drops the record
  // (the next one supersedes it). Without the channel, the reliable one.
  sendRecord(c, buffer) {
    if (NETSIM) { if (Math.random() < NETSIM.loss) return; setTimeout(() => this.sendRecordNow(c, buffer), NETSIM.delay + Math.random() * NETSIM.jitter); return; }
    this.sendRecordNow(c, buffer);
  }
  sendRecordNow(c, buffer) {
    const m = c.motion;
    if (m && m.readyState === 'open') {
      if (m.bufferedAmount > MOTION_BUFFER_LIMIT) { this.motionDropped++; return; }
      try { m.send(buffer); this.motionSent++; return; } catch { }
    }
    if (c.open) { c.send(buffer); this.reliableRecords++; }
  }
  simulate(d, c) {
    if (!NETSIM) { this.receive(d, c); return; }
    const record = d instanceof ArrayBuffer || ArrayBuffer.isView(d), now = performance.now();
    if (record && Math.random() < NETSIM.loss) return;
    let at = now + NETSIM.delay + (record ? Math.random() * NETSIM.jitter : 0);
    if (!record) { at = Math.max(at, this.netsimLast); this.netsimLast = at; }   // control stays ordered
    setTimeout(() => this.receive(d, c), at - now);
  }
  // Round trip per cabinet during the race (host measures, then shares).
  startPings() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.session) return;
      if (this.isHost) this.broadcast({ t: 'lping', ts: performance.now(), rtt: this.rtt });
    }, 1000);
  }
  // One-way transit from node j to this cabinet, in fields (engine prediction).
  transitFields(j) {
    const half = n => (this.rtt[n] ?? 0) / 2;
    const ms = this.isHost ? half(j) : half(this.node) + (j ? half(j) : 0);
    return ms * FIELD_HZ / 1000;
  }
  // Share of node j's records that never reached this cabinet (0..1), or null.
  lossOf(j) {
    if (this.firstSeq[j] < 0) return null;
    const expected = this.pub[j] - this.firstSeq[j];
    return expected > 60 ? Math.max(0, 1 - this.recordCount[j] / expected) : null;
  }
  get id() { return this.peer?.id || ''; }
  // conns: the admitted guests in node order; extra(conn) adds per-cabinet data.
  startSession(conns, extra = () => ({}), shared = {}) {
    if (!this.isHost) return;
    const nodes = conns.length + 1; this.conns = conns; this.session = true;
    conns.forEach((c, i) => { c.node = i + 1; c.send({ t: 'start', nodes, node: c.node, delay: this.delay, ...shared, ...extra(c) }); });
    this.startPings();
    this.onSession({ nodes, node: 0, ...shared, ...extra(null) });
  }
  receive(d, from) {
    if (d instanceof ArrayBuffer || ArrayBuffer.isView(d)) {   // field record
      const bytes = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
      const node = bytes[0], seq = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0, true);
      if (this.arrivalLog && this.arrivalLog.length < 100000) this.arrivalLog.push([node, seq, performance.now()]);
      this.lastRecordAt[node] = performance.now(); this.recordCount[node]++; if (this.firstSeq[node] < 0) this.firstSeq[node] = seq;
      this.store(node, seq, bytes.subarray(5, 5 + SLOT));
      if (this.isHost) this.forward(bytes, from);
      return;
    }
    if (d.t === 'start') { this.delay = d.delay; this.session = true; this.onSession(d); }
    else if (d.t === 'lping') { if (Array.isArray(d.rtt) && !this.isHost) d.rtt.forEach((v, i) => { this.rtt[i] = v; }); const pong = () => from.send({ t: 'lpong', ts: d.ts }); if (NETSIM) setTimeout(pong, NETSIM.delay); else pong(); }
    else if (d.t === 'lpong') { if (this.isHost && from.node) this.rtt[from.node] = Math.round(performance.now() - d.ts); }
    else if (d.t === 'joined') { this.joinedState[d.node] = d.state; if (this.isHost) this.broadcast(d, from); this.wake(); }
    else if (d.t === 'linked') { this.isLinked = true; }
    else this.onMessage(d, from);
  }
  broadcast(msg, except) { for (const c of this.conns) if (c !== except && c.open) c.send(msg); }
  forward(bytes, except) { const copy = bytes.slice().buffer; for (const c of this.conns) if (c !== except && c.open) this.sendRecord(c, copy); }
  leave(node) { if (node === undefined) return; this.joinedState[node] = 2; this.wake(); this.onStatus(`Cabinet ${node + 1} left.`); }
  disconnect() { clearInterval(this.pingTimer); try { this.peer?.destroy(); } catch {} this.peer = null; this.conns = []; this.hostConn = null; this.isHost = false; this.session = false; }
  // ---- engine transport (src/comm/central_link.c, DAYTO_WEB) --------------
  open(nodes, node) { this.nodes = nodes; this.node = node; return true; }
  close() { this.setJoined(2); }
  setJoined(state) {
    this.joinedState[this.node] = state;
    const msg = { t: 'joined', node: this.node, state };
    if (this.isHost) this.broadcast(msg); else this.hostConn?.send(msg);
  }
  joined(j) { return this.joinedState[j]; }
  setLinked() { this.isLinked = true; this.broadcast({ t: 'linked' }); }
  linked() { return this.isLinked; }
  store(node, seq, block) {
    const r = seq % RING; this.blocks[node][r].set(block); this.tags[node][r] = seq;
    if (this.onRecord && seq + 1 > this.pub[node]) this.onRecord(node, seq, block);
    if (seq + 1 > this.pub[node]) this.pub[node] = seq + 1;
    this.wake();
  }
  publish(seq, block) {
    this.store(this.node, seq, block);
    const msg = new Uint8Array(5 + SLOT); msg[0] = this.node; new DataView(msg.buffer).setUint32(1, seq, true); msg.set(block, 5);
    if (this.isHost) this.forward(msg, null); else if (this.hostConn?.open) this.sendRecord(this.hostConn, msg.buffer);
  }
  published(j) { return this.pub[j]; }
  fetch(j, want) { const r = want % RING; return this.tags[j][r] === want ? this.blocks[j][r] : null; }
  wait(j, want, timeout) {
    if (this.pub[j] > want) return Promise.resolve(0);
    if (this.joinedState[j] === 2) return Promise.resolve(1);
    return new Promise(resolve => {
      const w = { j, want, resolve, timer: setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); resolve(1); }, timeout) };
      this.waiters.push(w);
    });
  }
  wake() {
    if (!this.waiters.length) return;
    this.waiters = this.waiters.filter(w => {
      if (this.pub[w.j] > w.want || this.joinedState[w.j] === 2) { clearTimeout(w.timer); w.resolve(this.pub[w.j] > w.want ? 0 : 1); return false; }
      return true;
    });
  }
}
