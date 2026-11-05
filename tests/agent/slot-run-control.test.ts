import { describe, expect, it, vi } from 'vitest';
import { parseGameResponse } from '../../src/agent/adapters/e2e-browser';
import {
  canRetrySpin,
  collectResponseQuietWindow,
  decidePreSpinOverlay,
  extractSpinSettlement,
  headerBalanceLagError,
  persistSpinSettlement,
  pollHeaderBalance,
  spinBalanceMatches,
  spinCollectionFailureCode,
  spinStakeFailureCode,
  type WinCelebrationState,
  waitForWinCelebrationClear,
  winCelebrationFailureCode,
} from '../../src/agent/slot-run-control';

describe('slot run controls', () => {
  it('ends normally after one doSpin response without producing SPIN_OUTCOME_UNKNOWN', async () => {
    let publish: ((response: string) => void) | undefined;
    const seen: string[] = [];
    const result = await collectResponseQuietWindow<string>(
      (listener) => { publish = listener; return () => { publish = undefined; }; },
      async () => { publish?.('doSpin'); },
      async (response) => { seen.push(response); },
      { firstResponseTimeoutMs: 50, quietMs: 2 },
    );
    expect(result).toMatchObject({ responseCount: 1, timedOut: false });
    expect(seen).toEqual(['doSpin']);
    expect(spinCollectionFailureCode(result.responseCount, 1)).toBeNull();
  });

  it('extracts and persists the one losing-spin response', () => {
    const response = parseGameResponse('action=doSpin&c=0.01&l=20&bl=0&tw=0.00&balance=99.80');
    const events: Array<{ spin: number; responseIndex: number; serverFields: typeof response.serverFields }> = [];
    persistSpinSettlement(events, { spin: 1, responseIndex: 1, serverFields: response.serverFields });
    const settlement = extractSpinSettlement([response]);
    expect(events).toEqual([{ spin: 1, responseIndex: 1, serverFields: { c: 0.01, l: 20, tw: 0, balance: 99.8 } }]);
    expect(settlement.serverFields).toHaveLength(1);
    expect(settlement.win).toBe(0);
    expect(settlement.balance).toBe(99.8);
    expect(spinBalanceMatches(100, settlement.firstStakeResponse.stake!, settlement.win, settlement.balance!)).toBe(true);
  });

  it('fails closed when a doSpin ante field is enabled, missing, or invalid', () => {
    const anteOff = parseGameResponse('action=doSpin&c=0.01&l=20&bl=0&tw=0&balance=99.80');
    const anteOn = parseGameResponse('action=doSpin&c=0.01&l=20&bl=1&tw=0&balance=99.80');
    const missingAnte = parseGameResponse('action=doSpin&c=0.01&l=20&tw=0&balance=99.80');

    expect(spinStakeFailureCode(anteOff, 0.2)).toBeNull();
    expect(spinStakeFailureCode(anteOn, 0.2)).toBe('STAKE_MISMATCH');
    expect(spinStakeFailureCode(missingAnte, 0.2)).toBe('STAKE_MISMATCH');
    expect(spinStakeFailureCode(parseGameResponse('action=doSpin&c=0.01&l=20&bl=unknown'), 0.2))
      .toBe('STAKE_MISMATCH');
  });

  it('uses the last tumble/doCollect win and balance and persists fields from every response', () => {
    const responses = [
      parseGameResponse('action=doSpin&c=0.01&l=20&bl=0&tw=0.00&balance=99.80'),
      parseGameResponse('action=doSpin&tw=0.25'),
      parseGameResponse('action=doCollect&tw=0.25&balance=100.05'),
    ];
    const settlement = extractSpinSettlement(responses);
    const events: Array<{ spin: number; responseIndex: number; serverFields: typeof responses[number]['serverFields'] }> = [];
    responses.forEach((response, index) => persistSpinSettlement(events, {
      spin: 1, responseIndex: index + 1, serverFields: response.serverFields,
    }));
    expect(settlement.firstStakeResponse.stake).toBe(0.2);
    expect(responses[0].balance).toBe(99.8); // initial doSpin balance excludes the tumble win
    expect(settlement.win).toBe(0.25);
    expect(settlement.balance).toBe(100.05);
    expect(settlement.serverFields).toHaveLength(3);
    expect(events.map((event) => event.serverFields)).toEqual(responses.map((response) => response.serverFields));
    expect(spinBalanceMatches(100, settlement.firstStakeResponse.stake!, settlement.win, settlement.balance!)).toBe(true);
  });

  it('allows only a positively identified guarded Prize Drops target or no overlay', () => {
    expect(decidePreSpinOverlay({ overlay: 'prize_drops', blocksSpin: true, targetInsideGuardedZone: true, targetLabel: 'OK' }))
      .toBe('dismiss-prize-drops');
    expect(decidePreSpinOverlay({ overlay: 'prize_drops', blocksSpin: true, targetInsideGuardedZone: true, targetLabel: 'close' })).toBe('stop');
    expect(decidePreSpinOverlay({ overlay: 'prize_drops', blocksSpin: true, targetInsideGuardedZone: false, targetLabel: 'OK' })).toBe('stop');
    expect(decidePreSpinOverlay({ overlay: 'other', blocksSpin: true })).toBe('stop');
    expect(decidePreSpinOverlay({ overlay: 'none', blocksSpin: false })).toBe('spin');
  });

  it('allows the one retry only when no request was seen and readiness and stake pass', () => {
    expect(canRetrySpin(0, 0, true, true)).toBe(true);
    expect(canRetrySpin(1, 0, true, true)).toBe(false);
    expect(canRetrySpin(0, 1, true, true)).toBe(false);
    expect(canRetrySpin(0, 0, false, true)).toBe(false);
    expect(canRetrySpin(0, 0, true, false)).toBe(false);
  });

  it('marks an unresolved sent request as outcome unknown', () => {
    expect(spinCollectionFailureCode(0, 1)).toBe('SPIN_OUTCOME_UNKNOWN');
    expect(spinCollectionFailureCode(0, 0)).toBe('SPIN_RESPONSE_TIMEOUT');
  });

  it('waits passively for a win celebration to clear and then continues', async () => {
    const states: WinCelebrationState[] = [
      { overlay: 'win_celebration', blocksSpin: true },
      { overlay: 'none', blocksSpin: false },
    ];
    const read = vi.fn(async (): Promise<WinCelebrationState> => states.shift() ?? { overlay: 'none', blocksSpin: false });
    const pause = vi.fn(async () => undefined);
    const click = vi.fn();
    const result = await waitForWinCelebrationClear(read, pause, { intervalMs: 2500, maxWaitMs: 15000 });
    expect(result).toMatchObject({ cleared: true, state: { overlay: 'none' } });
    expect(pause).toHaveBeenCalledWith(2500);
    expect(click).not.toHaveBeenCalled();
    expect(winCelebrationFailureCode(result.cleared)).toBeNull();
  });

  it('hands any newly visible overlay to the full pre-spin gate after celebration clears', async () => {
    const states: WinCelebrationState[] = [
      { overlay: 'win_celebration', blocksSpin: true },
      { overlay: 'prize_drops', blocksSpin: true },
    ];
    const result = await waitForWinCelebrationClear(
      async () => states.shift() ?? { overlay: 'none', blocksSpin: false }, async () => undefined,
      { intervalMs: 2500, maxWaitMs: 15000 },
    );
    expect(result).toMatchObject({ cleared: true, state: { overlay: 'prize_drops', blocksSpin: true } });
  });

  it('reports OVERLAY_BLOCKING when the win celebration persists without clicking', async () => {
    const read = vi.fn(async (): Promise<WinCelebrationState> => ({ overlay: 'win_celebration', blocksSpin: true }));
    const pause = vi.fn(async () => undefined);
    const click = vi.fn();
    const result = await waitForWinCelebrationClear(read, pause, { intervalMs: 2500, maxWaitMs: 5000 });
    expect(result.cleared).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
    expect(pause).toHaveBeenCalledTimes(2);
    expect(winCelebrationFailureCode(result.cleared)).toBe('OVERLAY_BLOCKING');
    expect(click).not.toHaveBeenCalled();
  });

  it('polls until the server balance reaches the header and reports lag on timeout', async () => {
    const values = [100, 99.8];
    const settled = await pollHeaderBalance(async () => values.shift() ?? 99.8, 99.8,
      { timeoutMs: 20, intervalMs: 1, pause: async () => undefined });
    expect(settled).toEqual({ matched: true, lastValue: 99.8 });

    let now = 0;
    const lag = await pollHeaderBalance(async () => 100, 99.8,
      { timeoutMs: 2, intervalMs: 1, now: () => now, pause: async (ms) => { now += ms; } });
    expect(lag).toEqual({ matched: false, lastValue: 100 });
    expect(headerBalanceLagError(lag.lastValue, 99.8)).toMatchObject({
      code: 'HEADER_BALANCE_LAG', stage: 'header-balance-poll',
      message: 'HEADER_BALANCE_LAG: header=100; server=99.8',
    });
  });
});
