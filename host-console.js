// Host connection console (Claude 2026-11-12), after Daytona USA Web's
// host-console.js: same markup and styles (css/host-console.css), fed by the
// D2 room (room.js) and the asynchronous central link (central-link-net.js).
// Players: per cabinet the host's own observations (RTT, time since its last
// car record, records lost on the way to the host) and what the cabinet
// reports every 2 s (simulation rate, tab visibility, how it sees the host:
// loss, playout buffer, prediction). Events: the room log.
const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
const ms = v => Number.isFinite(v) ? v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s` : '—';
const pct = v => Number.isFinite(v) ? `${(v * 100).toFixed(v < .1 ? 1 : 0)}%` : '—';
const hz = v => Number.isFinite(v) ? `${v.toFixed(1)} Hz` : '—';
const fields = v => Number.isFinite(v) ? `${v.toFixed(1)} fields (${Math.round(v * 1000 / 60)} ms)` : '—';
const EVENTS = { request: 'Join request', joined: 'Driver joined', admitted: 'Admitted', left: 'Driver left', 'race-start': 'Linked game started', 'race-stop': 'Returned to the room', silent: 'Cabinet silent', 'swap-offer': 'Seat swap offered' };

function classify(row, playing) {
  if (row.self) return { level: 'ok', label: 'Host', detail: 'This cabinet relays every car to the room.' };
  if (row.departed) return { level: 'muted', label: 'Left', detail: 'The cabinet left the game; the others continue without it.' };
  if (row.connection !== 'connected') return { level: 'bad', label: 'Disconnected', detail: 'The connection to this cabinet closed.' };
  if (playing && Number.isFinite(row.ageMs) && row.ageMs > 1500) return { level: 'bad', label: 'No updates', detail: 'No car record from this cabinet for over 1.5 s. Its car is held at its last position.' };
  if (row.health && row.health.visible === false) return { level: 'warn', label: 'Tab hidden', detail: 'The browser may slow a hidden tab; that driver’s car can stall for the others.' };
  if (playing && Number.isFinite(row.health?.hz) && row.health.hz < 52) return { level: 'warn', label: 'Slow simulation', detail: 'This cabinet runs below 52 fields/s.' };
  const loss = Math.max(row.lossUp ?? 0, row.lossDown ?? 0);
  if (loss > .1 || (row.rtt ?? 0) > 250) return { level: 'warn', label: 'Weak link', detail: 'High loss or round trip; the playout and prediction hide it up to a point.' };
  return { level: 'ok', label: 'Good', detail: 'Steady link.' };
}

export function mountHostConsole(room, { link, open: openPanel = () => {}, close: closePanel = () => {} }) {
  const panel = $('hostConsole'), tabs = [$('connectionPlayersTab'), $('connectionEventsTab')], rows = new Map();
  let timer = null;
  function select(tab) { for (const t of tabs) { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; $(t.getAttribute('aria-controls')).hidden = !on; } }
  for (const tab of tabs) tab.onclick = () => select(tab);
  function rowElement() {
    const tr = node('tr'), detail = node('tr', undefined, 'connection-detail'), cell = node('td'); cell.colSpan = 6; detail.append(cell); detail.hidden = true;
    const button = node('button', undefined, 'connection-driver'); button.type = 'button'; button.setAttribute('aria-expanded', 'false');
    button.onclick = () => { detail.hidden = !detail.hidden; button.setAttribute('aria-expanded', String(!detail.hidden)); };
    const name = node('strong'), seat = node('small'); button.append(name, seat); const first = node('td'); first.append(button); tr.append(first);
    const values = ['Connection', 'RTT', 'SIM', 'Game update age', 'Loss'].map(label => { const td = node('td'); td.dataset.label = label; tr.append(td); return td; });
    const status = node('span', undefined, 'connection-badge'); values[0].append(status);
    const list = node('dl', undefined, 'connection-detail-list'); cell.append(list); const details = new Map();
    const value = (label, text) => { let dd = details.get(label); if (!dd) { const pair = node('div'); dd = node('dd'); pair.append(node('dt', label), dd); list.append(pair); details.set(label, dd); } dd.textContent = text; };
    return { tr, detail, name, seat, values, status, value };
  }
  function report() {
    const state = room.snapshot(), now = performance.now(), playing = state.phase === 'playing';
    const order = state.members.slice().sort((a, b) => a.cabinet - b.cabinet), guests = order.filter(m => m.id !== state.id);
    // Node numbers follow seat order among the guests (room.start), the host is node 0.
    const nodeOf = m => m.id === state.id ? 0 : 1 + guests.indexOf(m);
    return { generatedAt: new Date().toISOString(), phase: state.phase, code: state.code, roomName: state.roomName,
      rows: order.map(m => {
        const n = nodeOf(m), self = m.id === state.id, h = m.health || null;
        return { self, name: m.name, cabinet: m.cabinet, node: n, connection: m.connection, departed: !!m.departed, racing: !!m.racing,
          rtt: self ? null : (link.rtt?.[n] ?? m.rtt ?? null), ageMs: !self && playing && link.lastRecordAt?.[n] ? now - link.lastRecordAt[n] : null,
          lossUp: self || !playing ? null : link.lossOf?.(n) ?? null, lossDown: h?.loss ?? null, health: h,
          hostView: self ? null : link.motionStats?.nodes?.[n] || null };
      }), events: room.events.slice(), link: { sent: link.motionSent, dropped: link.motionDropped, received: link.motionReceived, reliable: link.reliableRecords } };
  }
  function render() {
    const r = report(), playing = r.phase === 'playing', ids = new Set();
    $('hostConsoleState').textContent = playing ? 'In game' : r.phase === 'lobby' ? 'Room' : r.phase;
    const bad = r.rows.filter(x => classify(x, playing).level !== 'ok').length;
    $('hostConsoleSummary').textContent = `${r.rows.length} cabinet${r.rows.length === 1 ? '' : 's'} · ${bad ? `${bad} need attention` : 'all links steady'} · car records go peer to peer through this host, unordered and never resent.`;
    for (const row of r.rows) {
      const key = row.name + '#' + row.cabinet; ids.add(key); let v = rows.get(key);
      if (!v) { v = rowElement(); rows.set(key, v); $('connectionRows').append(v.tr, v.detail); }
      const c = classify(row, playing);
      v.name.textContent = row.name; v.seat.textContent = `${String(row.cabinet).padStart(2, '0')} · ${row.self ? 'You / host' : 'Cabinet'}${row.racing ? ' · racing' : ''}`;
      v.tr.dataset.level = c.level; v.status.dataset.level = c.level; v.status.textContent = c.label; v.status.title = c.detail;
      v.values[1].textContent = row.self ? 'Local' : ms(row.rtt);
      v.values[2].textContent = hz(row.health?.hz);
      v.values[3].textContent = row.self ? 'Local' : ms(row.ageMs);
      v.values[4].textContent = row.self ? '—' : `${pct(row.lossUp)} ↑ · ${pct(row.lossDown)} ↓`;
      v.value('Observation', c.detail);
      v.value('Tab', row.health ? row.health.visible === false ? 'Hidden' : 'Visible' : '—');
      v.value('Records lost · to host / from host', row.self ? '—' : `${pct(row.lossUp)} / ${pct(row.lossDown)}`);
      const hv = row.hostView, gv = row.health?.motion;
      v.value('Host shows this car · buffer', hv ? fields(hv.delay) : '—');
      v.value('Host shows this car · prediction', hv ? fields(hv.lead) : '—');
      v.value('Host shows this car · late / held fields', hv ? `${hv.late} / ${hv.held}` : '—');
      v.value('This cabinet shows the host · buffer', gv ? fields(gv.delay) : '—');
      v.value('This cabinet shows the host · prediction', gv ? fields(gv.lead) : '—');
      v.value('Arrival jitter (host view)', hv ? fields(hv.jitter) : '—');
      v.value('Status report age', row.health?.at ? ms(Date.now() - row.health.at) : '—');
    }
    for (const [key, v] of rows) if (!ids.has(key)) { v.tr.remove(); v.detail.remove(); rows.delete(key); }
    $('connectionRowsEmpty').hidden = r.rows.length > 0; $('connectionPlayerCount').textContent = String(r.rows.length);
    const list = $('connectionEvents'); list.replaceChildren();
    for (const e of r.events.slice().reverse()) {
      const li = node('li'), head = node('div', undefined, 'connection-event-heading'), t = node('time', new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      head.append(t, node('strong', (EVENTS[e.kind] || e.kind) + (e.name ? ` · ${e.name}` : ''))); li.append(head); if (e.detail) li.append(node('p', e.detail)); list.append(li);
    }
    $('connectionEventsEmpty').hidden = r.events.length > 0; $('connectionEventCount').textContent = String(r.events.length);
  }
  function show() { panel.hidden = false; openPanel(); render(); clearInterval(timer); timer = setInterval(render, 1000); $('hostConsoleBack').focus(); }
  function hide() { panel.hidden = true; clearInterval(timer); timer = null; closePanel(); }
  $('hostConsoleBtn').onclick = show; $('hostConsoleBack').onclick = hide;
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); hide(); } });
  $('hostConsoleExport').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' })), a = node('a');
    a.href = url; a.download = `daytona2-room-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return { render: state => { $('hostConsoleBtn').hidden = !(state.isHost && ['lobby', 'playing'].includes(state.phase)); if (!panel.hidden) render(); }, hide };
}
