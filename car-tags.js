// Colours of the "nP" tags the game draws over each car (Claude 2026-11-14), for
// the race standings. Measured from in-race screenshots on the Advanced course
// (no fog), channels as the game's 5-bit colours: build/evidence/car_markers_20261114.
// Cars 1-8 have a solid tag; 9-16 repeat the colour of n-8 in the upper-left half,
// split by a diagonal from light grey in the lower-right half. Car 5 (and 13) is dark grey.
const BASE = ['#d80000', '#0000d8', '#d8d800', '#00d800', '#404040', '#d84080', '#00d8d8', '#d85800'];
export const TAG_SPLIT = '#d8d8d8';

export function carTag(car) {
  const n = Number(car);
  if (!Number.isInteger(n) || n < 1 || n > 16) return { color: '#77776c', split: null };
  return { color: BASE[(n - 1) % 8], split: n > 8 ? TAG_SPLIT : null };
}
