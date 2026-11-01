import test from 'node:test';
import assert from 'node:assert/strict';
import { isActive, allActive, pickPlaylist, broadcastActive } from '../shared/schedule.js';

// 2026-11-02 is a Monday.
const at = (day, hh, mm = 0) => new Date(2026, 10, 2 + day, hh, mm);

test('always is always active, including a missing schedule', () => {
  assert.equal(isActive({ mode: 'always' }, at(0, 3)), true);
  assert.equal(isActive(undefined, at(0, 3)), true);
});

test('date window: start, end, open-ended, boundaries', () => {
  const s = { mode: 'dates', start: '2026-11-02T09:00', end: '2026-11-02T17:00' };
  assert.equal(isActive(s, at(0, 8, 59)), false);
  assert.equal(isActive(s, at(0, 9)), true);
  assert.equal(isActive(s, at(0, 16, 59)), true);
  assert.equal(isActive(s, at(0, 17)), false);
  assert.equal(isActive({ mode: 'dates', start: '2026-11-02T09:00' }, at(6, 23)), true);
  assert.equal(isActive({ mode: 'dates', end: '2026-11-02T09:00' }, at(0, 8)), true);
});

test('weekly window within the week', () => {
  const s = { mode: 'week', startDay: 0, startTime: '09:00', endDay: 4, endTime: '17:00' };
  assert.equal(isActive(s, at(0, 8)), false);
  assert.equal(isActive(s, at(2, 3)), true);
  assert.equal(isActive(s, at(4, 16)), true);
  assert.equal(isActive(s, at(4, 17)), false);
  assert.equal(isActive(s, at(5, 12)), false);
});

test('weekly window wrapping over the weekend', () => {
  const s = { mode: 'week', startDay: 4, startTime: '18:00', endDay: 0, endTime: '08:00' };
  assert.equal(isActive(s, at(4, 17)), false);
  assert.equal(isActive(s, at(4, 19)), true);
  assert.equal(isActive(s, at(6, 12)), true);
  assert.equal(isActive(s, at(0, 7)), true);
  assert.equal(isActive(s, at(0, 9)), false);
});

test('daily hours respect chosen days', () => {
  const s = { mode: 'daily', days: [0, 1], from: '09:00', to: '17:00' };
  assert.equal(isActive(s, at(0, 10)), true);
  assert.equal(isActive(s, at(2, 10)), false);
  assert.equal(isActive(s, at(0, 17)), false);
});

test('overnight daily window belongs to the day it started', () => {
  const s = { mode: 'daily', days: [4], from: '22:00', to: '02:00' };
  assert.equal(isActive(s, at(4, 23)), true);
  assert.equal(isActive(s, at(5, 1)), true, 'Saturday 1am is Friday night');
  assert.equal(isActive(s, at(4, 1)), false, 'Friday 1am is Thursday night');
  assert.equal(isActive(s, at(5, 23)), false);
});

test('embedded slides need every schedule in the chain', () => {
  const on = { mode: 'always' };
  const off = { mode: 'daily', days: [0], from: '09:00', to: '10:00' };
  assert.equal(allActive([on, off], at(0, 9)), true);
  assert.equal(allActive([on, off], at(0, 11)), false);
  assert.equal(allActive([], at(0, 11)), true);
});

test('dayparting: priority, blank rules, date limits, fallback', () => {
  const rules = [
    { id: 'lunch', playlistId: 'L', days: [], from: '12:00', to: '14:00', priority: 0 },
    { id: 'sale', playlistId: 'S', days: [], from: '13:00', to: '14:00', priority: 5 },
    { id: 'night', playlistId: null, days: [], from: '22:00', to: '06:00', priority: 0 },
    { id: 'xmas', playlistId: 'X', days: [], from: '00:00', to: '00:00', startDate: '2026-12-24', endDate: '2026-12-25', priority: 9 },
  ];
  assert.deepEqual(pickPlaylist(rules, 'F', at(0, 10)), { playlistId: 'F', ruleId: null });
  assert.equal(pickPlaylist(rules, 'F', at(0, 12)).playlistId, 'L');
  assert.equal(pickPlaylist(rules, 'F', at(0, 13)).playlistId, 'S');
  assert.equal(pickPlaylist(rules, 'F', at(0, 23)).playlistId, null);
  assert.equal(pickPlaylist(rules, 'F', at(0, 23)).ruleId, 'night');
  assert.equal(pickPlaylist(rules, 'F', new Date(2026, 11, 25, 23)).playlistId, 'X');
  assert.notEqual(pickPlaylist(rules, 'F', new Date(2026, 11, 26, 10)).playlistId, 'X');
});

test('broadcast windows', () => {
  const now = new Date('2026-11-02T10:00:00Z');
  assert.equal(broadcastActive({ startsAt: '2026-11-02T09:00:00Z', expiresAt: '2026-11-02T11:00:00Z' }, now), true);
  assert.equal(broadcastActive({ startsAt: '2026-11-02T10:30:00Z' }, now), false);
  assert.equal(broadcastActive({ expiresAt: '2026-11-02T09:59:00Z' }, now), false);
  assert.equal(broadcastActive({}, now), true);
});
