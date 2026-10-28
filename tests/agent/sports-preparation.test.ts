import { describe, expect, it, vi } from 'vitest';
import { SportsPreparationError, verifySportsAmounts } from '../../src/agent/sports-preparation';
import { executePlan, type BrowserAdapter } from '../../src/agent/executor';

describe('sports preparation failures', () => {
  it.each(['', 'unavailable', '-R50', 'R0', 'RNaN', 'R10 approx'])(
    'rejects unreadable or invalid payout %s', (payout) => {
      expect(() => verifySportsAmounts('10.00', payout, 1000)).toThrow('SPORTS_PAYOUT_UNVERIFIED');
    });

  it.each(['', 'NaN', '0', '5.00', '10.001'])(
    'rejects unreadable or changed stake %s', (stake) => {
      expect(() => verifySportsAmounts(stake, 'R25.00', 1000)).toThrow('SPORTS_STAKE_MISMATCH');
    });

  it('accepts the exact stake and a verified displayed payout', () => {
    expect(verifySportsAmounts('10.00', 'R25,50', 1000)).toEqual({ stakeCents: 1000, payoutCents: 2550 });
  });

  it('preserves a displayed payout below the stake without adding the stake', () => {
    expect(verifySportsAmounts('10.00', '6.50', 1000)).toEqual({ stakeCents: 1000, payoutCents: 650 });
  });

  it.each([[], null])('preserves partial preparation and unknown remaining state: %s', async (remaining) => {
    const first = { fixture: 'Arsenal vs Chelsea', selection: 'Arsenal' };
    const second = { fixture: 'Liverpool vs Everton', selection: 'Liverpool' };
    const preparation = {
      addedSelections: [first], attemptedSelections: [first, second],
      remainingSelections: remaining, retryRequiresEmptySlip: true as const,
    };
    const prepareSportsBet = vi.fn().mockRejectedValue(new SportsPreparationError('SPORTS_PAYOUT_UNVERIFIED', preparation));
    const report = await executePlan({ thought: 'Prepare for review', actions: [{
      type: 'prepare_sports_bet', competition: 'premier-league',
      selections: [{ team: 'Arsenal', opponent: 'Chelsea' }, { team: 'Liverpool', opponent: 'Everton' }],
      market: 'match-winner', stakeCents: 1000, submit: false,
    }] }, { prepareSportsBet } as unknown as BrowserAdapter);
    expect(report.success).toBe(false);
    expect(report.results[0]).toMatchObject({ success: false, error: 'SPORTS_PAYOUT_UNVERIFIED', observation: preparation });
    expect(prepareSportsBet).toHaveBeenCalledTimes(1);
  });
});
