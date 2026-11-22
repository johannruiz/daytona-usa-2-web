// Experimental tab: "Force feedback with FFB Helper" (2026-11-21). Arcade FFB Helper is a small
// app (SDL3) that plays window.arcadeForceFeedback's forces on the player's wheel; the client
// (ffb-helper.js, shared with the other arcade ports) connects to it on 127.0.0.1. All wheel
// force settings live in the helper's own page; the game only turns the link on or off.
import './ffb-helper.js';

const HELPER_PAGE = 'http://127.0.0.1:47823/';
const HELPER_DOWNLOAD = 'https://github.com/johannruiz/arcade-ffb-helper/releases/latest';

export function mountFfbHelper(root) {
  const helper = window.arcadeFfbHelper;
  if (!root || !helper) return;
  // Inside the Arcade Launcher its own SDL3 bridge already drives the wheel.
  if (window.arcadeLauncher) { root.hidden = true; return; }
  root.innerHTML = `
    <label class="setting-toggle"><span>Force feedback with FFB Helper<small>Sends the arcade drive board's forces to your wheel through Arcade FFB Helper, a small app for Windows and macOS. Chrome asks once to allow access to apps on this device.</small></span><input id="ffbHelperEnabled" type="checkbox"></label>
    <div class="ffb-helper-state"><span class="ffb-helper-dot" aria-hidden="true"></span><p id="ffbHelperStatus" role="status"></p></div>
    <p class="ffb-helper-links"><a id="ffbHelperOpen" href="${HELPER_PAGE}" target="_blank" rel="noopener">Open FFB Helper settings</a><a id="ffbHelperGet" href="${HELPER_DOWNLOAD}" target="_blank" rel="noopener">Get Arcade FFB Helper</a></p>`;
  const toggle = root.querySelector('#ffbHelperEnabled');
  const text = root.querySelector('#ffbHelperStatus');
  const open = root.querySelector('#ffbHelperOpen');
  const get = root.querySelector('#ffbHelperGet');
  toggle.addEventListener('change', () => (toggle.checked ? helper.enable() : helper.disable()));
  helper.onChange((status, info) => {
    toggle.checked = helper.enabled;
    let state = status, msg;
    if (status === 'off') msg = 'Off. Steering, pedals and buttons work without it; the wheel gets no forces.';
    else if (status === 'connecting') msg = 'Connecting to FFB Helper…';
    else if (status === 'waiting') msg = 'FFB Helper is not running on this device. Start it and the game connects by itself. If Chrome blocked access to apps on this device, allow it in the site settings next to the address bar.';
    else if (status === 'connected' && info?.wheel) msg = `Connected · ${info.device} · force feedback ready. Strength and the other wheel settings are in FFB Helper.`;
    else if (status === 'connected') { state = 'nowheel'; msg = info?.device ? `Connected · ${info.device} has no wheel force feedback.` : 'Connected · no wheel with force feedback found. Connect it and FFB Helper picks it up.'; }
    else msg = '';
    text.textContent = msg;
    root.dataset.state = state;
    open.hidden = status !== 'connected';
    get.hidden = status !== 'waiting' && status !== 'off';
  });
}
