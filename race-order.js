// Authoritative race order for the linked game (Claude 2026-11-12), after
// Daytona USA Web's race authority (race-authority.js, common_race_order.h):
// every cabinet's game ranks the cars from what it sees, and with network
// delay and prediction each one may see a different order. The host compares
// the genuine progress each cabinet published for itself at one common past
// instant (never arrival order, never predicted positions) and shares it.
//
// D2 link block (src/comm/central_motion.h): 14 field counter, 50 race time
// left (fields; jumps up at the line as time is extended, master only), 162
// the car's own track progress (segments, cumulative over laps, negative
// behind the line; 54 holds the same on the master only), 108/112 position.
// Phases (timeline_*.json, 2026-11-12): byte 19 is set from car selection
// until the game returns to attract; byte 211 is 1 while the cars race and
// drops when the race ends for that cabinet (seen at time over on every
// cabinet), but the game only ends the race once every car has finished: the
// car's own finish is byte 10 & 0x20, set when it completes the last lap (167
// counts the laps). Timelines of full 8-lap races, 2026-11-12.
const FIELD_MS = 1000 / 60;
const i16 = (b, o) => { const v = (b[o] << 8) | b[o + 1]; return v & 0x8000 ? v - 0x10000 : v; };
const f32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false);

class NodeTrack {
  constructor() { this.points = []; this.offsets = []; this.base = Infinity; this.finish = null; this.lastProgress = null; this.changedAt = null; this.ended = null; this.raced = false; this.inGame = false; }
  restart() { this.points = []; this.ended = null; this.raced = false; this.lastProgress = null; this.changedAt = null; }
  // Arrival time against the source field clock: the minimum over 2 s is the transit floor.
  add(seq, block, arrived, transitMs) {
    const off = arrived - seq * FIELD_MS; this.offsets.push([arrived, off]);
    while (this.offsets.length && arrived - this.offsets[0][0] > 2000) this.offsets.shift();
    this.base = Math.min(...this.offsets.map(o => o[1]));
    const at = seq * FIELD_MS + this.base - transitMs;   // when the source cabinet produced it, host clock
    const segment = i16(block, 162), x = f32(block, 108), z = f32(block, 112), timeLeft = i16(block, 50);
    const inGame = block[19] !== 0 && Number.isFinite(x) && Number.isFinite(z) && Math.abs(x) + Math.abs(z) > 1;
    if (inGame && !this.inGame && (this.ended || this.raced)) this.restart();   // a new race in the same session
    this.inGame = inGame; if (!inGame) return;   // attract or selection: not on track
    const racing = block[211] === 1, finished = (block[10] & 0x20) !== 0;
    if (racing) this.raced = true;
    // The car crossed the line (its finish instant decides the winner), or the race ended (time over).
    if (this.raced && !this.ended && (finished || !racing)) { const last = this.points.at(-1); if (last) this.ended = { at: last.at, progress: this.progressAt(last.at), finished }; }
    if (this.ended) return;
    // Fractional progress: the segment counter is coarse (~8 fields), so place
    // the car between its last two segment changes in time.
    if (this.lastProgress !== segment) { this.changedAt = at; this.lastProgress = segment; }
    const last = this.points.at(-1);
    if (last && at <= last.at) return;
    this.points.push({ at, seq, segment, timeLeft, changedAt: this.changedAt });
    while (this.points.length > 600) this.points.shift();
  }
  progressAt(t) {
    const p = this.points; if (!p.length || t < p[0].at) return null;
    let k = p.length - 1; while (k > 0 && p[k].at > t) k--;
    const cur = p[k]; let next = null; for (let i = k + 1; i < p.length; i++) if (p[i].segment !== cur.segment) { next = p[i]; break; }
    // Between segment changes progress grows linearly in time.
    if (next && next.changedAt > cur.changedAt) return cur.segment + Math.min(1, (t - cur.changedAt) / (next.changedAt - cur.changedAt)) * (next.segment - cur.segment);
    return cur.segment;
  }
}

export class RaceOrder {
  constructor() { this.reset(); }
  reset() { this.tracks = new Map(); this.revision = 0; this.order = null; this.lastKey = ''; }
  record(node, seq, block, arrived, transitMs = 0) {
    let t = this.tracks.get(node); if (!t) { t = new NodeTrack(); this.tracks.set(node, t); }
    t.add(seq, block, arrived, transitMs);
  }
  // nodes: the racing cabinets; departed: cabinets that dropped out mid-race, which
  // keep their place with the progress they last had (shown faded, as in Daytona USA Web).
  // Returns the order at the latest instant every racing cabinet has reached.
  lastProgress(n) { const t = this.tracks.get(n); if (!t?.points.length) return null; return t.ended ? t.ended.progress : t.progressAt(t.points.at(-1).at); }
  withDeparted(rows, departed) {
    for (const n of departed) { const p = this.lastProgress(n); if (p !== null && !rows.some(r => r.node === n)) rows.push({ node: n, progress: p, departed: true }); }
    return rows;
  }
  compute(nodes, now = performance.now(), departed = []) {
    this.departed = departed;
    const tracked = nodes.map(n => [n, this.tracks.get(n)]).filter(([, t]) => t?.points.length);
    const over = tracked.length >= 1 && tracked.length + departed.length >= 2 && tracked.every(([, t]) => t.ended);
    if (this.order?.final) { if (over || !tracked.length) return this.order; this.order = null; this.lastKey = ''; }   // next race
    if (over) return this.finalOrder(tracked);
    const live = nodes.filter(n => this.tracks.get(n)?.points.length && now - this.tracks.get(n).points.at(-1).at < 3000);
    if (!live.length || live.length + departed.length < 2) return this.order;
    const common = Math.min(...live.map(n => { const t = this.tracks.get(n); return t.ended ? Infinity : t.points.at(-1).at; }));
    if (!Number.isFinite(common)) return this.order;
    // A cabinet whose race is over keeps the progress it ended with.
    // A cabinet that stopped sending (before the room marks it departed) keeps its last place too.
    const quiet = nodes.filter(n => !live.includes(n) && this.tracks.get(n)?.points.length && !this.tracks.get(n).ended);
    const rows = this.withDeparted(live.map(n => { const t = this.tracks.get(n); return { node: n, progress: t.ended && t.ended.at <= common ? t.ended.progress : t.progressAt(common) }; }).filter(r => r.progress !== null), [...quiet, ...departed]);
    if (rows.length < 2) return this.order;
    rows.sort((a, b) => b.progress - a.progress || a.node - b.node);
    rows.forEach((r, i) => { r.position = i + 1; r.gap = i ? rows[0].progress - r.progress : 0; });
    const key = rows.map(r => r.node + (r.departed ? 'x' : '')).join(',');
    if (key !== this.lastKey) { this.lastKey = key; this.revision++; }
    this.order = { revision: this.revision, at: common, rows: rows.map(({ node, position, progress, gap, departed }) => ({ node, position, progress: Math.round(progress * 100) / 100, gap: Math.round(gap * 100) / 100, ...(departed ? { departed } : {}) })) };
    return this.order;
  }
  // Every cabinet's race is over. Fixed once given.
  finalOrder(tracked) {
    // Cars that crossed the line rank by when they did; the rest (time over) by how far they got.
    const rows = tracked.map(([node, t]) => ({ node, progress: t.ended.progress ?? -Infinity, endedAt: t.ended.at, finished: !!t.ended.finished }));
    rows.sort((a, b) => (b.finished - a.finished) || (a.finished ? a.endedAt - b.endedAt : b.progress - a.progress) || a.node - b.node);
    // Cabinets that dropped out come after every one that finished.
    const gone = this.withDeparted([], this.departed || []).sort((a, b) => b.progress - a.progress);
    rows.push(...gone);
    rows.forEach((r, i) => { r.position = i + 1; });
    this.revision++;
    this.order = { revision: this.revision, final: true, rows: rows.map(({ node, position, progress, departed }) => ({ node, position, progress: Math.round(progress * 100) / 100, ...(departed ? { departed } : {}) })) };
    return this.order;
  }
}
