import { describe, expect, it } from 'vitest';
import { guardSlotAction, MAX_SPINS, MAX_WAGER } from '../../src/agent/slot-safety';

describe('slot safety caps', () => {
  it('allows a positive wager under the maximum', () => {
    expect(() => guardSlotAction({ type: 'wager', wager: MAX_WAGER / 2 })).not.toThrow();
  });

  it('rejects a wager over the maximum', () => {
    expect(() => guardSlotAction({ type: 'wager', wager: MAX_WAGER + 0.01 }))
      .toThrow('WAGER_LIMIT_EXCEEDED');
  });

  it('allows spins up to the limit', () => {
    expect(() => guardSlotAction({ type: 'spin', spins: MAX_SPINS })).not.toThrow();
  });

  it('rejects one spin past the limit', () => {
    expect(() => guardSlotAction({ type: 'spin', spins: MAX_SPINS + 1 }))
      .toThrow('SPIN_LIMIT_EXCEEDED');
  });

  it.each([-1, 0, Number.NaN])('rejects invalid wager %s', (wager) => {
    expect(() => guardSlotAction({ type: 'wager', wager })).toThrow('WAGER_LIMIT_EXCEEDED');
  });

  it.each([-1, 0, Number.NaN])('rejects invalid spin count %s', (spins) => {
    expect(() => guardSlotAction({ type: 'spin', spins })).toThrow('SPIN_LIMIT_EXCEEDED');
  });
});
