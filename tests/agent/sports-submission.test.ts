import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitReviewedSportsBet } from '../../src/agent/sports-submission';
import { SPORTSBOOK } from '../../src/agent/adapters/sportsbook-contract';

afterEach(() => vi.useRealTimers());

function fixture() {
  const betslip = { betType: 'single', market: 'match-winner', stakeCents: 1000,
    selections: [{ selection: 'Man City', fixture: 'MAN CITY vs BRIGHTON', displayedOdds: 0.6 }],
    displayedPayoutCents: 600 };
  const reviewedDetails = { competition: 'premier-league', betslip };
  const command = { reviewedDetails, fingerprint: createHash('sha256').update(JSON.stringify(reviewedDetails)).digest('hex') };
  const snapshot = { rows: [{ selection: 'Full Time - MAN CITY', fixture: 'MAN CITY vs BRIGHTON\n31 October 2026 | 17:00',
    odds: '0.60', text: 'Full Time - MAN CITY\n0.60\nMAN CITY vs BRIGHTON\n31 October 2026 | 17:00' }],
    stake: '10.00', payout: '6', betType: 'single', submitCount: 1, submitVisible: true,
    submitEnabled: true, bonus: null, finalOdds: null };
  const button = { count: vi.fn().mockResolvedValue(1), isVisible: vi.fn().mockResolvedValue(true),
    isEnabled: vi.fn().mockResolvedValue(true), click: vi.fn().mockResolvedValue(undefined) };
  const browser = { evaluate: vi.fn().mockImplementation(async (_fn, selectors) => selectors ? snapshot : ''),
    locator: vi.fn().mockReturnValue(button) };
  return { betslip, command, snapshot, button, browser };
}

describe('reviewed sports submission with mocked browser only', () => {
  it('uses Full Time and the dedicated odds field even when the row ends with a fixture date', async () => {
    vi.useFakeTimers();
    const { betslip, command, browser, button, snapshot } = fixture();
    const pending = submitReviewedSportsBet(browser, command, betslip);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ outcome: 'unknown' });
    expect(browser.evaluate.mock.calls[0][1]).toMatchObject({ odds: SPORTSBOOK.slipOdds,
      stakeInput: SPORTSBOOK.stakeInput, payoutInput: SPORTSBOOK.payoutInput });
    expect(browser.locator).toHaveBeenCalledWith(SPORTSBOOK.submitButton);
    expect(button.click).toHaveBeenCalledTimes(1);
  });

  it.each(['stake', 'payout', 'odds', 'market', 'selection', 'disabled', 'duplicate', 'hidden'])(
    'does not click when %s is unreadable, changed, or unavailable', async (field) => {
      const { betslip, command, browser, snapshot, button } = fixture();
      if (field === 'stake') snapshot.stake = '';
      if (field === 'payout') snapshot.payout = '';
      if (field === 'odds') snapshot.rows[0].odds = '0.65';
      if (field === 'market') snapshot.rows[0].selection = 'Half Time - MAN CITY';
      if (field === 'selection') snapshot.rows[0].selection = 'Full Time - BRIGHTON';
      if (field === 'disabled') snapshot.submitEnabled = false;
      if (field === 'duplicate') snapshot.submitCount = 2;
      if (field === 'hidden') snapshot.submitVisible = false;
      const result = await submitReviewedSportsBet(browser, command, betslip);
      expect(['blocked', 'changed']).toContain(result.outcome);
      expect(button.click).not.toHaveBeenCalled();
    });

  it('rejects a mismatched fingerprint before reading or clicking the browser', async () => {
    const { betslip, command, browser, button } = fixture();
    const result = await submitReviewedSportsBet(browser, { ...command, fingerprint: 'mismatch' }, betslip);
    expect(result.outcome).toBe('blocked');
    expect(browser.evaluate).not.toHaveBeenCalled();
    expect(button.click).not.toHaveBeenCalled();
  });

  it('reports uncertainty after a click error without retrying', async () => {
    const { betslip, command, browser, button } = fixture();
    button.click.mockRejectedValue(new Error('disconnected during click'));
    const result = await submitReviewedSportsBet(browser, command, betslip);
    expect(result.outcome).toBe('unknown');
    expect(button.click).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch after the authorization expires during revalidation', async () => {
    const { betslip, command, browser, button } = fixture();
    const result = await submitReviewedSportsBet(browser, { ...command, expiresAt: Date.now() - 1 }, betslip);
    expect(result).toMatchObject({ outcome: 'blocked' });
    expect(result.reason).toContain('expired before dispatch');
    expect(button.click).not.toHaveBeenCalled();
  });

  it('arms a bounded mutation observer before the single click and disconnects it at completion', async () => {
    vi.useFakeTimers();
    const { betslip, command, browser, button, snapshot } = fixture();
    const order: string[] = [];
    browser.evaluate.mockImplementation(async (fn: Function, argument?: unknown) => {
      if (argument && typeof argument === 'object') return snapshot;
      if (typeof argument === 'string' && fn.toString().includes('MutationObserver')) { order.push('arm'); return undefined; }
      if (typeof argument === 'string' && fn.toString().includes('snapshots.slice')) return [];
      if (typeof argument === 'string' && fn.toString().includes('observer?.disconnect')) { order.push('stop'); return undefined; }
      return '';
    });
    button.click.mockImplementation(async () => { order.push('click'); });
    const pending = submitReviewedSportsBet(browser, command, betslip);
    await vi.runAllTimersAsync();
    expect((await pending).outcome).toBe('unknown');
    expect(button.click).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['arm', 'click', 'stop']);
  });

  it('stops on a transient additional-confirmation screen without clicking through it', async () => {
    const { betslip, command, browser, button, snapshot } = fixture();
    let armed = false;
    browser.evaluate.mockImplementation(async (_fn: Function, argument?: unknown) => {
      if (argument && typeof argument === 'object') return snapshot;
      if (typeof argument === 'string' && !armed) { armed = true; return undefined; }
      if (typeof argument === 'string' && armed) return ['Please confirm changed odds'];
      return '';
    });
    const result = await submitReviewedSportsBet(browser, command, betslip);
    expect(result).toMatchObject({ outcome: 'unknown' });
    expect(result.reason).toContain('additional confirmation');
    expect(button.click).toHaveBeenCalledTimes(1);
  });

  it.each(['immediate', 'delayed', 'pre-existing'])(
    'keeps unsupported %s receipt-like text unknown without verified receipt selectors', async (timing) => {
      vi.useFakeTimers();
      const { betslip, command, browser, button, snapshot } = fixture();
      let polls = 0;
      browser.evaluate.mockImplementation(async (_fn: Function, argument?: unknown) => {
        if (argument && typeof argument === 'object') return snapshot;
        if (typeof argument === 'string' && polls++ === 0) return undefined;
        if (typeof argument === 'string') return timing === 'pre-existing' ? []
          : timing === 'immediate' || polls > 15 ? ['Bet accepted — Reference: SAFE-FIXTURE-123'] : [];
        return '';
      });
      const pending = submitReviewedSportsBet(browser, command, betslip);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ outcome: 'unknown' });
      expect(button.click).toHaveBeenCalledTimes(1);
    });
});
