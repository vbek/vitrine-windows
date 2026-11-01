// Scheduling logic shared by the server ("what's on now") and the player, which
// evaluates it locally so schedules keep working while the studio is unreachable.
// All times are wall-clock local to whoever evaluates them.

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const minuteOfDay = (d) => d.getHours() * 60 + d.getMinutes();
// 0 = Monday ... 6 = Sunday
const weekday = (d) => (d.getDay() + 6) % 7;

function inDailyWindow(s, now) {
  const days = s.days?.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
  const from = toMinutes(s.from);
  const to = toMinutes(s.to);
  const cur = minuteOfDay(now);
  const today = weekday(now);
  if (from === to) return days.includes(today);
  if (from < to) return days.includes(today) && cur >= from && cur < to;
  // Overnight window: belongs to the day it started on.
  if (cur >= from) return days.includes(today);
  return cur < to && days.includes((today + 6) % 7);
}

function inWeekWindow(s, now) {
  const week = 7 * 1440;
  const start = (s.startDay ?? 0) * 1440 + toMinutes(s.startTime);
  const end = (s.endDay ?? 0) * 1440 + toMinutes(s.endTime);
  const cur = weekday(now) * 1440 + minuteOfDay(now);
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  return (cur >= start && cur < week) || cur < end; // wraps across Sunday night
}

function inDateWindow(s, now) {
  if (s.start && now < new Date(s.start)) return false;
  if (s.end && now >= new Date(s.end)) return false;
  return true;
}

/** True when a slide schedule allows playback at `now`. */
export function isActive(schedule, now = new Date()) {
  switch (schedule?.mode) {
    case 'dates': return inDateWindow(schedule, now);
    case 'week': return inWeekWindow(schedule, now);
    case 'daily': return inDailyWindow(schedule, now);
    default: return true; // 'always'
  }
}

/** A flattened slide carries its own schedule plus those of any playlists embedding it. */
export const allActive = (schedules, now = new Date()) =>
  (schedules || []).every((s) => isActive(s, now));

/**
 * Dayparting: choose what a screen plays now. Rules are checked highest priority first;
 * a matching rule with a null playlist means "blank the screen".
 * Returns { playlistId, ruleId } where playlistId may be null.
 */
export function pickPlaylist(rules, fallback, now = new Date()) {
  const sorted = [...(rules || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const r of sorted) {
    if (r.startDate && now < new Date(`${r.startDate}T00:00:00`)) continue;
    if (r.endDate && now > new Date(`${r.endDate}T23:59:59`)) continue;
    if (inDailyWindow(r, now)) return { playlistId: r.playlistId ?? null, ruleId: r.id };
  }
  return { playlistId: fallback ?? null, ruleId: null };
}

export function broadcastActive(b, now = new Date()) {
  if (b.startsAt && now < new Date(b.startsAt)) return false;
  if (b.expiresAt && now >= new Date(b.expiresAt)) return false;
  return true;
}
