import { describe, expect, it } from 'vitest';
import {
  assessSettlementRead,
  normalizeSlotReadout,
  type SlotReadout,
} from '../../src/agent/slot-settlement';

describe('slot balance settlement', () => {
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
});
