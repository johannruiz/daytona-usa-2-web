// Private multiplayer room for Daytona USA 2 web (Claude 2026-11-11).
// Same lobby model as Daytona USA Web (multiplayer.js) restricted to private
// rooms: the host cabinet is authoritative over admission (join requests are
// approved or declined), the seats (car numbers 1-SEATS), Ready, the shared
// race settings and the room chat; guests send commands and receive the whole
// room state after every change. Starting the race turns the admitted
// connections into central link nodes (the host is node 0, the MASTER; the
// others follow in seat order) and every cabinet writes its car number and the
// shared race settings into its EEPROM before the engine boots.
// The engine runs once per page, so the room stays in 'playing' after the
// start: races continue in the original attract/coin cycle on the same link.
import { explainConnection } from './central-link-net.js';
import { RaceOrder } from './race-order.js';
export const SEATS = 16, CHAT_LIMIT = 240, CHAT_HISTORY = 60, CHAT_INTERVAL_MS = 900;
export const DEFAULT_SETTINGS = Object.freeze({ mode: 0, difficulty: 1, voice: 0, lapsBeginner: 8, lapsAdvanced: 4, lapsExpert: 2, playerCollision: 1 });
const SETTING_RANGES = { mode: [0, 6], difficulty: [0, 3], voice: [0, 1], lapsBeginner: [8, 16], lapsAdvanced: [4, 12], lapsExpert: [2, 8], playerCollision: [0, 1] };
const cleanRoomName = v => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48);
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
const cleanName = v => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || 'Driver';
const cleanSettings = (v, base = DEFAULT_SETTINGS) => {
  const out = { ...base };
  for (const [k, [lo, hi]] of Object.entries(SETTING_RANGES)) { const n = Number(v?.[k]); if (Number.isInteger(n) && n >= lo && n <= hi) out[k] = n; }
  return out;
};
export function parseInvitation(value) {
  const raw = String(value || '').trim(), code = (raw.match(/room=([A-Z0-9]+)/i)?.[1] || raw).toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) throw new Error('Paste a complete invitation link or room code.');
  return code;
}

export class PrivateRoom {
  constructor(link, { onChange = () => {}, onEvent = () => {}, onStart = () => {}, onStop = () => {} } = {}) {
    Object.assign(this, { link, onChange, onStart, onStop });
    this.onEvent = e => { this.logEvent(e.kind, e.name || ''); onEvent(e); };
    this.reset();
    link.onConnect = c => this.connected(c);
    link.onDisconnect = c => this.disconnected(c);
    link.onMessage = (d, c) => this.message(d, c);
    link.onFailure = reason => this.fail(reason);
    link.onSignaling = up => { this.signaling = up; this.changed(); };
    // Joining progress and failures in words (2026-11-12): see explainConnection.
    link.onStage = stage => { this.stage = stage; this.changed(); };
    link.onConnectFailed = e => this.onEvent({ kind: 'connect-failed', name: cleanName(e.name), inGame: this.phase === 'playing' });
    link.onSession = session => this.started(session);
    // Chat pauses while a cabinet races, as in Daytona USA Web (src/comm/central_link.c reports the phase).
    link.onRacing = on => this.racePhase(on);
    // Authoritative race order (host): every car record feeds it; shared every 250 ms.
    this.raceOrder = new RaceOrder(); this.order = null; this.onOrder = () => {};
    link.onRecord = (node, seq, block) => { if (this.isHost && this.phase === 'playing') this.raceOrder.record(node, seq, block, performance.now(), node ? (link.rtt[node] ?? 0) / 2 : 0); };
    setInterval(() => this.shareOrder(), 250);
    setInterval(() => this.ping(), 2000);
    // Each cabinet reports its link health to the host every 2 s (connection console).
    this.health = () => ({}); setInterval(() => this.reportHealth(), 2000);
    this.events = [];
  }
  reset() {
    this.phase = 'idle'; this.code = ''; this.hostId = ''; this.isHost = false; this.error = '';
    this.members = []; this.pending = []; this.chat = []; this.settings = { ...DEFAULT_SETTINGS };
    this.peers = new Map(); this.seq = 0; this.lastChat = 0; this.command = 0; this.lastAck = null;
    this.readyPending = false; this.seatPending = 0; this.signaling = true; this.name = 'Driver'; this.refusal = '';
    this.stage = ''; this.answered = false; clearTimeout(this.answerTimer);
    this.roomName = ''; this.token = ''; this.reserved = []; this.swaps = []; this.waiters = [];   // swaps: seat-swap offers (30 s, as Daytona USA Web)   // reserved: seats kept for drivers returning after a restart
  }
  get id() { return this.link.id; }
  get occupied() { return this.phase !== 'idle'; }
  get active() { return ['lobby', 'playing'].includes(this.phase) && this.members.some(m => m.id === this.id); }
  snapshot() {
    return { phase: this.phase, id: this.id, host: this.hostId, isHost: this.isHost, code: this.code, error: this.error,
      members: this.members.map(m => ({ ...m })), pending: this.pending.map(m => ({ ...m })), chat: this.chat.slice(),
      settings: { ...this.settings }, lastAck: this.lastAck, readyPending: this.readyPending, seatPending: this.seatPending,
      signaling: this.signaling, chatAvailable: this.active, visibility: 'private', roomName: this.roomName, stage: this.stage,
      reserved: this.reserved.map(r => ({ name: r.name, cabinet: r.cabinet })), swaps: this.swaps.map(o => ({ ...o })), waiters: this.waiters.map(w => ({ id: w.id, name: w.name })) };
  }
  changed() { this.onChange(this.snapshot()); }
  logEvent(kind, name, detail = '') { this.events.push({ at: Date.now(), kind, name, detail }); if (this.events.length > 200) this.events.shift(); }
  shareOrder() {
    if (!this.isHost || this.phase !== 'playing') return;
    const racing = this.members.filter(m => m.racing && !m.departed && m.node != null).map(m => m.node);
    const departed = this.members.filter(m => m.racing && m.departed && m.node != null).map(m => m.node);
    const order = racing.length + departed.length >= 2 && racing.length ? this.raceOrder.compute(racing, performance.now(), departed) : null;
    if (!order) return;
    this.order = order; this.onOrder(order);
    for (const [c, info] of this.peers) if (info.state === 'member') this.send(c, { t: 'order', order });
  }
  reportHealth() {
    if (!this.active) return;
    const l = this.link, h = { at: Date.now(), ...this.health(), loss: l.session ? l.lossOf(0) : null, motion: l.motionStats?.nodes?.[0] || null, rtt: l.rtt?.[l.node] ?? null };
    if (this.isHost) { const me = this.members.find(m => m.id === this.id); if (me) me.health = { at: Date.now(), ...this.health() }; }
    else if (l.hostConn?.open) this.send(l.hostConn, { t: 'health', health: h });
  }

  // ---- entry ------------------------------------------------------------------
  // restore: the room as it was before the host's page restarted (same code;
  // the other drivers come back to their seats with their tokens).
  async create(name, { roomName = '', restore = null } = {}) {
    this.leave(); this.name = cleanName(name); this.roomName = cleanRoomName(roomName || restore?.roomName); this.phase = 'connecting'; this.changed();
    try { this.code = await this.link.host(restore?.code); }
    catch (e) { this.fail(explainConnection(e?.type || e?.message, 'host')); throw new Error(this.error); }
    this.isHost = true; this.hostId = this.id; this.phase = 'lobby';
    const me = restore?.members?.find(m => m.self);
    this.members = [{ id: this.id, name: this.name, cabinet: me?.cabinet || 1, ready: false, connection: 'connected', rtt: null }];
    if (restore) {
      this.settings = cleanSettings(restore.settings); this.chat = Array.isArray(restore.chat) ? restore.chat.slice(-CHAT_HISTORY) : []; this.seq = this.chat.at(-1)?.seq || 0;
      this.reserved = (restore.members || []).filter(m => !m.self && m.token && m.cabinet).map(m => ({ name: cleanName(m.name), cabinet: m.cabinet, token: m.token, until: Date.now() + 60000 }));
      for (const w of (restore.members || []).filter(m => !m.self && m.token && !m.cabinet)) {   // former waiters take the free seats
        const seat = this.freeSeat(); if (seat) this.reserved.push({ name: cleanName(w.name), cabinet: seat, token: w.token, until: Date.now() + 60000 });
      }
    }
    this.changed();
  }
  async join(invitation, name, resumeToken = '') {
    const code = parseInvitation(invitation);
    this.leave(); this.name = cleanName(name); this.code = code; this.hostId = 'd2pe-' + code; this.phase = 'connecting'; this.token = resumeToken; this.changed();
    try { await this.link.join(code, this.name); }
    catch (e) { this.fail(explainConnection(e?.type || e?.message)); throw new Error(this.error); }
  }
  // What a page restart needs to bring this cabinet back into the same room.
  resumeState() {
    if (!this.code || !['lobby', 'playing', 'waiting'].includes(this.phase)) return null;
    if (this.isHost) return { role: 'host', code: this.code, name: this.name, roomName: this.roomName, settings: this.settings, chat: this.chat.slice(-CHAT_HISTORY),
      members: [...this.members.filter(m => !m.departed || m.connection === 'stalled').map(m => ({ name: m.name, cabinet: m.cabinet, token: m.token || '', self: m.id === this.id })),
        ...this.waiters.map(w => ({ name: w.name, cabinet: 0, token: w.token, self: false }))], at: Date.now() };
    return this.token ? { role: 'guest', code: this.code, name: this.name, token: this.token, at: Date.now() } : null;
  }
  // Host: end the linked game for everyone and return to the room.
  stopRace() {
    if (!this.isHost || this.phase !== 'playing') return false;
    for (const [c, info] of this.peers) if (info.state === 'member' || info.state === 'waiter') this.send(c, { t: 'stop' });
    this.logEvent('race-stop', ''); this.onStop('host'); return true;
  }
  leave() {
    if (this.phase === 'idle') return;
    for (const c of this.peers.keys()) { try { c.close(); } catch {} }
    this.link.disconnect(); this.reset(); this.changed();
  }
  fail(reason) { if (this.phase === 'idle' && !reason) return; this.error = reason; this.phase = 'error'; this.changed(); }

  // ---- transport -----------------------------------------------------------------
  connected(c) {
    if (!this.isHost) {
      if (this.phase !== 'connecting') { try { c.close(); } catch {} return; }   // opened after a failure was already explained
      this.send(c, { t: 'hello', name: this.name, token: this.token || undefined }); this.phase = 'pending'; this.stage = ''; this.changed();
      clearTimeout(this.answerTimer); this.answerTimer = setTimeout(() => { if (!this.answered && this.phase === 'pending') this.fail(explainConnection('no-room-answer')); }, 15000);
      return;
    }
    this.peers.set(c, { id: c.peer, name: '', state: 'new' });
  }
  disconnected(c) {
    if (!this.isHost) {
      if (this.phase === 'idle' || this.phase === 'error') return;   // reported once (the link and the ping can both see it)
      const playing = this.phase === 'playing';
      this.fail(this.refusal || (playing ? 'The host cabinet left. The race cannot finish without it: open the menu to leave the room.' : 'The host closed the room.'));
      return;
    }
    const info = this.peers.get(c); this.peers.delete(c); if (!info) return;
    const member = this.members.find(m => m.id === info.id);
    if (member && this.phase === 'playing') { member.connection = 'left'; member.departed = true; }
    else this.members = this.members.filter(m => m.id !== info.id);
    this.pending = this.pending.filter(m => m.id !== info.id); this.waiters = this.waiters.filter(w => w.id !== info.id);
    if (member || info.state === 'pending' || info.state === 'waiter') this.onEvent({ kind: 'left', name: info.name || 'A driver', inGame: this.phase === 'playing' });
    this.publish();
  }
  send(c, msg) { try { if (c?.open) c.send(msg); } catch {} }
  connFor(id) { for (const [c, info] of this.peers) if (info.id === id) return c; return null; }
  publish() {
    if (!this.isHost) return;
    const state = { phase: this.phase, code: this.code, host: this.hostId, members: this.members.map(({ token: _, ...m }) => m), pending: this.pending, chat: this.chat, settings: this.settings,
      roomName: this.roomName, reserved: this.reserved.map(r => ({ name: r.name, cabinet: r.cabinet })), swaps: this.swaps, waiters: this.waiters.map(w => ({ id: w.id, name: w.name })) };
    for (const [c, info] of this.peers) if (info.state !== 'new') this.send(c, { t: 'sync', state, ack: info.ack || null });
    this.changed();
  }
  ack(c, action, accepted, reason = '') {
    const info = this.peers.get(c); if (info) info.ack = { command: ++this.command, action, accepted, reason };
  }
  // A cabinet the link gave up on (no record for DAYTO_CENTRAL_TIMEOUT_MS: a
  // frozen page or a tab the browser stopped) is out of this game for good:
  // src/comm/central_link.c never takes it back, because its race would resume
  // where it froze. It keeps its seat and waits in the room ('stalled') until the
  // host returns everyone to the room; its car stays on the others' track
  // without collision, as a departed cabinet's.
  checkStalled() {
    if (!this.isHost || this.phase !== 'playing') return;
    const nodes = this.link.motionStats?.nodes; if (!Array.isArray(nodes)) return;
    for (const m of this.members) {
      if (m.id === this.id || m.departed || m.node == null || !nodes.find(n => n.node === m.node)?.dead) continue;
      m.departed = true; m.connection = 'stalled';
      this.logEvent('stalled', m.name, `car ${m.cabinet}`); this.onEvent({ kind: 'stalled', name: m.name, inGame: true });
      this.publish();
    }
  }
  ping() {
    this.checkStalled();
    if (this.isHost && this.swaps.some(o => o.until <= Date.now())) { this.swaps = this.swaps.filter(o => o.until > Date.now()); this.publish(); }
    if (this.isHost) for (const c of this.peers.keys()) this.send(c, { t: 'ping', ts: performance.now() });
    // Daytona USA Web's hot-departure policy: silence, ping, a stalled or hidden
    // tab never make a driver "left"; only a definitive WebRTC closure does
    // (connection 'closed' or 'failed', or the data channel closed). PeerJS can
    // take long to report it, so it is checked here every 2 s.
    const gone = c => ['closed', 'failed'].includes(c?.peerConnection?.connectionState) || c?.dataChannel?.readyState === 'closed';
    if (this.isHost) for (const c of [...this.peers.keys()]) if (gone(c)) { this.disconnected(c); try { c.close(); } catch {} }
    const hc = this.link.hostConn;
    if (!this.isHost && hc && ['pending', 'lobby', 'playing', 'waiting'].includes(this.phase) && gone(hc)) { this.disconnected(hc); try { hc.close(); } catch {} }
  }
  message(d, c) {
    if (!d || typeof d !== 'object') return;
    if (this.isHost) return this.command_(d, c);
    this.answered = true;
    if (d.t === 'ping') { this.send(c, { t: 'pong', ts: d.ts }); return; }
    if (d.t === 'refused') { this.refusal = d.reason; this.fail(d.reason); try { c.close(); } catch {} return; }
    if (d.t === 'welcome') { this.token = String(d.token || ''); return; }
    if (d.t === 'stop') { this.onStop('guest'); return; }
    if (d.t === 'order') { this.order = d.order; this.onOrder(d.order); return; }
    if (d.t === 'sync') {
      const s = d.state, me = s.members.find(m => m.id === this.id);
      const wasMember = this.members.some(m => m.id === this.id);
      Object.assign(this, { members: s.members, pending: s.pending, chat: s.chat, settings: cleanSettings(s.settings), code: s.code, hostId: s.host, roomName: cleanRoomName(s.roomName), reserved: s.reserved || [], swaps: Array.isArray(s.swaps) ? s.swaps : [], waiters: Array.isArray(s.waiters) ? s.waiters : [] });
      this.phase = me ? s.phase : (s.waiters || []).some(w => w.id === this.id) ? 'waiting' : s.pending.some(m => m.id === this.id) ? 'pending' : this.phase;
      if (d.ack && d.ack.command !== this.lastAck?.command) {
        this.lastAck = d.ack;
        if (d.ack.action === 'ready') this.readyPending = false;
        if (d.ack.action === 'move-seat') this.seatPending = 0;
        if (d.ack.action.startsWith('swap-')) this.swapPending = false;
      }
      if (me && !wasMember) this.onEvent({ kind: 'admitted', name: me.name });
      this.changed();
    }
  }
  // Host: one guest command.
  command_(d, c) {
    const info = this.peers.get(c); if (!info) return;
    if (d.t === 'pong') { const m = this.members.find(x => x.id === info.id); if (m) { const rtt = Math.round(performance.now() - d.ts); if (m.rtt === null || Math.abs(m.rtt - rtt) > 4) { m.rtt = rtt; this.publish(); } } return; }
    if (d.t === 'hello') {
      if (info.state !== 'new') return;
      info.name = cleanName(d.name);
      const back = this.phase === 'lobby' && d.token && this.reserved.find(r => r.token === d.token && r.until > Date.now());
      if (back && !this.members.some(m => m.cabinet === back.cabinet)) {
        this.reserved = this.reserved.filter(r => r !== back); info.state = 'member';
        this.members.push({ id: info.id, name: info.name, cabinet: back.cabinet, ready: false, connection: 'connected', rtt: null, token: back.token });
        this.send(c, { t: 'welcome', token: back.token }); this.onEvent({ kind: 'joined', name: info.name, inGame: false }); this.publish(); return;
      }
      if (!['lobby', 'playing'].includes(this.phase)) { this.send(c, { t: 'refused', reason: 'The room is not open.' }); return; }
      if (this.members.length + this.pending.length + this.waiters.length >= SEATS + 4) { this.send(c, { t: 'refused', reason: 'This room is full.' }); return; }
      info.state = 'pending'; this.pending.push({ id: info.id, name: info.name, connection: 'connected' });
      this.onEvent({ kind: 'request', name: info.name, inGame: this.phase === 'playing' });
      this.publish(); return;
    }
    const member = this.members.find(m => m.id === info.id);
    if (!member) return;
    if (d.t === 'ready') { const ok = this.phase === 'lobby'; if (ok) member.ready = !!d.value; this.ack(c, 'ready', ok, ok ? '' : 'The race has started.'); this.publish(); }
    else if (d.t === 'move') { const reason = this.seatError(member, d.seat); if (!reason) this.assignSeat(member, d.seat); this.ack(c, 'move-seat', !reason, reason); this.publish(); }
    else if (d.t === 'swap') { const reason = this.offerSwap(member, d.to); this.ack(c, 'swap-offer', !reason, reason); this.publish(); }
    else if (d.t === 'swap-answer') { const reason = this.settleSwap(member, d.from, !!d.accept); this.ack(c, 'swap-answer', !reason, reason); this.publish(); }
    else if (d.t === 'swap-cancel') { this.swaps = this.swaps.filter(o => o.from !== member.id); this.ack(c, 'swap-cancel', true); this.publish(); }
    else if (d.t === 'health') { if (d.health && typeof d.health === 'object') member.health = { ...d.health, receivedAt: Date.now() }; return; }
    else if (d.t === 'phase') { if (d.racing && !member.racing) this.newRace(); member.racing = !!d.racing; this.publish(); }
    else if (d.t === 'chat') { const reason = this.acceptChat(member, d.text); this.ack(c, 'chat-submit', !reason, reason); this.publish(); }
  }

  // ---- lobby actions -----------------------------------------------------------
  freeSeat() {
    this.reserved = this.reserved.filter(r => r.until > Date.now());
    for (let s = 1; s <= SEATS; s++) if (!this.members.some(m => m.cabinet === s) && !this.reserved.some(r => r.cabinet === s)) return s; return 0;
  }
  // ---- seat swaps (host decides; the two drivers exchange car numbers) --------
  swapFor(id) { return this.swaps.find(o => o.from === id || o.to === id) || null; }
  offerSwap(member, toId) {
    if (this.phase !== 'lobby') return 'Seats are fixed once the race starts.';
    const other = this.members.find(m => m.id === toId);
    if (!member || !other || other === member) return 'Choose another driver.';
    if (this.swapFor(member.id) || this.swapFor(other.id)) return 'A swap is already waiting for an answer.';
    this.swaps.push({ from: member.id, to: other.id, fromCabinet: member.cabinet, toCabinet: other.cabinet, until: Date.now() + 30000 });
    this.logEvent('swap-offer', member.name, `car ${member.cabinet} ↔ car ${other.cabinet}`); return '';
  }
  settleSwap(member, fromId, accept) {
    const o = this.swaps.find(x => x.from === fromId && x.to === member?.id); if (!o) return 'That swap request expired.';
    this.swaps = this.swaps.filter(x => x !== o);
    if (!accept) return '';
    const a = this.members.find(m => m.id === o.from), b = this.members.find(m => m.id === o.to);
    if (!a || !b || a.cabinet !== o.fromCabinet || b.cabinet !== o.toCabinet || this.phase !== 'lobby') return 'The seats changed before the swap.';
    [a.cabinet, b.cabinet] = [b.cabinet, a.cabinet]; a.ready = b.ready = false; return '';
  }
  requestSwap(toId) {
    if (this.isHost) { const r = this.offerSwap(this.members.find(m => m.id === this.id), toId); if (r) throw new Error(r); this.publish(); return true; }
    if (this.swapPending) return false; this.swapPending = true; this.send(this.link.hostConn, { t: 'swap', to: toId }); this.changed(); return true;
  }
  answerSwap(fromId, accept) {
    if (this.isHost) { const r = this.settleSwap(this.members.find(m => m.id === this.id), fromId, accept); this.publish(); if (r) throw new Error(r); return true; }
    this.swapPending = true; this.send(this.link.hostConn, { t: 'swap-answer', from: fromId, accept: !!accept }); this.changed(); return true;
  }
  cancelSwap() {
    if (this.isHost) { this.swaps = this.swaps.filter(o => o.from !== this.id); this.publish(); return true; }
    this.swapPending = true; this.send(this.link.hostConn, { t: 'swap-cancel' }); this.changed(); return true;
  }
  setRoomName(value) { if (!this.isHost) return; this.roomName = cleanRoomName(value); this.publish(); }
  approve(id) {
    if (this.isHost && this.phase === 'playing') {   // admitted during a game: waits for the next one
      const req = this.pending.find(m => m.id === id), c = this.connFor(id); if (!req || !c) return false;
      if (this.members.filter(m => !m.departed).length + this.waiters.length >= SEATS) { this.changed(); throw new Error(`All ${SEATS} cabinets are taken.`); }
      const t = token(); this.pending = this.pending.filter(m => m.id !== id); this.peers.get(c).state = 'waiter';
      this.waiters.push({ id, name: req.name, token: t }); this.send(c, { t: 'welcome', token: t });
      this.onEvent({ kind: 'waiting', name: req.name, inGame: true }); this.publish(); return true;
    }
    if (!this.isHost || this.phase !== 'lobby') return false;
    const req = this.pending.find(m => m.id === id), seat = this.freeSeat(), c = this.connFor(id);
    if (!req || !c) return false;
    if (!seat) { this.changed(); throw new Error(`All ${SEATS} cabinets are taken.`); }
    this.pending = this.pending.filter(m => m.id !== id); this.peers.get(c).state = 'member';
    const t = token(); this.members.push({ id, name: req.name, cabinet: seat, ready: false, connection: 'connected', rtt: null, token: t });
    this.send(c, { t: 'welcome', token: t });
    this.onEvent({ kind: 'joined', name: req.name, inGame: false });
    this.publish(); return true;
  }
  reject(id) { return this.drop(id, 'The host declined your request.'); }
  kick(id) { return id !== this.id && this.drop(id, 'The host removed you from the room.'); }
  drop(id, reason) {
    // During a game the host can still decline a join request (not remove a driver).
    if (!this.isHost || !(this.phase === 'lobby' || (this.phase === 'playing' && this.pending.some(m => m.id === id)))) return false;
    const c = this.connFor(id); if (!c) return false;
    this.send(c, { t: 'refused', reason }); this.peers.delete(c); setTimeout(() => { try { c.close(); } catch {} }, 300);
    this.pending = this.pending.filter(m => m.id !== id); this.members = this.members.filter(m => m.id !== id);
    this.publish(); return true;
  }
  ready(value) {
    if (this.phase !== 'lobby') return;
    if (this.isHost) { const me = this.members.find(m => m.id === this.id); if (me) me.ready = !!value; this.publish(); return; }
    this.readyPending = true; this.send(this.link.hostConn, { t: 'ready', value: !!value }); this.changed();
  }
  seatError(member, seat) {
    if (this.phase !== 'lobby') return 'Seats are fixed once the race starts.';
    if (!Number.isInteger(seat) || seat < 1 || seat > SEATS) return 'Choose an open seat.';
    if (this.members.some(m => m.cabinet === seat && m !== member)) return `Car ${seat} is taken.`;
    if (this.reserved.some(r => r.cabinet === seat && r.until > Date.now())) return `Car ${seat} is kept for a returning driver.`;
    return '';
  }
  assignSeat(member, seat) { member.cabinet = seat; member.ready = false; }
  moveSeat(seat) {
    const me = this.members.find(m => m.id === this.id); if (!me) return false;
    if (this.isHost) { if (this.seatError(me, seat)) return false; this.assignSeat(me, seat); this.publish(); return true; }
    if (this.seatPending || this.seatError(me, seat)) return false;
    this.seatPending = seat; this.send(this.link.hostConn, { t: 'move', seat }); this.changed(); return true;
  }
  setSettings(value) {
    if (!this.isHost || this.phase !== 'lobby') return;
    const next = cleanSettings(value, this.settings);
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.settings = next; for (const m of this.members) m.ready = false;   // changes reset Ready, as in Daytona USA Web
    this.publish();
  }
  chatAllowed(id) { return ['lobby', 'playing'].includes(this.phase) && this.members.some(m => m.id === id && !m.departed && !m.racing); }
  // A cabinet starts racing: the previous race's order (final or not) must not
  // show again, so the standings wait for this race's own order.
  newRace() { this.order = null; this.raceOrder.order = null; this.raceOrder.lastKey = ''; }
  racePhase(on) {
    if (on) this.newRace();
    if (this.isHost) { const me = this.members.find(m => m.id === this.id); if (me && me.racing !== on) { me.racing = on; this.publish(); } }
    else if (this.link.hostConn?.open) this.send(this.link.hostConn, { t: 'phase', racing: !!on });
    this.onOrder(this.order);   // the standings follow the race phase
    this.changed();
  }
  acceptChat(member, value) {
    const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_LIMIT);
    if (!text) return 'Type a message first.';
    if (member.racing) return 'Chat is paused during the race. It returns in attract mode.';
    const now = Date.now();
    if (now - (member.lastChat || 0) < CHAT_INTERVAL_MS) return 'Wait a moment before sending another message.';
    member.lastChat = now;
    this.chat.push({ seq: ++this.seq, sender: member.id, name: member.name, text, time: now });
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    return '';
  }
  submitChat(value) {
    if (!this.chatAllowed(this.id)) throw new Error(this.members.find(m => m.id === this.id)?.racing ? 'Chat is paused during the race. It returns in attract mode.' : 'Chat opens after the host admits you.');
    if (!String(value || '').trim()) return false;
    if (this.isHost) { const reason = this.acceptChat(this.members.find(m => m.id === this.id), value); if (reason) throw new Error(reason); this.publish(); return true; }
    const now = Date.now(); if (now - this.lastChat < CHAT_INTERVAL_MS) throw new Error('Wait a moment before sending another message.');
    this.lastChat = now; this.send(this.link.hostConn, { t: 'chat', text: String(value).slice(0, CHAT_LIMIT) }); return true;
  }
  canStart() {
    return this.isHost && this.phase === 'lobby' && this.members.length >= 2 && !this.pending.length && this.members.every(m => m.ready && m.connection === 'connected');
  }
  async start() {
    if (!this.isHost || this.phase !== 'lobby') return;
    if (this.members.length < 2) throw new Error('A linked race needs at least two cabinets.');
    if (this.pending.length) throw new Error('Admit or decline the join requests first.');
    if (!this.members.every(m => m.ready)) throw new Error('Every driver must be Ready.');
    const guests = this.members.filter(m => m.id !== this.id).sort((a, b) => a.cabinet - b.cabinet);
    const conns = guests.map(m => this.connFor(m.id));
    if (conns.some(c => !c?.open)) throw new Error('A driver is reconnecting. Try again in a moment.');
    // Link nodes: the host is 0, the guests follow in seat order (central-link-net startSession).
    this.members.find(m => m.id === this.id).node = 0; guests.forEach((m, i) => { m.node = i + 1; });
    this.raceOrder.reset(); this.order = null;
    this.phase = 'playing'; this.logEvent('race-start', '', `${this.members.length} cabinets`); this.publish();
    const car = c => ({ car: c ? guests[conns.indexOf(c)].cabinet : this.members.find(m => m.id === this.id).cabinet });
    this.link.startSession(conns, car, { race: { ...this.settings } });
  }
  started(session) {
    if (!this.isHost) this.phase = 'playing';
    this.changed();
    this.onStart({ nodes: session.nodes, node: session.node, car: session.car, race: cleanSettings(session.race) });
  }
}
