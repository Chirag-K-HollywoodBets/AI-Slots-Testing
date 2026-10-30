import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createReviewState, busyRejects, preparationReviewPayload } = require('../../chat/review-state.cjs') as {
  createReviewState: () => {
    begin: (input: { runId: string; timeoutMs: number; now?: number }) => { id: string; runId: string; expiresAt: number };
    ready: (id: string, runId: string, betslip: object, now?: number) => boolean;
    finish: (id: string, runId: string, now?: number) => { ok: boolean; reason?: string; repeated?: boolean };
    expire: (id: string, runId: string, now?: number) => boolean;
    complete: (id: string, runId: string, state: string) => boolean;
    get: (id?: string) => { id: string; runId: string; state: string; betslip?: object } | null;
    clear: (id: string, runId: string) => boolean;
  };
  busyRejects: (route: string, busy: boolean) => boolean;
  preparationReviewPayload: (report: unknown, reviewId: string, expiresAt: number) => {
    status: string; reviewId: string; expiresAt: number; actions: Array<{ betslip: Record<string, unknown> }>;
  } | null;
};

describe('manual sportsbook review state', () => {
  it('publishes verified readiness only for the bound, unexpired run', () => {
    const state = createReviewState();
    const review = state.begin({ runId: 'run-a', timeoutMs: 5_000, now: 100 });
    const betslip = { selections: [{ fixture: 'Arsenal vs Chelsea', team: 'Arsenal' }], market: 'match-winner', stakeCents: 1000, submitted: false };
    expect(state.ready(review.id, 'other-run', betslip, 200)).toBe(false);
    expect(state.ready(review.id, 'run-a', betslip, 200)).toBe(true);
    expect(state.get(review.id)).toMatchObject({ state: 'ready', betslip });
  });

  it('finishes once, treats duplicate finish safely, and rejects stale or mismatched IDs', () => {
    const state = createReviewState();
    const review = state.begin({ runId: 'run-a', timeoutMs: 5_000, now: 100 });
    expect(state.finish('wrong-id', 'run-a', 200).ok).toBe(false);
    expect(state.finish(review.id, 'other-run', 200).ok).toBe(false);
    expect(state.ready(review.id, 'run-a', { stakeCents: 1000 }, 200)).toBe(true);
    expect(state.finish(review.id, 'run-a', 300)).toMatchObject({ ok: true, repeated: false });
    expect(state.finish(review.id, 'run-a', 301)).toMatchObject({ ok: true, repeated: true });
  });

  it('expires review and rejects finishing at or after the deadline', () => {
    const state = createReviewState();
    const review = state.begin({ runId: 'run-a', timeoutMs: 1_000, now: 100 });
    state.ready(review.id, 'run-a', { submitted: false }, 200);
    expect(state.expire(review.id, 'run-a', 1_199)).toBe(false);
    expect(state.finish(review.id, 'run-a', 1_200)).toMatchObject({ ok: false, reason: 'expired' });
    expect(state.get(review.id)?.state).toBe('expired');
    expect(state.finish(review.id, 'run-a', 1_201)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('keeps the app busy except for Finish review and permits cleanup after runner failure', () => {
    const state = createReviewState();
    const review = state.begin({ runId: 'run-a', timeoutMs: 5_000, now: 100 });
    expect(busyRejects('/api/run', true)).toBe(true);
    expect(busyRejects('/api/verify-sports', true)).toBe(true);
    expect(busyRejects('/api/finish-review', true)).toBe(false);
    expect(state.complete(review.id, 'run-a', 'failed')).toBe(true);
    expect(state.get(review.id)?.state).toBe('failed');
    expect(state.clear(review.id, 'run-a')).toBe(true);
    expect(state.get(review.id)).toBeNull();
  });

  it('exposes only preparation review and never enables submission or My Bets verification', () => {
    const betslip = { selections: [{ fixture: 'Arsenal vs Chelsea', selection: 'Arsenal', market: 'match-winner', displayedOdds: 1.5 },
      { fixture: 'Liverpool vs Everton', selection: 'Liverpool', market: 'match-winner', displayedOdds: 1.2 }], market: 'match-winner', stakeCents: 1000,
      status: 'BETSLIP_READY', submitted: false, displayedPayoutCents: 2500,
      displayedPayoutBasis: 'stake-inclusive', betType: 'accumulator',
      potentialPayoutCents: 2500, potentialProfitCents: 1500 };
    const payload = preparationReviewPayload({ status: 'BETSLIP_READY', success: true,
      actions: [{ type: 'prepare_sports_bet', betslip }] }, 'review-id', 1234);
    expect(payload).toMatchObject({ status: 'REVIEW_READY', reviewId: 'review-id', actions: [{ betslip }] });
    expect(payload).not.toHaveProperty('verificationId');
    expect(payload?.actions[0].betslip.submitted).toBe(false);
    const unverifiedAccumulator = { ...betslip, displayedPayoutBasis: 'unverified', potentialPayoutCents: null,
      potentialProfitCents: null, bonusStatus: 'unverified', combinedOdds: 10.8, baseOdds: 10.8,
      observedBonusPercent: null, finalOdds: null, oddsBasis: 'fractional-accumulator-calculation' };
    expect(preparationReviewPayload({ status: 'BETSLIP_READY', success: true,
      actions: [{ type: 'prepare_sports_bet', betslip: unverifiedAccumulator }] }, 'x', 1)).not.toBeNull();
    for (const field of ['stakeCents', 'displayedPayoutCents', 'displayedPayoutBasis', 'potentialPayoutCents', 'potentialProfitCents']) {
      expect(preparationReviewPayload({ status: 'BETSLIP_READY', success: true,
        actions: [{ type: 'prepare_sports_bet', betslip: { ...betslip, [field]: null } }] }, 'x', 1)).toBeNull();
    }
    expect(preparationReviewPayload({ status: 'BET_SUBMISSION_SENT', success: true,
      actions: [{ type: 'prepare_sports_bet', betslip: { ...betslip, submitted: true } }] }, 'x', 1)).toBeNull();
    const single = { ...betslip, betType: 'single', selections: [betslip.selections[0]], displayedPayoutCents: 650, displayedPayoutBasis: 'sportsbook-payout',
      potentialPayoutCents: 650, potentialProfitCents: null };
    expect(preparationReviewPayload({ status: 'BETSLIP_READY', success: true,
      actions: [{ type: 'prepare_sports_bet', betslip: single }] }, 'x', 1)).not.toBeNull();
    expect(preparationReviewPayload({ status: 'BETSLIP_READY', success: true,
      actions: [{ type: 'prepare_sports_bet', betslip: { ...single, potentialPayoutCents: 1650 } }] }, 'x', 1)).toBeNull();
  });
});
