// Player race positions over the game (Claude 2026-11-12): Daytona USA Web's
// race-standings overlay (same markup and css/race-standings.css), fed by the
// host's authoritative order (race-order.js) shared through the room.
import { carColor } from './d1/car-colors.js';
const ordinal = n => n == null ? '—' : `${n}${n === 1 ? 'ST' : n === 2 ? 'ND' : n === 3 ? 'RD' : 'TH'}`;

export function mountRaceStandings(element) {
  const nodes = new Map(), status = document.createElement('small');
  status.className = 'race-order-status'; status.hidden = true; status.setAttribute('aria-live', 'polite'); element.after(status);
  let lastKey = '';
  function clear() { element.hidden = true; status.hidden = true; lastKey = ''; }
  return {
    clear,
    // order: { rows: [{ node, position }], final }; members: room members with their link node.
    update(order, members, show) {
      if (!show || !order?.rows?.length) { clear(); return; }
      const rows = order.rows.map(r => ({ ...r, member: members.find(m => m.node === r.node) })).filter(r => r.member);
      if (!rows.length) { clear(); return; }
      const key = JSON.stringify([order.final, rows.map(r => [r.node, r.position, r.member.name, !!r.member.departed])]);
      if (key === lastKey) return; lastKey = key;
      const wanted = new Set(rows.map(r => r.node)); for (const [id, n] of nodes) if (!wanted.has(id)) { n.remove(); nodes.delete(id); }
      rows.forEach((r, i) => {
        let node = nodes.get(r.node);
        if (!node) { node = document.createElement('li'); node.className = 'race-driver'; for (const cls of ['race-place', 'race-name']) { const span = document.createElement('span'); span.className = cls; node.append(span); } nodes.set(r.node, node); }
        const color = carColor(r.member.cabinet);
        node.style.setProperty('--driver-color', color.hudColor || color.color); node.style.setProperty('--driver-outline', '#070707');
        node.dataset.unavailable = String(!!r.member.departed);
        node.children[0].textContent = ordinal(r.position); node.children[1].textContent = r.member.name;
        node.title = `${r.member.name} · Position ${r.position}`; node.setAttribute('aria-label', node.title);
        if (element.children[i] !== node) element.insertBefore(node, element.children[i] || null);
      });
      status.textContent = order.final ? 'RESULT CONFIRMED' : ''; status.hidden = !order.final;
      element.hidden = false;
    },
  };
}
