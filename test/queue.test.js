'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/core/queue');

const now = new Date('2026-10-05T10:00:00');

/** Check in appointments 1..n and return the entries. */
function arrive(n, entries = []) {
  for (let i = 0; i < n; i++) {
    const nextId = entries.length ? Math.max(...entries.map((e) => e.appointment_id)) + 1 : 1;
    entries = Q.checkIn(entries, { appointmentId: nextId, now }).entries;
  }
  return entries;
}
const tokens = (list) => list.map((e) => e.token);
const byToken = (entries, t) => entries.find((e) => e.token === t);

describe('check-in', () => {
  test('tokens start at 1 and increase in arrival order', () => {
    const e = arrive(3);
    assert.deepEqual(tokens(e), [1, 2, 3]);
    assert.ok(e.every((x) => x.state === 'waiting' && x.skips === 0));
  });

  test('the same appointment cannot check in twice', () => {
    const e = arrive(1);
    assert.throws(() => Q.checkIn(e, { appointmentId: 1, now }), Q.QueueError);
  });

  test('inputs are never mutated', () => {
    const e = arrive(2);
    const snapshot = JSON.stringify(e);
    Q.callNext(e, { now });
    assert.equal(JSON.stringify(e), snapshot);
  });
});

describe('view', () => {
  test('now serving / next / waiting in token order', () => {
    let e = arrive(4);
    e = Q.callNext(e, { now }).entries;
    const v = Q.viewQueue(e);
    assert.equal(v.serving.token, 1);
    assert.equal(v.next.token, 2);
    assert.deepEqual(tokens(v.waiting), [3, 4]);
  });

  test('empty queue', () => {
    const v = Q.viewQueue([]);
    assert.equal(v.serving, null);
    assert.equal(v.next, null);
    assert.deepEqual(v.waiting, []);
  });
});

describe('callNext / done', () => {
  test('callNext serves the lowest token and stamps called_at', () => {
    const { entries, called } = Q.callNext(arrive(2), { now });
    assert.equal(called.token, 1);
    assert.equal(byToken(entries, 1).state, 'serving');
    assert.equal(byToken(entries, 1).called_at, now.toISOString());
  });

  test('cannot call next while someone is being served', () => {
    const e = Q.callNext(arrive(2), { now }).entries;
    assert.throws(() => Q.callNext(e, { now }), /already being served/);
  });

  test('callNext on an empty line calls nobody', () => {
    assert.equal(Q.callNext([], { now }).called, null);
  });

  test('done finishes the current patient and moves to the next token', () => {
    let e = Q.callNext(arrive(3), { now }).entries;
    const r = Q.markDone(e, { now });
    assert.equal(r.finished.token, 1);
    assert.equal(byToken(r.entries, 1).state, 'done');
    assert.ok(byToken(r.entries, 1).served_at);
    assert.equal(r.called.token, 2);
  });

  test('done on the last patient leaves nobody serving', () => {
    let e = Q.callNext(arrive(1), { now }).entries;
    const r = Q.markDone(e, { now });
    assert.equal(r.called, null);
    assert.equal(Q.viewQueue(r.entries).serving, null);
  });

  test('done with nobody serving is an error', () => {
    assert.throws(() => Q.markDone(arrive(1), { now }), /No patient/);
  });
});

describe('skip / no-show', () => {
  test('first skip sends the patient to the END of the line, keeping their token', () => {
    let e = Q.callNext(arrive(4), { now }).entries; // serving 1, waiting 2,3,4
    const r = Q.skip(e, { now });
    assert.equal(r.skipped.token, 1);
    assert.equal(r.skipped.skips, 1);
    assert.equal(r.called.token, 2);
    const v = Q.viewQueue(r.entries);
    assert.equal(v.next.token, 3);
    assert.deepEqual(tokens(v.waiting), [4, 1]);
  });

  test('second skip marks the patient no-show', () => {
    let e = Q.callNext(arrive(2), { now }).entries; // serving 1
    e = Q.skip(e, { now }).entries; // 1 -> back; serving 2
    e = Q.markDone(e, { now }).entries; // 2 done; serving 1 again
    assert.equal(Q.viewQueue(e).serving.token, 1);
    const r = Q.skip(e, { now });
    assert.equal(byToken(r.entries, 1).state, 'no_show');
    assert.equal(byToken(r.entries, 1).skips, 2);
    assert.deepEqual(tokens(Q.viewQueue(r.entries).noShow), [1]);
  });

  test('a no-show is never called again', () => {
    let e = Q.callNext(arrive(1), { now }).entries;
    e = Q.skip(e, { now }).entries; // back of the line (and the only one)
    e = Q.callNext(e, { now }).entries;
    e = Q.skip(e, { now }).entries; // no-show
    assert.equal(Q.callNext(e, { now }).called, null);
  });

  test('skipping the only patient does not instantly re-call them', () => {
    let e = Q.callNext(arrive(1), { now }).entries;
    const r = Q.skip(e, { now });
    assert.equal(r.called, null);
    assert.equal(Q.viewQueue(r.entries).next.token, 1);
  });

  test('patients who arrive after a skip queue behind the skipped patient', () => {
    let e = Q.callNext(arrive(2), { now }).entries; // serving 1, waiting 2
    e = Q.skip(e, { now }).entries; // serving 2, waiting 1
    e = arrive(1, e); // token 3 arrives
    const v = Q.viewQueue(e);
    assert.equal(v.next.token, 1);
    assert.deepEqual(tokens(v.waiting), [3]);
  });

  test('skip with nobody serving is an error', () => {
    assert.throws(() => Q.skip(arrive(1), { now }), /No patient/);
  });

  test('full day: tokens flow through in order with one skip', () => {
    let e = Q.callNext(arrive(3), { now }).entries;
    const served = [];
    const step = (fn) => {
      const r = fn(e, { now });
      e = r.entries;
      if (r.finished) served.push(r.finished.token);
    };
    step(Q.skip); // 1 to the back -> serving 2
    step(Q.markDone); // 2 -> serving 3
    step(Q.markDone); // 3 -> serving 1
    step(Q.markDone); // 1
    assert.deepEqual(served, [2, 3, 1]);
    assert.ok(e.every((x) => x.state === 'done'));
  });
});
