import { describe, expect, it } from 'vitest';
import {
  assessSettlementRead,
  decideSettlementPoll,
  expectedSlotBalanceAfterSpins,
  normalizeSlotReadout,
  parseRand,
  type SlotReadout,
} from '../../src/agent/slot-settlement';

describe('slot balance settlement', () => {
  it('computes the final balance from the confirmed wager count and total wins', () => {
    expect(expectedSlotBalanceAfterSpins(100, 3, 0.2, 2.35)).toBe(101.75);
  });

  it.each([
    ['R 1 012,57', 1012.57],
    ['R1,012.57', 1012.57],
    ['R 0,20', 0.2],
    ['R 12 345 678,90', 12345678.9],
  ])('parses %s as %s', (value, expected) => {
    expect(parseRand(value)).toBe(expected);
  });

  it('throws for an invalid rand string', () => {
    expect(() => parseRand('not a balance')).toThrow('INVALID_RAND_AMOUNT');
  });

  it('settles the recorded spin 2 values when zero win formats vary', () => {
    const reads: unknown[] = [
      { bet: 0.2, balance: 1020.93, win: 0 },
      { bet: '0.20', balance: '1020.93', win: '0.00' },
    ];
    let previous: SlotReadout | undefined;
    let readyAt: number | undefined;

    reads.forEach((raw, index) => {
      const current = normalizeSlotReadout(raw);
      if (assessSettlementRead(current, previous, 1021.13, 0.2).ready) readyAt = index + 1;
      previous = current;
    });

    expect(readyAt).toBe(2);
  });

  it('normalizes null and undefined win values to zero', () => {
    expect(normalizeSlotReadout({ bet: 'R0.20', balance: '1,020.93', win: null }))
      .toEqual({ bet: 0.2, balance: 1020.93, win: 0 });
    expect(normalizeSlotReadout({ bet: 0.2, balance: 1020.93, win: undefined }).win).toBe(0);
  });

  it('waits for balance credit, reconciliation, and a stable balance/win pair', () => {
    const reads: unknown[] = [
      { bet: 0.2, balance: 1021.10, win: '0.13' },
      { bet: '0.20', balance: '1021.23', win: 0.13 },
      { bet: 0.2, balance: 1021.23, win: 'R0.13' },
    ];
    let previous: SlotReadout | undefined;
    const assessments = reads.map((raw) => {
      const current = normalizeSlotReadout(raw);
      const assessment = assessSettlementRead(current, previous, 1021.30, 0.2);
      previous = current;
      return assessment;
    });

    expect(assessments[0]?.reconciled).toBe(false);
    expect(assessments[1]?.reconciled).toBe(true);
    expect(assessments[1]?.stable).toBe(false);
    expect(assessments[2]?.ready).toBe(true);
  });

  it('accepts the spin 17 fourth read even when it completes after the deadline', () => {
    const reads: unknown[] = [
      { balance: 1018.24, win: 0.08, bet: 0.2 },
      { balance: 1018.24, win: 0.34, bet: 0.2 },
      { balance: 1018.63, win: 0.39, bet: 0.2 },
      { balance: 1018.63, win: 0.39, bet: 0.2 },
    ];
    const completionTimes = [5_500, 11_000, 16_500, 22_000];
    const deadline = 20_000;
    let previous: SlotReadout | undefined;
    let decision: string | undefined;

    reads.forEach((raw, index) => {
      const current = normalizeSlotReadout(raw);
      const assessment = assessSettlementRead(current, previous, 1018.44, 0.2);
      decision = decideSettlementPoll(assessment, completionTimes[index]!, deadline);
      previous = current;
    });

    expect(completionTimes[3]).toBeGreaterThan(deadline);
    expect(decision).toBe('settled');
  });
});
