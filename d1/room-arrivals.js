// Room arrivals for Daytona USA 2 (Claude 2026-11-12), after Daytona USA Web's
// room-arrivals.js (53.8.57). It observes the validated room snapshots, never
// raw PeerJS packets, so every cabinet (not only the host) learns who joined,
// asked to join (host only), queued for the next race, left or stopped
// responding. D2 rooms are private and have no spectators. Drivers who come
// back to their reserved seat after the page restart between races are
// returns, not arrivals, and make no alert.
export const arrivalRoomKey = s => s?.host && s?.id && s?.code ? `${s.host}:${s.id}:${s.code}` : '';
const label = (value, max) => String(value || '').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, max);

export function createRoomArrivals({ notify = () => {} } = {}) {
  let key = '', baseline = false, muted = false, present = new Map(), reserved = new Set();
  const seen = new Map();
  function reset() { baseline = false; seen.clear(); present.clear(); reserved.clear(); }
  return {
    // Silences alerts while this page is about to restart (end of a linked game).
    mute(on = true) { muted = on; },
    update(state) {
      const next = arrivalRoomKey(state);
      if (next !== key || state.phase === 'idle') { key = next; reset(); }
      if (!key || !['lobby', 'waiting', 'playing'].includes(state.phase)) return;
      // Only a roster that holds this cabinet establishes membership.
      if (![...(state.members || []), ...(state.waiters || [])].some(p => p.id === state.id)) return;
      const inGame = state.phase !== 'lobby', people = new Map();
      if (state.isHost) for (const p of state.pending || []) people.set(p.id, { person: p, stage: 'request' });
      for (const p of state.waiters || []) people.set(p.id, { person: p, stage: 'waiting' });
      for (const p of state.members || []) people.set(p.id, { person: p, stage: p.departed ? (p.connection === 'stalled' ? 'stalled' : 'left') : 'joined' });
      const emit = (kind, id, person) => {
        if (baseline && !muted) notify({ kind, id, name: label(person.name, 24) || 'Driver', cabinet: person.cabinet || 0, inGame, isHost: !!state.isHost, roomName: label(state.roomName, 48), roomKey: key });
      };
      for (const [id, { person, stage }] of people) {
        if (!id || id === state.id) continue;
        const prev = present.get(id);
        let record = seen.get(id); if (!record) { record = {}; seen.set(id, record); }
        if (stage === 'left' || stage === 'stalled') { if (prev?.stage === 'joined') emit(stage, id, person); continue; }
        if (record[stage]) continue;
        record[stage] = true;
        if (stage === 'joined' && (prev?.stage === 'joined' || reserved.has(person.cabinet))) continue;   // a return to a reserved seat
        emit(stage, id, person);
      }
      // Gone from the roster (lobby departures and removals); a request that was
      // declined or withdrawn is silent.
      for (const [id, { person, stage }] of present) if (id !== state.id && stage === 'joined' && !people.has(id)) emit('left', id, person);
      reserved = new Set((state.reserved || []).map(r => r.cabinet));
      present = new Map([...people].map(([id, p]) => [id, { stage: p.stage, person: { ...p.person } }]));
      baseline = true;
      while (seen.size > 256) seen.delete(seen.keys().next().value);
    },
    dispose() { reset(); key = ''; },
  };
}
