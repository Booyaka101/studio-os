// Linear time on purpose. The old pattern let the domain overlap the dot and
// backtracked quadratically: one 50kb POST held the event loop for ~1s.
export function isEmail(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(s);
}
