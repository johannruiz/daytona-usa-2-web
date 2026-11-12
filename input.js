// Controls for Daytona USA 2 web (Claude 2026-11-11). Combines the Daytona USA
// Web input devices exactly as its inputs(): keyboard (d1/keyboard-controls.js,
// rebindable), controller (d1/controller-controls.js, per-device profiles),
// racing wheel (d1/wheel-controls.js, takes priority when enabled and
// calibrated) and touch (d1/touch.js). Output: the m3_input_t record the WASM
// platform reads each field (buttons u32, analog[0] steering 0x80 centre,
// analog[1] accelerator, analog[2] brake) with Model 3 button bits and the
// four-speed H shifter held as GEAR1..GEAR4. The shifter starts in neutral:
// holding GEAR1 from boot stalls the game, so a gear is held only once chosen.
const COIN1 = 0x1, TEST = 0x4, SERVICE = 0x8, START1 = 0x10, VIEW1 = 0x10000, GEAR1 = 0x100000;
const FIELD_S = 17.385 / 1000;

// Daytona USA Web button bits (coin 1, start 2, test 4, service 8, cameras 16<<i) to Model 3.
export function model3Buttons(bits) {
  let b = 0;
  if (bits & 1) b |= COIN1;
  if (bits & 2) b |= START1;
  if (bits & 4) b |= TEST;
  if (bits & 8) b |= SERVICE;
  for (let i = 0; i < 4; i++) if (bits & (16 << i)) b |= VIEW1 << i;
  return b;
}

export class Controls {
  constructor({ keyboard, controller, wheel, touch, settings, blocked = () => false, onGear = () => {} }) {
    Object.assign(this, { keyboard, controller, wheel, touch, settings, blocked, onGear });
    this.gear = 0; this.enabled = true;
  }
  setGear(g) { const v = Math.max(0, Math.min(4, g)); if (v !== this.gear) { this.gear = v; this.onGear(v); } }
  shift(amount) { this.setGear(this.gear ? Math.max(1, Math.min(4, this.gear + amount)) : (amount > 0 ? 1 : 0)); }
  sample() {
    const wheel = this.wheel.read();
    let pad;
    if (wheel.active) pad = wheel;
    else if (this.blocked()) { this.controller.resetEdges(); pad = { steer: 0, accel: 0, brake: 0, buttons: 0, shift: 0, gear: null }; }
    else pad = this.controller.read(this.settings.joystickSensitivity, this.settings.joystickDeadzone);
    if (pad.gear) this.setGear(pad.gear); else if (pad.shift) this.shift(pad.shift);
    if (wheel.active) this.controller.resetEdges();
    const phone = this.touch.read();
    const keyboard = this.keyboard.read(FIELD_S);
    const buttons = model3Buttons(pad.buttons | phone.buttons | keyboard.buttons);
    return {
      steer: keyboard.active ? keyboard.steer : (phone.steer || pad.steer),
      accel: Math.max(keyboard.accel, pad.accel, phone.accel),
      brake: Math.max(keyboard.brake, pad.brake, phone.brake),
      buttons: buttons | (this.gear ? GEAR1 << (this.gear - 1) : 0),
    };
  }
  clear() { this.touch.clear(); this.keyboard.reset?.(); }
  write(heapU8, ptr) {
    const s = this.enabled ? this.sample() : { buttons: this.gear ? GEAR1 << (this.gear - 1) : 0, steer: 0, accel: 0, brake: 0 };
    const dv = new DataView(heapU8.buffer, ptr, 12);
    dv.setUint32(0, s.buttons >>> 0, true);
    dv.setUint8(4, Math.max(0, Math.min(255, Math.round(128 + s.steer * 127 / 100))));
    dv.setUint8(5, Math.round(Math.max(0, Math.min(100, s.accel)) * 2.55));
    dv.setUint8(6, Math.round(Math.max(0, Math.min(100, s.brake)) * 2.55));
    this.current = s;
  }
}
