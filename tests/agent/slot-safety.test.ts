import { describe, expect, it } from 'vitest';
import {
  guardSlotAction,
  isSlotDismissTargetSafe,
  MAX_SPINS,
  MAX_WAGER,
  SlotSpinResponseCounter,
} from '../../src/agent/slot-safety';

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

  it('refuses a dismissal target in the measured left feature-control column', () => {
    expect(isSlotDismissTargetSafe({ left: 0.17, top: 0.3, width: 0.04, height: 0.04 })).toBe(false);
  });

  it('allows a labelled OK target for a blocking Prize Drops modal in the bottom centre', () => {
    expect(isSlotDismissTargetSafe(
      { left: 0.46, top: 0.78, width: 0.08, height: 0.04 },
      { overlay: 'prize_drops', blocksSpin: true, targetLabel: 'OK' },
    )).toBe(true);
  });

  it('allows a labelled close target for a blocking Prize Drops modal in the bottom centre', () => {
    expect(isSlotDismissTargetSafe(
      { left: 0.46, top: 0.78, width: 0.08, height: 0.04 },
      { overlay: 'prize_drops', blocksSpin: true, targetLabel: 'close' },
    )).toBe(true);
  });

  it('refuses the bottom-centre OK target for any other overlay, nonblocking state, or unlabelled target', () => {
    const target = { left: 0.46, top: 0.78, width: 0.08, height: 0.04 };
    expect(isSlotDismissTargetSafe(target, { overlay: 'win_celebration', blocksSpin: true, targetLabel: 'OK' })).toBe(false);
    expect(isSlotDismissTargetSafe(target, { overlay: 'prize_drops', blocksSpin: false, targetLabel: 'OK' })).toBe(false);
    expect(isSlotDismissTargetSafe(target, { overlay: 'prize_drops', blocksSpin: true, targetLabel: 'other' })).toBe(false);
  });

  it.each([
    ['spin button', { left: 0.70, top: 0.88, width: 0.04, height: 0.04 }],
    ['autoplay', { left: 0.80, top: 0.88, width: 0.04, height: 0.04 }],
    ['plus bet control', { left: 0.84, top: 0.88, width: 0.02, height: 0.04 }],
    ['Buy Free Spins', { left: 0.17, top: 0.30, width: 0.04, height: 0.04 }],
    ['Double Chance', { left: 0.17, top: 0.48, width: 0.04, height: 0.04 }],
  ] as const)('refuses a dismissal target on the %s control', (_name, target) => {
    expect(isSlotDismissTargetSafe(target)).toBe(false);
  });

  it('allows a dismissal target outside the protected regions', () => {
    expect(isSlotDismissTargetSafe({ left: 0.72, top: 0.2, width: 0.04, height: 0.04 })).toBe(true);
  });

  it('accepts exactly N doSpin responses', () => {
    const counter = new SlotSpinResponseCounter(3);
    expect([counter.recordDoSpinResponse(), counter.recordDoSpinResponse(), counter.recordDoSpinResponse()])
      .toEqual([1, 2, 3]);
    expect(() => counter.assertComplete()).not.toThrow();
  });

  it('fails immediately when response N+1 arrives', () => {
    const counter = new SlotSpinResponseCounter(3);
    counter.recordDoSpinResponse();
    counter.recordDoSpinResponse();
    counter.recordDoSpinResponse();
    expect(() => counter.recordDoSpinResponse()).toThrow('EXTRA_SPIN_RESPONSE');
  });

  it('fails at completion when fewer than N doSpin responses arrived', () => {
    const counter = new SlotSpinResponseCounter(3);
    counter.recordDoSpinResponse();
    counter.recordDoSpinResponse();
    expect(() => counter.assertComplete()).toThrow('SPIN_RESPONSE_COUNT_MISMATCH');
  });
});
