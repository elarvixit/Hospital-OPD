'use strict';

/** An error with an HTTP status, safe to show to the user. */
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Errors a repository throws when a database constraint says no.
class SlotTakenError extends Error {}
class LeaveOverlapError extends Error {}
/** The queue changed since it was read (optimistic-lock version mismatch). */
class QueueConflictError extends Error {}

module.exports = { AppError, SlotTakenError, LeaveOverlapError, QueueConflictError };
