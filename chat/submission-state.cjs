const { createHash, randomUUID } = require('node:crypto');

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Process-local, single-use authorization. Restarting the server discards it;
// callers must reconcile an uncertain sportsbook result before starting over.
function createSubmissionState() {
  let current = null;
  return {
    begin({ reviewId, runId, sessionId, revision, betslip, reviewedDetails = betslip, expiresAt }, now = Date.now()) {
      if (current && !['accepted', 'rejected', 'expired', 'closed'].includes(current.state)) return null;
      if (!reviewId || !runId || !sessionId || !Number.isSafeInteger(revision)
        || !betslip || expiresAt <= now) return null;
      current = { reviewId, runId, sessionId, revision, fingerprint: fingerprint(reviewedDetails),
        authorization: randomUUID(), idempotencyKey: randomUUID(), expiresAt, state: 'ready' };
      return this.get();
    },
    claim({ reviewId, runId, sessionId, revision, fingerprint: suppliedFingerprint, idempotencyKey }, now = Date.now()) {
      if (!current || current.reviewId !== reviewId || current.runId !== runId
        || current.sessionId !== sessionId || current.revision !== revision
        || current.fingerprint !== suppliedFingerprint || current.idempotencyKey !== idempotencyKey) return { ok: false, reason: 'mismatch' };
      if (current.expiresAt <= now) { current.state = 'expired'; return { ok: false, reason: 'expired' }; }
      if (current.state !== 'ready') return { ok: false, reason: current.state };
      current.state = 'revalidating';
      return { ok: true, authorization: current.authorization, idempotencyKey: current.idempotencyKey };
    },
    transition(state) {
      if (!current || !['submitting', 'accepted', 'rejected', 'unknown', 'closed'].includes(state)) return false;
      const allowed = { revalidating: ['submitting', 'rejected', 'unknown', 'closed'], submitting: ['accepted', 'rejected', 'unknown', 'closed'] };
      if (!(allowed[current.state] || []).includes(state)) return false;
      current.state = state;
      return true;
    },
    reconcile({ reviewId, runId, authorization, outcome, betReference, reason }) {
      if (!current || current.reviewId !== reviewId || current.runId !== runId
        || current.authorization !== authorization || current.state !== 'unknown'
        || !['accepted', 'rejected'].includes(outcome)
        || (outcome === 'accepted' && !(typeof betReference === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(betReference)))) return null;
      current.state = outcome;
      current.result = { outcome, ...(outcome === 'accepted' ? { betReference } : {}),
        ...(typeof reason === 'string' ? { reason: reason.slice(0, 240) } : {}) };
      return this.get();
    },
    refresh({ reviewId, runId, sessionId, revision, betslip, reviewedDetails = betslip, expiresAt }, now = Date.now()) {
      if (!current || current.state !== 'ready' || current.reviewId !== reviewId || current.runId !== runId
        || current.sessionId !== sessionId || current.revision !== revision || expiresAt <= now) return null;
      current = { ...current, fingerprint: fingerprint(reviewedDetails), idempotencyKey: randomUUID(),
        authorization: randomUUID(), expiresAt };
      return this.get();
    },
    get() { return current ? { ...current } : null; },
  };
}

module.exports = { createSubmissionState, fingerprint };
