'use strict';

/*
 * Queue state machine for ONE doctor on ONE day. Pure functions: each takes the
 * current list of entries and returns a new list (inputs are never mutated).
 *
 *               callNext                 done
 *   waiting ─────────────────► serving ───────────► done
 *      ▲                          │
 *      │   skip (1st time):       │  skip (2nd time)
 *      └── back to end of queue ──┘ ─────────────────► no_show
 *
 * - `token` is the number handed to the patient at check-in (1, 2, 3 ... per doctor per day).
 * - `seq` is the position in the line. It starts equal to arrival order and is bumped
 *   to the end when a patient is skipped, so the token number itself never changes.
 * - At most one entry is `serving` at a time.
 */

const STATE = Object.freeze({ WAITING: 'waiting', SERVING: 'serving', DONE: 'done', NO_SHOW: 'no_show' });
const MAX_SKIPS = 2;

class QueueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QueueError';
  }
}

const clone = (entries) => entries.map((e) => ({ ...e }));
const bySeq = (a, b) => a.seq - b.seq;

function nextToken(entries) {
  return entries.reduce((max, e) => Math.max(max, e.token), 0) + 1;
}

function nextSeq(entries) {
  return entries.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
}

/** Split entries into what the queue screen shows. */
function viewQueue(entries) {
  const waiting = entries.filter((e) => e.state === STATE.WAITING).sort(bySeq);
  return {
    serving: entries.find((e) => e.state === STATE.SERVING) || null,
    next: waiting[0] || null,
    waiting: waiting.slice(1),
    done: entries.filter((e) => e.state === STATE.DONE).sort((a, b) => a.token - b.token),
    noShow: entries.filter((e) => e.state === STATE.NO_SHOW).sort((a, b) => a.token - b.token),
  };
}

/** Add a newly arrived patient to the end of the line with the next token. */
function checkIn(entries, { appointmentId, now }) {
  if (entries.some((e) => e.appointment_id === appointmentId)) {
    throw new QueueError('Patient is already checked in');
  }
  const out = clone(entries);
  const entry = {
    appointment_id: appointmentId,
    token: nextToken(entries),
    seq: nextSeq(entries),
    state: STATE.WAITING,
    skips: 0,
    checked_in_at: now.toISOString(),
    called_at: null,
    served_at: null,
  };
  out.push(entry);
  return { entries: out, entry };
}

/**
 * Move the first waiting patient to `serving`.
 * `excludeToken` lets skip() avoid instantly re-calling the patient it just sent to the back.
 */
function callNext(entries, { now, excludeToken = null } = {}) {
  if (entries.some((e) => e.state === STATE.SERVING)) {
    throw new QueueError('A patient is already being served — mark them done or skip first');
  }
  const out = clone(entries);
  const candidate = out
    .filter((e) => e.state === STATE.WAITING && e.token !== excludeToken)
    .sort(bySeq)[0];
  if (candidate) {
    candidate.state = STATE.SERVING;
    candidate.called_at = now.toISOString();
  }
  return { entries: out, called: candidate || null };
}

/** Doctor finished with the current patient: mark done and call the next one. */
function markDone(entries, { now }) {
  const out = clone(entries);
  const current = out.find((e) => e.state === STATE.SERVING);
  if (!current) throw new QueueError('No patient is currently being served');
  current.state = STATE.DONE;
  current.served_at = now.toISOString();
  const next = callNext(out, { now });
  return { entries: next.entries, finished: current, called: next.called };
}

/**
 * Current patient didn't come in when called.
 * 1st skip -> back to the end of the line. 2nd skip -> no-show.
 * Then the next patient (not the one just skipped) is called.
 */
function skip(entries, { now }) {
  const out = clone(entries);
  const current = out.find((e) => e.state === STATE.SERVING);
  if (!current) throw new QueueError('No patient is currently being served');

  current.skips += 1;
  current.called_at = null;
  if (current.skips >= MAX_SKIPS) {
    current.state = STATE.NO_SHOW;
  } else {
    current.state = STATE.WAITING;
    current.seq = nextSeq(out);
  }
  const next = callNext(out, { now, excludeToken: current.token });
  return { entries: next.entries, skipped: current, called: next.called };
}

module.exports = { STATE, MAX_SKIPS, QueueError, viewQueue, checkIn, callNext, markDone, skip, nextToken, nextSeq };
