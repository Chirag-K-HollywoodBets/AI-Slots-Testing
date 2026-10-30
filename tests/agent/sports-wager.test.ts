import { describe, expect, it } from 'vitest';
import {
  calculatePotential,
  calculateAccumulatorBaseOdds,
  applyObservedAccumulatorBonus,
  payoutCentsAtDisplayedOdds,
  capSoccerMultipleWinnings,
  parseDisplayedMoneyToCents,
  parseStakeToCents,
  qualifiesForSoccerMultipleWinLimit,
  soccerMultipleBonusPercent,
  soccerMultiplePayoutLimitCents,
  soccerMultipleWinLimitQualifyingLegs,
  validateRequestedSelections,
  validateSportsStakeCents,
} from '../../src/agent/sports-fixtures';

describe('sports wager validation helpers', () => {
  it('parses explicit ZAR amounts into integer cents without rounding', () => {
    expect(parseStakeToCents('50')).toBe(5000);
    expect(parseStakeToCents('50.00')).toBe(5000);
    expect(parseStakeToCents('0.05')).toBe(5);
    expect(parseStakeToCents('50.01')).toBe(5001);
    for (const value of ['', '0', '-1', '1.001', '1,00', 'R5']) expect(parseStakeToCents(value)).toBeNull();
  });

  it('parses stake-inclusive payout values with South African or international separators', () => {
    expect(parseDisplayedMoneyToCents('R54.30')).toBe(5_430);
    expect(parseDisplayedMoneyToCents('R54,32')).toBe(5_432);
    expect(parseDisplayedMoneyToCents('R1 234,56')).toBe(123_456);
    expect(parseDisplayedMoneyToCents('R1,234.56')).toBe(123_456);
    expect(parseDisplayedMoneyToCents('R1,000')).toBe(100_000);
  });

  it('enforces a verified min, increment, max and the hard R50 cap', () => {
    const limits = { minCents: 100, maxCents: 5000, incrementCents: 1 };
    expect(validateSportsStakeCents(100, limits)).toBe(true);
    expect(validateSportsStakeCents(101, limits)).toBe(true);
    expect(validateSportsStakeCents(5000, limits)).toBe(true);
    expect(validateSportsStakeCents(5001, limits)).toBe(false);
    expect(validateSportsStakeCents(99, limits)).toBe(false);
    expect(validateSportsStakeCents(101, { ...limits, incrementCents: 2 })).toBe(false);
    expect(validateSportsStakeCents(5000, null)).toBe(false);
  });

  it('resolves all exact fixtures and rejects duplicate, opposite and ambiguous legs', () => {
    const fixtures = ['Arsenal vs Chelsea', 'Liverpool vs Everton'];
    expect(validateRequestedSelections([
      { team: 'Arsenal', opponent: 'Chelsea' },
      { team: 'Liverpool', opponent: 'Everton' },
    ], fixtures, 10)).toMatchObject({ ok: true, fixtures });
    expect(validateRequestedSelections([
      { team: 'Arsenal', opponent: 'Chelsea' },
      { team: 'Arsenal', opponent: 'Chelsea' },
    ], fixtures, 10)).toMatchObject({ ok: false, reason: 'SPORTS_DUPLICATE_SELECTION' });
    expect(validateRequestedSelections([
      { team: 'Arsenal', opponent: 'Chelsea' },
      { team: 'Chelsea', opponent: 'Arsenal' },
    ], fixtures, 10)).toMatchObject({ ok: false, reason: 'SPORTS_CONFLICTING_SELECTIONS' });
    expect(validateRequestedSelections([
      { team: 'Arsenal', opponent: 'Chelsea' },
      { team: 'Liverpool', opponent: 'Everton' },
    ], fixtures, 1)).toMatchObject({ ok: false, reason: 'SPORTS_TOO_MANY_SELECTIONS' });
    expect(validateRequestedSelections([{ team: 'Arsenal' }], ['Arsenal vs Chelsea', 'Arsenal vs Spurs'], 10))
      .toMatchObject({ ok: false, reason: 'SPORTS_FIXTURE_AMBIGUOUS' });
    expect(validateRequestedSelections([{ team: 'Brighton', opponent: 'Villa' }], fixtures, 10))
      .toMatchObject({ ok: false, reason: 'SPORTS_FIXTURE_NOT_FOUND' });
    expect(validateRequestedSelections([{ team: 'Arsenal', opponent: 'Chelsea' }], fixtures, null))
      .toMatchObject({ ok: true });
    expect(validateRequestedSelections([
      { team: 'Arsenal', opponent: 'Chelsea' },
      { team: 'Liverpool', opponent: 'Everton' },
    ], fixtures, null)).toMatchObject({ ok: false, reason: 'SPORTS_ACCUMULATOR_LIMIT_UNVERIFIED' });
  });

  it('calculates combined decimal odds, payout and profit, or returns unavailable', () => {
    expect(calculatePotential(1000, [2, 1.5])).toEqual({
      combinedOdds: 3,
      potentialPayoutCents: 3000,
      potentialProfitCents: 2000,
    });
    expect(calculatePotential(1000, [])).toBeNull();
    expect(calculatePotential(1000, [0])).toBeNull();
  });

  it('uses the owner-supplied fractional accumulator formula and applies only an observed bonus', () => {
    const baseOdds = calculateAccumulatorBaseOdds([3.00, 1.95]);
    expect(baseOdds).toBe(10.8);
    const finalOdds = applyObservedAccumulatorBonus(baseOdds!, 2.5);
    expect(finalOdds).toBe(11.07);
    expect(payoutCentsAtDisplayedOdds(1000, finalOdds!)).toBe(11_070);
    expect(applyObservedAccumulatorBonus(baseOdds!, Number.NaN)).toBeNull();
    expect(calculateAccumulatorBaseOdds([3.0])).toBeNull();
  });

  it('uses the supplied soccer-multiple bonus tiers', () => {
    expect([2, 3, 4, 5, 10, 11, 15, 16, 24, 25, 50].map(soccerMultipleBonusPercent))
      .toEqual([2.5, 3, 4, 10, 10, 15, 15, 20, 20, 30, 30]);
    expect(soccerMultipleBonusPercent(1)).toBeNull();
  });

  it('enforces the odds-0.2 qualifier count for each soccer win-limit tier', () => {
    expect([2, 3, 4, 6, 8, 10, 15, 25].map(soccerMultipleWinLimitQualifyingLegs))
      .toEqual([2, 2, 3, 4, 5, 5, 7, 10]);
    expect(qualifiesForSoccerMultipleWinLimit([0.2, 0.2])).toBe(true);
    expect(qualifiesForSoccerMultipleWinLimit([0.19, 0.2])).toBe(false);
    expect(qualifiesForSoccerMultipleWinLimit([0.2, 0.2, 0.2, 0.2, 0.2, 0.19, 0.19, 0.19, 0.19, 0.19]))
      .toBe(true);
    expect(qualifiesForSoccerMultipleWinLimit([0.2, 0.2, 0.2, 0.2, 0.19, 0.19, 0.19, 0.19, 0.19, 0.19, 0.19]))
      .toBe(false);
    expect(qualifiesForSoccerMultipleWinLimit([0.2])).toBeNull();
    expect(qualifiesForSoccerMultipleWinLimit([0.2, Number.NaN])).toBeNull();
  });

  it('uses General Terms v2.29 soccer payout limits and falls back to the single cap when odds qualification fails', () => {
    expect([1, 2, 3, 4, 6, 8, 10].map((legs) => soccerMultiplePayoutLimitCents(legs, Array(legs).fill(0.2)))
    ).toEqual([30_000_000, 75_000_000, 150_000_000, 300_000_000, 500_000_000, 1_000_000_000, 1_000_000_000]);
    expect(soccerMultiplePayoutLimitCents(2, [0.19, 0.2])).toBe(30_000_000);
    expect(soccerMultiplePayoutLimitCents(10, Array(9).fill(0.2))).toBeNull();
  });

  it('treats the displayed payout as stake-inclusive and caps net winnings', () => {
    expect(capSoccerMultipleWinnings(1_000, 100_000_000, [0.2, 0.2])).toEqual({
      potentialPayoutCents: 75_001_000,
      potentialProfitCents: 75_000_000,
      payoutLimitCents: 75_000_000,
      capped: true,
    });
    expect(capSoccerMultipleWinnings(1_000, 2_000, [0.2, 0.2])).toEqual({
      potentialPayoutCents: 2_000,
      potentialProfitCents: 1_000,
      payoutLimitCents: 75_000_000,
      capped: false,
    });
    expect(capSoccerMultipleWinnings(1_000, 5_430, [0.2, 0.2])).toMatchObject({
      potentialPayoutCents: 5_430,
      potentialProfitCents: 4_430,
    });
  });
});
