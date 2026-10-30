import { describe, expect, it, vi } from 'vitest';
import { createE2EBrowserAdapter } from '../../src/agent/adapters/e2e-browser';
import { SPORTSBOOK } from '../../src/agent/adapters/sportsbook-contract';
import type { SlipSelection } from '../../src/agent/sports-preparation';

vi.mock('e2e', () => ({ expect: (locator: { count(): Promise<number> }) => ({
  toBeVisible: async () => {},
  toHaveCount: async (count: number) => expect(await locator.count()).toBe(count),
}) }));

function harness({ payout = 'R110.70', failSecond = false, unreadableAfterClick = false, single = false, failBetType = false,
  legOdds = [3.00, 1.95],
  initialRows = [] as SlipSelection[] } = {}) {
  const fixtures = ['Arsenal vs Chelsea', 'Liverpool vs Everton'];
  const picks = ['Arsenal', 'Liverpool'];
  const rows = [...initialRows];
  const clicks: string[] = [];
  let stake = '';
  const option = (index: number) => ({
    count: async () => 1,
    allTextContents: async () => [`${picks[index]} ${single ? '0.65' : legOdds[index]}`],
    nth: () => ({ click: async () => {
      clicks.push(picks[index]);
      if (index === 1 && failSecond) throw new Error('click timed out');
      rows.push({ fixture: fixtures[index], selection: picks[index] });
    } }),
  });
  const events = { first: () => events, allTextContents: async () => fixtures };
  const card = { textContent: async () => 'Premier League',
    getByRole: () => ({ count: async () => 1 }), click: async () => {} };
  const cards = { first: () => cards, all: async () => [card] };
  const browser = {
    url: async () => 'https://www.hollywoodbets.net/',
    evaluate: async (_fn: unknown, selectors?: unknown) => {
      if (!selectors) return rows.length ? (single ? 'MAN CITY' : 'Multiple Accumulator') : 'Place a bet';
      if (unreadableAfterClick && clicks.length) throw new Error('disconnected');
      return [...rows];
    },
    locator: (selector: string) => {
      if (selector === SPORTSBOOK.eventName) return events;
      if (selector === SPORTSBOOK.slipItem) return { count: async () => rows.length };
      return option(selector === SPORTSBOOK.optionsForEvent(0) ? 0 : 1);
    },
  };
  const screen = {
    getByTestId: () => cards,
    getByText: (label: string) => ({ click: async () => {
      if (label === 'Single') throw new Error('Single tab does not exist');
      if (failBetType) throw new Error('control not found');
    }, isVisible: async () => true }),
    getByLabel: (label: string) => ({ count: async () => 1,
      fill: async (value: string) => { stake = value; },
      inputValue: async () => label === SPORTSBOOK.stakeLabel ? stake : payout }),
  };
  const adapter = createE2EBrowserAdapter(
    browser as unknown as Parameters<typeof createE2EBrowserAdapter>[0],
    { open: async () => {} }, 'https://www.hollywoodbets.net/',
    screen as unknown as Parameters<typeof createE2EBrowserAdapter>[3]);
  const prepare = () => adapter.prepareSportsBet('premier-league', [
    { team: 'Arsenal', opponent: 'Chelsea' }, { team: 'Liverpool', opponent: 'Everton' },
  ].slice(0, single ? 1 : 2), 'match-winner', 1000, false);
  return { prepare, clicks, rows };
}

describe('sports adapter contract', () => {
  it('preserves R6.50 payout for R10 at displayed odds 0.65 without a Single tab', async () => {
    const { prepare } = harness({ single: true, payout: 'R6.50' });
    expect(await prepare()).toMatchObject({ status: 'BETSLIP_READY', betType: 'single',
      displayedPayoutCents: 650, displayedPayoutBasis: 'sportsbook-payout',
      potentialPayoutCents: 650, potentialProfitCents: null, combinedOdds: 0.65,
      oddsBasis: 'sportsbook-displayed', payoutMultiplier: 0.65, payoutAdjustmentCents: 0 });
  });

  it('fails closed if the single payout cannot be reconciled with its fractional odds', async () => {
    const { prepare } = harness({ single: true, payout: 'R16.50' });
    await expect(prepare()).rejects.toMatchObject({ message: 'SPORTS_PAYOUT_BASIS_UNVERIFIED' });
  });

  it('identifies the failed control stage without exposing raw browser messages', async () => {
    const { prepare } = harness({ failBetType: true });
    await expect(prepare()).rejects.toMatchObject({ message: 'SPORTS_BET_TYPE_FAILED',
      preparation: { failedStage: 'SPORTS_BET_TYPE', addedSelections: [{ selection: 'Arsenal' }, { selection: 'Liverpool' }] } });
  });

  it('uses the fractional accumulator formula and does not infer bonus, payout basis or profit', async () => {
    const { prepare } = harness();
    expect(await prepare()).toMatchObject({ status: 'BETSLIP_READY', oddsBasis: 'fractional-accumulator-calculation',
      baseOdds: 10.8, combinedOdds: 10.8, displayedPayoutCents: 11070,
      finalOdds: null, observedBonusPercent: null, payoutAdjustmentCents: null,
      displayedPayoutBasis: 'unverified', potentialPayoutCents: null, potentialProfitCents: null, bonusStatus: 'unverified' });
  });

  it('reports the first added leg when the next click fails', async () => {
    const { prepare } = harness({ failSecond: true });
    await expect(prepare()).rejects.toMatchObject({ preparation: {
      addedSelections: [{ fixture: 'Arsenal vs Chelsea', selection: 'Arsenal' }],
      attemptedSelections: [{ selection: 'Arsenal' }, { selection: 'Liverpool' }],
      remainingSelections: [{ selection: 'Arsenal' }], retryRequiresEmptySlip: true,
    } });
  });

  it('refuses a retry with a partial slip without clicking another outcome', async () => {
    const { prepare, clicks } = harness({ initialRows: [{ fixture: 'Arsenal vs Chelsea', selection: 'Arsenal' }] });
    await expect(prepare()).rejects.toMatchObject({ message: 'BETSLIP_NOT_EMPTY' });
    expect(clicks).toEqual([]);
  });

  it('retains attempted picks and marks remaining contents unknown after a read failure', async () => {
    const { prepare } = harness({ unreadableAfterClick: true });
    await expect(prepare()).rejects.toMatchObject({ preparation: {
      attemptedSelections: [{ selection: 'Arsenal' }], addedSelections: [], remainingSelections: null,
    } });
  });

  it('never marks a slip ready when the payout is missing', async () => {
    const { prepare } = harness({ payout: '' });
    await expect(prepare()).rejects.toMatchObject({ message: 'SPORTS_PAYOUT_UNVERIFIED',
      preparation: { remainingSelections: [{ selection: 'Arsenal' }, { selection: 'Liverpool' }] } });
  });
});
