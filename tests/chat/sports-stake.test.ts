import { describe, expect, it } from 'vitest';
const { extractExplicitStakeCents } = require('../../chat/sports-stake.cjs') as {
  extractExplicitStakeCents: (instruction: string) => { ok: boolean; stakeCents?: number; reason?: string };
};

describe('explicit sportsbook stake parsing', () => {
  it('reads exactly one positive ZAR total in cents', () => {
    expect(extractExplicitStakeCents('Prepare an R10 accumulator')).toEqual({ ok: true, stakeCents: 1000 });
    expect(extractExplicitStakeCents('Stake 50.00 ZAR')).toEqual({ ok: true, stakeCents: 5000 });
    expect(extractExplicitStakeCents('Stake R1.01')).toEqual({ ok: true, stakeCents: 101 });
  });

  it('rejects missing, multiple, invalid, zero, and over-cap stakes', () => {
    for (const text of ['Prepare accumulator', 'R10 and R20', 'R0', 'R0.05', 'R0.99', 'R-1', 'R1.001', 'USD 5']) {
      expect(extractExplicitStakeCents(text).ok).toBe(false);
    }
    expect(extractExplicitStakeCents('R50.01').reason).toBe('SPORTS_STAKE_OVER_R50');
  });
});
