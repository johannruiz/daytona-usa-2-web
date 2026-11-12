// Private room interface for Daytona USA 2 web (Claude 2026-11-11), adapted
// from Daytona USA Web's room-ui.js: the same markup and behaviour for the
// starting grid (car-colour seat cards, open seats to move to, Ready, kick),
// join requests the host admits or declines, the invitation popover (link and
// code), the shared race settings (D2's mode, difficulty, announcer and laps),
// the lobby chat with unread badges and mobile ROOM / CHAT tabs, and the
// in-race arrival toasts. Public rooms are not part of this port yet.
import { mountRoomInvitation } from './d1/room-invitation.js';
import { createChatFollow } from './d1/chat-follow.js';
import { carColor } from './d1/car-colors.js';
import { createLobbyNotifications } from './d1/lobby-notifications.js';
import { SEATS, parseInvitation } from './room.js';

const $ = id => document.getElementById(id);
const SETTING_IDS = { mode: 'roomMode', difficulty: 'roomDifficulty', voice: 'roomVoice', lapsBeginner: 'roomLapsBeginner', lapsAdvanced: 'roomLapsAdvanced', lapsExpert: 'roomLapsExpert', playerCollision: 'roomCollision' };
export const invitationFromURL = href => new URLSearchParams(new URL(href).hash.slice(1)).get('room') || '';

export function createRoomUI(room, { show, gameRunning = () => false, unlockAudio = () => {}, sound = () => {} }) {
  const panel = $('roomPanel');
  const invitationMenu = mountRoomInvitation({ container: $('roomInvite'), trigger: $('inviteRoom'), content: $('inviteBlock'), closeButton: $('closeInvite'), initialFocus: $('copyRoom') });
  const notifications = createLobbyNotifications({ notifyChat: () => sound('chat'), notifyReady: () => sound('ready'), notifyConfirmed: () => sound('confirmed') });
  const cards = new Map(), emptySeats = new Map(), messages = new Map();
  let roomKey = '', pendingStamp = '', unread = 0, lastChatSeq = 0, lastAckCommand = 0, lastSeatAck = 0, previousSeat = null, lastPhase = '', toastTimer = 0;
  for (const sel of panel.querySelectorAll('[data-laps]')) { const [lo, hi] = sel.dataset.laps.split('-').map(Number); for (let n = lo; n <= hi; n++) sel.add(new Option(`${n} laps`, String(n))); }

  // ---- entry ------------------------------------------------------------------
  const driverName = () => ($('driverName').value.trim() || 'Driver').slice(0, 24);
  try { const name = localStorage.getItem('daytona-driver-name-v1'); if (name) $('driverName').value = name.slice(0, 24); } catch {}
  const rememberName = () => { try { localStorage.setItem('daytona-driver-name-v1', driverName()); } catch {} };
  $('driverName').addEventListener('change', rememberName);
  function hint() {
    const code = $('joinCode').value.trim(); let valid = false; try { parseInvitation(code); valid = true; } catch {}
    $('joinCard').classList.toggle('has-invitation', valid);
    $('invitationHint').textContent = valid ? (code === invitationFromURL(location.href) ? 'Invitation loaded. Enter your name and join.' : 'Invitation ready. Your host approves the request.') : code ? 'Paste a complete invitation link or room code.' : 'Your host will approve your request.';
  }
  function setURL(code) { const url = new URL(location.href), hash = new URLSearchParams(url.hash.slice(1)); if (code) hash.set('room', code); else hash.delete('room'); url.hash = hash.toString(); history.replaceState(history.state, '', url.href); }
  $('joinCode').value = invitationFromURL(location.href); hint();
  $('joinCode').addEventListener('input', hint);
  let busy = false;
  const entryAction = fn => async () => {
    if (busy) return; busy = true; $('createRoom').disabled = $('joinRoom').disabled = true; $('entryStatus').textContent = '';
    try { await fn(); } catch (e) { $('entryStatus').textContent = e.message; if (room.phase === 'error' || room.phase === 'idle') show('entry'); }
    finally { busy = false; $('createRoom').disabled = $('joinRoom').disabled = false; }
  };
  $('createRoom').onclick = entryAction(async () => { void unlockAudio(); rememberName(); show('room'); await room.create(driverName(), { roomName: $('publicRoomName')?.value || '' }); setURL(room.code); });
  $('joinRoom').onclick = entryAction(async () => { void unlockAudio(); rememberName(); const code = parseInvitation($('joinCode').value); setURL(code); show('room'); await room.join(code, driverName()); });

  // ---- room actions -------------------------------------------------------------
  const action = fn => async () => { try { await fn(); } catch (e) { $('roomMessage').textContent = e.message; } };
  $('readyRoom').onclick = () => { void unlockAudio(); const me = room.members.find(m => m.id === room.id); room.ready(!me?.ready); };
  $('startRoom').onclick = action(async () => { void unlockAudio(); await room.start(); });
  $('seatSwapAccept').onclick = () => { const o = room.swapFor(room.id); if (o) room.answerSwap(o.from, true); };
  $('seatSwapDecline').onclick = () => { const o = room.swapFor(room.id); if (o) room.answerSwap(o.from, false); };
  $('seatSwapCancel').onclick = () => room.cancelSwap();
  async function copy(value, message) {
    try { await navigator.clipboard.writeText(value); $('inviteFeedback').dataset.state = 'success'; $('inviteFeedback').textContent = message; }
    catch { $('inviteFeedback').dataset.state = 'error'; $('inviteFeedback').textContent = 'Could not copy automatically. Select the link and copy it manually.'; }
  }
  $('copyRoom').onclick = () => copy($('inviteLink').value, 'Link copied. Share it with your friends.');
  $('copyCode').onclick = () => copy($('roomCode').textContent, 'Room code copied.');
  $('inviteLink').onclick = e => e.target.select();
  const pages = [['raceSetupPage', 'Race setup'], ['raceLapsPage', 'Laps']]; let page = 0;
  function turnPage(d) {
    page = (page + d + pages.length) % pages.length; pages.forEach(([id], i) => { $(id).hidden = i !== page; });
    const title = $('racePageTitle'); title.replaceChildren(document.createTextNode(pages[page][1] + ' '));
    const count = document.createElement('small'); count.textContent = `${page + 1} / ${pages.length}`; title.append(count);
  }
  $('racePagePrevious').onclick = () => turnPage(-1); $('racePageNext').onclick = () => turnPage(1);
  const change = () => { const s = {}; for (const [k, id] of Object.entries(SETTING_IDS)) s[k] = Number($(id).value); room.setSettings(s); };
  for (const id of Object.values(SETTING_IDS)) $(id).onchange = change;

  // ---- chat ------------------------------------------------------------------------
  function markRead() { unread = 0; for (const id of ['chatUnread', 'mobileChatUnread']) $(id).hidden = true; $('newChatMessages').hidden = true; }
  const chatFollow = createChatFollow($('chatLog'), { onBottom: () => { if (!document.hidden && $('chatLog').getClientRects().length) markRead(); } });
  const scrollChat = () => { chatFollow.latest(); markRead(); };
  function mobileTab(tab) {
    panel.dataset.mobileTab = tab;
    for (const [id, name] of [['roomGridTab', 'grid'], ['roomChatTab', 'chat']]) { $(id).setAttribute('aria-selected', String(tab === name)); $(id).tabIndex = tab === name ? 0 : -1; }
    if (tab === 'chat') chatFollow.refresh();
  }
  $('roomGridTab').onclick = () => mobileTab('grid'); $('roomChatTab').onclick = () => mobileTab('chat');
  $('newChatMessages').onclick = scrollChat;
  $('chatInput').addEventListener('input', () => { $('chatLength').textContent = `${$('chatInput').value.length}/240`; $('chatSend').disabled = !room.chatAllowed(room.id) || !$('chatInput').value.trim(); });
  $('chatForm').addEventListener('submit', e => {
    e.preventDefault(); void unlockAudio();
    try { if (room.submitChat($('chatInput').value)) { $('chatInput').value = ''; $('chatLength').textContent = '0/240'; $('chatSend').disabled = true; $('chatFeedback').textContent = room.isHost ? 'Message sent.' : 'Sending…'; scrollChat(); $('chatInput').focus(); } }
    catch (err) { $('chatFeedback').textContent = err.message; }
  });
  function renderChat(state) {
    const log = $('chatLog'), chat = state.chat || [], wanted = new Set(chat.map(m => m.seq));
    for (const [seq, node] of messages) if (!wanted.has(seq)) { node.remove(); messages.delete(seq); }
    let added = 0, own = false;
    for (const m of chat) {
      if (messages.has(m.seq)) continue;
      const li = document.createElement('li'), header = document.createElement('div'), name = document.createElement('strong'), time = document.createElement('time'), text = document.createElement('p');
      li.className = `chat-message${m.sender === state.id ? ' own-message' : ''}`; name.textContent = m.sender === state.id ? 'You' : m.name;
      time.dateTime = new Date(m.time).toISOString(); time.textContent = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      header.append(name, time); text.textContent = m.text; li.append(header, text); log.append(li); messages.set(m.seq, li);
      if (m.seq > lastChatSeq) { added++; own ||= m.sender === state.id; } lastChatSeq = Math.max(lastChatSeq, m.seq);
    }
    $('chatEmpty').hidden = chat.length > 0;
    if (added) { if (own) scrollChat(); else { unread += added; chatFollow.refresh(); for (const id of ['chatUnread', 'mobileChatUnread']) { $(id).hidden = false; $(id).textContent = String(unread); } } }
    $('newChatMessages').hidden = !unread || chatFollow.following;
    const enabled = room.chatAllowed(state.id);
    $('chatInput').disabled = !enabled; $('chatSend').disabled = !enabled || !$('chatInput').value.trim();
    if (!enabled) $('chatFeedback').textContent = state.phase === 'pending' ? 'Chat opens after the host admits you.' : 'Only players in this room can read this chat.';
    else if (state.lastAck?.action === 'chat-submit' && state.lastAck.command > lastAckCommand) { lastAckCommand = state.lastAck.command; $('chatFeedback').textContent = state.lastAck.accepted ? 'Confirmed by host.' : state.lastAck.reason; }
    else if (!['Message sent.', 'Sending…', 'Confirmed by host.', 'Wait a moment before sending another message.'].includes($('chatFeedback').textContent)) $('chatFeedback').textContent = 'Only players in this room can read this chat.';
  }

  // ---- starting grid ----------------------------------------------------------------
  function renderRoster(state) {
    const list = $('playersList'), me = state.members.find(m => m.id === state.id), wanted = new Set(state.members.map(m => m.id));
    for (const [id, card] of cards) if (!wanted.has(id)) { card.li.remove(); cards.delete(id); }
    const showSeats = state.phase === 'lobby' && !!me, occupied = new Set(state.members.map(m => m.cabinet));
    for (const [seat, node] of emptySeats) if (!showSeats || occupied.has(seat)) { node.remove(); emptySeats.delete(seat); }
    const nodes = new Map();
    for (const m of state.members) {
      let c = cards.get(m.id);
      if (!c) {
        const li = document.createElement('li'), number = document.createElement('span'), info = document.createElement('div'), name = document.createElement('strong'), role = document.createElement('small'), status = document.createElement('span'), remove = document.createElement('button');
        li.className = 'driver-card'; number.className = 'cabinet-number'; info.className = 'driver-info'; status.className = 'driver-status';
        remove.type = 'button'; remove.className = 'remove-driver'; remove.textContent = '×'; remove.onclick = () => { if (room.kick(m.id)) $('readyRoom').focus(); };
        info.append(name, role); li.append(number, info, status, remove); c = { li, number, name, role, status, remove }; cards.set(m.id, c);
        // Another driver's card offers a seat swap in the room (Daytona USA Web).
        info.addEventListener('click', () => { const s = room.snapshot(); if (s.phase !== 'lobby' || m.id === s.id || room.swapFor(s.id)) return; try { if (room.requestSwap(m.id)) $('seatStatus').textContent = `Swap offered to ${m.name}…`; } catch (e) { $('seatStatus').textContent = e.message; } });
      }
      const color = carColor(m.cabinet), stalled = m.connection === 'stalled', left = m.connection === 'left' || stalled;
      c.li.style.setProperty('--car-color', color.color); c.number.title = `Car ${m.cabinet} · ${color.name}`;
      c.li.dataset.seat = m.cabinet; c.li.classList.toggle('own-seat', m.id === state.id);
      c.li.classList.toggle('driver-ready', m.ready && state.phase === 'lobby'); c.li.classList.toggle('driver-in-game', state.phase === 'playing' && !left);
      c.number.textContent = String(m.cabinet).padStart(2, '0'); c.name.textContent = m.name; c.name.title = m.name;
      c.role.textContent = `${m.id === state.id ? 'You · ' : ''}${stalled ? 'Out of this race' : left ? 'Left race' : m.id === state.host ? 'Host · Master cabinet' : 'Driver'}${m.rtt == null ? '' : ' · ' + m.rtt + ' ms'}`;
      c.role.title = m.rtt == null ? '' : `Connection round-trip estimate: ${m.rtt} ms`;
      c.status.textContent = stalled ? 'OUT' : left ? 'LEFT' : state.phase === 'playing' ? 'IN GAME' : m.ready ? 'READY' : 'WAIT';
      c.remove.hidden = !state.isHost || state.phase !== 'lobby' || m.id === state.id; c.remove.title = `Remove ${m.name}`; c.remove.setAttribute('aria-label', `Remove ${m.name} from the room`);
      nodes.set(m.cabinet, c.li);
    }
    if (showSeats) for (let seat = 1; seat <= SEATS; seat++) if (!occupied.has(seat)) {
      let node = emptySeats.get(seat);
      if (!node) {
        node = document.createElement('li'); node.className = 'driver-card empty-slot'; node.dataset.seat = seat;
        const button = document.createElement('button'), number = document.createElement('span'), label = document.createElement('span'), act = document.createElement('span');
        button.type = 'button'; button.className = 'seat-move'; button.setAttribute('aria-label', `Move to seat ${seat}, car ${seat}`);
        number.className = 'cabinet-number'; number.textContent = String(seat).padStart(2, '0'); label.className = 'seat-label'; label.textContent = 'Open seat'; act.className = 'seat-action'; act.textContent = 'Move here';
        button.append(number, label, act); button.onclick = () => { if (room.moveSeat(seat)) $('seatStatus').textContent = state.isHost ? `Your car is ${seat}. Confirm Ready again.` : `Moving to car ${seat}…`; };
        node.append(button); emptySeats.set(seat, node);
      }
      const button = node.firstElementChild; button.disabled = !!state.seatPending; button.querySelector('.seat-action').textContent = state.seatPending === seat ? 'Moving…' : 'Move here';
      nodes.set(seat, node);
    }
    [...nodes].sort((a, b) => a[0] - b[0]).forEach(([, node], i) => { if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null); });
    while (list.children.length > nodes.size) list.lastElementChild.remove();
    $('openSeatCount').hidden = showSeats;
    $('openSeatCount').textContent = state.phase === 'waiting' ? 'You are in the queue: you take a seat when the host returns everyone to the room.' : state.phase === 'pending' ? 'Your host is reviewing the request.' : state.phase === 'error' ? 'Return to room selection to try another invitation.' : state.phase === 'connecting' ? 'Preparing your private room…' : state.phase === 'playing' ? 'The linked race is running.' : '';
    const status = $('seatStatus'); status.hidden = !showSeats;
    if (state.lastAck?.action === 'move-seat' && state.lastAck.command > lastSeatAck) { lastSeatAck = state.lastAck.command; status.textContent = state.lastAck.accepted ? `Your car is ${me?.cabinet}. Confirm Ready again.` : state.lastAck.reason; }
    else if (state.seatPending) status.textContent = `Moving to car ${state.seatPending}…`;
    else if (me && previousSeat !== me.cabinet) status.textContent = `Your car: ${me.cabinet}. Choose an open seat to move, or a driver to request a swap.`;
    if (state.lastAck?.action.startsWith('swap-') && state.lastAck.command > lastSeatAck) { lastSeatAck = state.lastAck.command; if (!state.lastAck.accepted) status.textContent = state.lastAck.reason; }
    previousSeat = me?.cabinet ?? null;
    // Seat swap notice: the asked driver accepts or declines, the asker may cancel.
    const offer = (state.swaps || []).find(o => o.from === state.id || o.to === state.id), box = $('seatSwap'), incoming = offer?.to === state.id;
    box.hidden = !offer || state.phase !== 'lobby';
    if (offer) {
      const other = state.members.find(m => m.id === (incoming ? offer.from : offer.to));
      $('seatSwapTitle').textContent = incoming ? 'Swap request' : 'Waiting for a reply · 30 s';
      $('seatSwapMessage').textContent = incoming ? `${other?.name || 'A driver'} offers car ${offer.fromCabinet} for your car ${offer.toCabinet}.` : `You offered car ${offer.fromCabinet} for ${other?.name || 'the driver'}’s car ${offer.toCabinet}.`;
      $('seatSwapAccept').hidden = $('seatSwapDecline').hidden = !incoming; $('seatSwapCancel').hidden = incoming;
    }
  }

  function renderPending(state) {
    const stamp = state.phase + JSON.stringify(state.pending);
    if (stamp !== pendingStamp) {
      pendingStamp = stamp;
      $('pendingList').replaceChildren(...state.pending.map(m => {
        const li = document.createElement('li'), name = document.createElement('span'), accept = document.createElement('button'), decline = document.createElement('button');
        name.textContent = m.name; name.title = m.name; accept.type = decline.type = 'button'; accept.textContent = 'Admit'; decline.textContent = '×';
        accept.disabled = decline.disabled = !['lobby', 'playing'].includes(state.phase);   // during a game the admitted driver waits for the next one
        accept.setAttribute('aria-label', `Admit ${m.name}`); decline.setAttribute('aria-label', `Decline ${m.name}`);
        accept.onclick = () => { try { room.approve(m.id); } catch (e) { $('roomMessage').textContent = e.message; } }; decline.onclick = () => room.reject(m.id);
        li.append(name, accept, decline); return li;
      }));
    }
    const n = state.isHost ? state.pending.length : 0;
    $('pendingBlock').hidden = !n; $('pendingCount').textContent = String(n); $('pendingJump').hidden = !n; $('pendingJump').textContent = `Requests · ${n}`;
  }
  $('pendingJump').onclick = () => $('pendingList').querySelector('button:not(:disabled)')?.focus();

  // ---- arrival toasts in the race (D1 waiting-toast markup) -----------------------
  function toast(event) {
    if (!gameRunning() || !['joined', 'request', 'left', 'stalled'].includes(event.kind)) return;
    const root = $('waitingToast'), title = document.createElement('strong'), detail = document.createElement('span');
    title.textContent = event.name + { request: ' requested to join', joined: ' joined the room', left: ' left the room', stalled: ' stopped responding' }[event.kind];
    detail.textContent = event.kind === 'left' ? 'Driver disconnected' : event.kind === 'stalled' ? 'Out of this race · back in the room for the next one' : 'The race is running. New drivers join a new room.';
    root.replaceChildren(title, detail); root.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { root.hidden = true; }, 5500);
  }

  return {
    markChatRead: markRead,
    event(e) {
      if (e.kind === 'request') sound('request'); else if (e.kind === 'joined' || e.kind === 'admitted') sound('arrival'); else if (e.kind === 'left' || e.kind === 'stalled') sound('departure');
      toast(e);
    },
    render(state) {
      notifications.update(state);
      const key = state.host || state.id || 'idle';
      if (key !== roomKey) {
        invitationMenu.close(); roomKey = key; pendingStamp = ''; lastChatSeq = 0; lastAckCommand = 0; lastSeatAck = 0; previousSeat = null;
        $('seatStatus').textContent = ''; messages.clear(); $('chatLog').replaceChildren(); chatFollow.reset(); cards.clear(); emptySeats.clear();
        $('playersList').replaceChildren(); $('chatInput').value = ''; $('chatLength').textContent = '0/240'; markRead(); mobileTab('grid');
      }
      if (state.phase === 'idle') { invitationMenu.setAvailable(false); return; }
      panel.classList.toggle('guest-room', !state.isHost); panel.classList.toggle('has-requests', state.isHost && state.pending.length > 0); panel.dataset.phase = state.phase;
      const out = state.phase === 'playing' && state.members.find(m => m.id === state.id)?.connection === 'stalled';
      $('roomTitle').textContent = out ? 'Out of this race' : state.phase === 'waiting' ? 'Waiting for the next race' : state.phase === 'pending' ? 'Request sent' : state.phase === 'error' ? 'Room unavailable' : state.roomName || (state.isHost ? 'Your starting grid' : 'Your race room');
      $('roomPhase').textContent = out ? 'WAITING' : { lobby: 'LOBBY', playing: 'ON TRACK', pending: 'WAITING', error: 'OFFLINE', connecting: 'CONNECTING' }[state.phase] || 'LOBBY';
      $('roomCount').textContent = state.phase === 'waiting' ? `In queue · ${state.waiters?.length || 1} waiting` : state.phase === 'pending' ? 'Awaiting host' : `${state.members.length} / ${SEATS} drivers`;
      const url = new URL(location.href); url.hash = new URLSearchParams({ room: state.code }).toString();
      $('inviteLink').value = state.code ? url.href : ''; $('roomCode').textContent = state.code || 'Connecting…';
      invitationMenu.setAvailable(state.isHost && !!state.code && state.phase === 'lobby');
      for (const [k, id] of Object.entries(SETTING_IDS)) { $(id).value = String(state.settings[k]); $(id).disabled = !state.isHost || state.phase !== 'lobby'; }
      $('roomSettingsHint').textContent = state.isHost ? 'Shared by the grid. Changes reset Ready.' : 'Your host chooses these for everyone.';
      $('readyCount').textContent = state.phase === 'playing' ? `${state.members.filter(m => !['left', 'stalled'].includes(m.connection)).length} on track` : `${state.members.filter(m => m.ready).length} ready`;
      renderRoster(state); renderPending(state); renderChat(state);
      const me = state.members.find(m => m.id === state.id);
      $('readyRoom').hidden = state.phase !== 'lobby' || !me; $('readyRoom').disabled = !!state.readyPending || !!state.seatPending;
      $('readyRoom').textContent = state.readyPending ? 'CONFIRMING…' : me?.ready ? 'READY ✓' : 'I’M READY'; $('readyRoom').setAttribute('aria-pressed', String(!!me?.ready));
      $('startRoom').hidden = !(state.isHost && state.phase === 'lobby'); $('startRoom').disabled = !room.canStart();
      $('returnRoomGame').hidden = state.phase !== 'playing' || !gameRunning() || out;
      $('stopRoom').hidden = !(state.isHost && state.phase === 'playing');
      $('leaveRoomLabel').textContent = state.phase === 'playing' ? 'Leave game' : state.phase === 'error' ? 'Back to rooms' : 'Leave room';
      const notReady = state.members.filter(m => !m.ready).length;
      const lobby = state.pending.length ? 'Review the requests to complete your grid.' : state.members.length < 2 ? 'Invite at least one friend: a linked race needs two cabinets.' : notReady ? `${notReady} ${notReady === 1 ? 'driver is' : 'drivers are'} not ready yet.` : state.isHost ? 'Your grid is ready. Start when you are.' : 'Your grid is ready. Waiting for the host.';
      const labels = { connecting: 'Connecting to the room…', pending: 'Your host will admit you shortly.', lobby, playing: out ? 'Your cabinet stopped responding, so the race went on without it. Wait here: you take your seat again when the host returns everyone to the room.' : 'The race keeps running while this menu is open.', error: state.error || 'Try another invitation.' };
      $('roomMessage').textContent = labels[state.phase] || '';
      $('roomConnection').textContent = state.phase === 'connecting' ? 'Connecting…' : state.phase === 'error' ? 'Disconnected' : state.signaling ? '● Room connected' : 'Room connected · invitation service reconnecting';
      $('roomConnection').dataset.state = state.phase === 'error' ? 'offline' : state.signaling ? 'connected' : 'recovering';
      if (state.phase !== lastPhase) { lastPhase = state.phase; if (!panel.hidden) { if (state.phase === 'lobby' && me) $('readyRoom').focus(); else if (state.phase === 'error') $('leaveRoom').focus(); } }
    },
  };
}
