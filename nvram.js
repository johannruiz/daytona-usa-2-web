// Cabinet backup (SRAM + 93C46 EEPROM) for Daytona USA 2 web (Claude 2026-11-11).
// File layout as src/backup.c: 131072 bytes SRAM, then 64 little-endian
// EEPROM words. The EEPROM image (big-endian view) follows the original game
// format (reference/CABINET_OPTIONS.md): "M3SEGA", CRC-CCITT of the 58-byte
// payload at 6..7, payload at 12..69 duplicated at 70..127. Payload bytes
// found by diffing profiles saved through the original TEST menu:
//   30 = LINK ID (0 single, 1 master, 2 slave), 31 = car number - 1,
//   32 = cabinet type (0 deluxe, 1 twin).
// Default image: the project's single-cabinet profile (Export, Normal).
const DEFAULT_EEPROM = '4d3353454741d241a21001440005000402010101010101010300000000000000010101008080030000000108040201010101010201010101010107070014000000000000000000050004020101010101010103000000000000000101010080800300000001080402010101010102010101010101070700140000000000000000';
export const SRAM_SIZE = 131072, BACKUP_SIZE = SRAM_SIZE + 128;
const DB = 'daytona2-nvram-v1';

function crc(payload) {
  let c = 0;
  for (const b of payload) { c ^= b << 8; for (let k = 0; k < 8; k++) c = ((c << 1) ^ (c & 0x8000 ? 0x1021 : 0)) & 0xffff; }
  return c;
}
const hex = s => Uint8Array.from(s.match(/../g), h => parseInt(h, 16));
export function eepromFromBackup(backup) {
  if (!backup || backup.length !== BACKUP_SIZE) return null;
  const big = new Uint8Array(128);
  for (let i = 0; i < 128; i++) big[i] = backup[SRAM_SIZE + (i ^ 1)];
  return String.fromCharCode(...big.subarray(0, 6)) === 'M3SEGA' ? big : null;
}
// Race options of the original TEST menu (src/cabinet_settings.c offsets and
// ranges): what the single-player panel and the room race settings change.
export const RACE_OPTIONS = Object.freeze({
  difficulty: { offset: 33, min: 0, max: 3 },     // Easy, Normal, Hard, Hardest
  mode: { offset: 35, min: 0, max: 6 },           // Normal (Sprint), Grand Prix, 100..500 Miles
  voice: { offset: 39, min: 0, max: 1 },          // Dennis, Mitsuyoshi
  attractSound: { offset: 34, min: 0, max: 1 },
  lapsBeginner: { offset: 43, min: 8, max: 16 },
  lapsAdvanced: { offset: 44, min: 4, max: 12 },
  lapsExpert: { offset: 45, min: 2, max: 8 },
});
export function raceOptions(backup) {
  const big = eepromFromBackup(backup) || hex(DEFAULT_EEPROM), out = {};
  for (const [k, o] of Object.entries(RACE_OPTIONS)) out[k] = Math.max(o.min, Math.min(o.max, big[o.offset]));
  return out;
}
export function makeBackup(previous, { link = null, car = null, cabinet = null, race = {} } = {}) {
  const out = new Uint8Array(BACKUP_SIZE);
  if (previous && previous.length === BACKUP_SIZE) out.set(previous.subarray(0, SRAM_SIZE));
  const big = eepromFromBackup(previous) || hex(DEFAULT_EEPROM);
  const before = big.slice(12, 70);
  if (link !== null) big[30] = link;
  if (car !== null) big[31] = car - 1;
  if (cabinet !== null) big[32] = cabinet;
  for (const [k, v] of Object.entries(race || {})) {
    const o = RACE_OPTIONS[k];
    if (o && Number.isInteger(v) && v >= o.min && v <= o.max) big[o.offset] = v;
  }
  if (big.subarray(12, 70).some((b, i) => b !== before[i])) {
    const generation = (((big[12] << 8) | big[13]) + 1) & 0xffff;   // as the original 07578
    big[12] = generation >> 8; big[13] = generation & 255;
    const c = crc(big.subarray(12, 70)); big[6] = c >> 8; big[7] = c & 255;
    big.copyWithin(70, 12, 70);
  }
  for (let i = 0; i < 128; i++) out[SRAM_SIZE + (i ^ 1)] = big[i];
  return out;
}
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('files', mode); let value;
      const req = fn(tx.objectStore('files')); req.onsuccess = () => { value = req.result; };
      tx.oncomplete = () => { db.close(); resolve(value); }; tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}
export const loadStored = name => idb('readonly', s => s.get(name)).catch(() => null);
export const saveStored = (name, bytes) => idb('readwrite', s => s.put(bytes, name)).catch(e => console.warn('[nvram]', e));
