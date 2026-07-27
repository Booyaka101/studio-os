// Timezone helpers. All storage is UTC ISO strings; rendering uses the studio
// timezone (an IANA name from settings). No external tz library — we lean on Intl.

/** Current UTC time as ISO string (second precision). */
export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function partsInTz(tz, date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return {
    y: Number(out.year), m: Number(out.month), d: Number(out.day),
    hh: Number(out.hour) % 24, mm: Number(out.minute), ss: Number(out.second),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday),
  };
}

/** Offset (ms) of tz relative to UTC at the given instant. */
function tzOffsetMs(tz, date) {
  const p = partsInTz(tz, date);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time in tz to a UTC Date.
 * (y, m 1-based, d, hh, mm)
 */
export function zonedToUtc(tz, y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = guess - tzOffsetMs(tz, new Date(guess));
  // refine once for DST edges
  ts = guess - tzOffsetMs(tz, new Date(ts));
  return new Date(ts);
}

/** Wall-clock parts of a UTC instant in tz. Accepts Date or ISO string. */
export function utcToZoned(tz, dateOrIso) {
  const date = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  return partsInTz(tz, date);
}

/** 'YYYY-MM-DD' local date in tz for a UTC instant (default now). */
export function localDateStr(tz, dateOrIso = new Date()) {
  const p = utcToZoned(tz, dateOrIso);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 'HH:MM' local time in tz. */
export function localTimeStr(tz, dateOrIso) {
  const p = utcToZoned(tz, dateOrIso);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/** Human display, e.g. "Mon 3 Jun, 09:00". */
export function formatInTz(tz, dateOrIso, opts = {}) {
  const date = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false, ...opts,
  }).format(date);
}

/** Add whole days to a 'YYYY-MM-DD' string. */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Weekday (0=Sun..6=Sat) of a 'YYYY-MM-DD' string, calendar-wise. */
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Hours between two instants (b - a), fractional. */
export function hoursBetween(aIso, bIso) {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 3600000;
}
