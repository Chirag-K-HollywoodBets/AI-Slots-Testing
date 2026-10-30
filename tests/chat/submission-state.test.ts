import { describe, expect, it } from 'vitest';
const { createSubmissionState, fingerprint } = require('../../chat/submission-state.cjs');

const betslip = { stakeCents: 1000, displayedPayoutCents: 650, selections: [{ selection: 'Arsenal', odds: 0.65 }] };
function setup(expiresAt = 10_000) {
  const state = createSubmissionState();
  const authorization = state.begin({ reviewId: 'review', runId: 'run', sessionId: 'session', revision: 4, betslip, expiresAt }, 1);
  return { state, authorization };
}
const request = (authorization: any, extra = {}) => ({ reviewId: 'review', runId: 'run', sessionId: 'session',
  revision: 4, fingerprint: fingerprint(betslip), idempotencyKey: authorization.idempotencyKey, ...extra });

describe('single-use submission lifecycle', () => {
  it('binds authorization to review, run, session, revision, slip and idempotency key', () => {
    const { state, authorization } = setup();
    expect(state.claim(request(authorization, { sessionId: 'other' }), 2).ok).toBe(false);
    expect(state.claim(request(authorization, { revision: 5 }), 2).ok).toBe(false);
    expect(state.claim(request(authorization, { fingerprint: fingerprint({ ...betslip, stakeCents: 2000 }) }), 2).ok).toBe(false);
    expect(state.claim(request(authorization, { idempotencyKey: 'other' }), 2).ok).toBe(false);
    expect(state.claim(request(authorization), 2).ok).toBe(true);
    expect(state.claim(request(authorization), 2)).toMatchObject({ ok: false, reason: 'revalidating' });
  });
  it('fingerprints material slip fields so changed stake, payout, market, bet type, odds or selections need a new review', () => {
    const { state, authorization } = setup();
    for (const changed of [
      { ...betslip, stakeCents: 2000 },
      { ...betslip, displayedPayoutCents: 700 },
      { ...betslip, market: 'other-market' },
      { ...betslip, betType: 'accumulator' },
      { ...betslip, selections: [{ selection: 'Chelsea', odds: 0.7 }] },
      { ...betslip, selections: [{ ...betslip.selections[0], odds: 0.7 }] },
    ]) {
      expect(state.claim({ ...request(authorization), fingerprint: fingerprint(changed) }, 2).ok).toBe(false);
    }
  });
  it('does not permit another submission after accepted, rejected or unknown outcomes', () => {
    for (const outcome of ['accepted', 'rejected', 'unknown']) {
      const { state, authorization } = setup();
      state.claim(request(authorization), 2);
      expect(state.transition('submitting')).toBe(true);
      expect(state.transition(outcome)).toBe(true);
      expect(state.claim(request(authorization), 3)).toMatchObject({ ok: false, reason: outcome });
    }
  });
  it('allows a fresh review after acceptance while the previous authorization remains consumed', () => {
    const { state, authorization } = setup();
    state.claim(request(authorization), 2);
    state.transition('submitting');
    state.transition('accepted');
    expect(state.begin({ reviewId: 'review-2', runId: 'run-2', sessionId: 'session', revision: 5,
      betslip, expiresAt: 20_000 }, 3)).toMatchObject({ reviewId: 'review-2', state: 'ready' });
    expect(state.claim(request(authorization), 4)).toMatchObject({ ok: false, reason: 'mismatch' });
  });
  it('reconciles only a late, reference-bearing result for the same unknown attempt', () => {
    const { state, authorization } = setup();
    state.claim(request(authorization), 2);
    state.transition('submitting');
    state.transition('unknown');
    expect(state.reconcile({ reviewId: 'review', runId: 'wrong-run', authorization: authorization.authorization,
      outcome: 'accepted', betReference: 'REF-1' })).toBeNull();
    expect(state.reconcile({ reviewId: 'review', runId: 'run', authorization: authorization.authorization,
      outcome: 'accepted', betReference: '' })).toBeNull();
    expect(state.reconcile({ reviewId: 'review', runId: 'run', authorization: authorization.authorization,
      outcome: 'accepted', betReference: 'REF-1' })).toMatchObject({ state: 'accepted' });
    expect(state.reconcile({ reviewId: 'review', runId: 'run', authorization: authorization.authorization,
      outcome: 'rejected' })).toBeNull();
  });
  it('expires at the deadline and does not permit retry after an uncertain result', () => {
    const { state, authorization } = setup(100);
    expect(state.claim(request(authorization), 100)).toMatchObject({ ok: false, reason: 'expired' });
    expect(state.get()?.state).toBe('expired');
  });
  it('uses volatile state so restart does not restore an authorization', () => {
    const { authorization } = setup();
    const restarted = createSubmissionState();
    expect(restarted.claim(request(authorization), 2)).toMatchObject({ ok: false, reason: 'mismatch' });
  });
});
