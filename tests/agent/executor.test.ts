
import { describe, it, expect, vi } from 'vitest';
import {
  executePlan,
  type BrowserAdapter,
} from '../../src/agent/executor';
import { MAX_SPINS } from '../../src/agent/schema';

function mockBrowser(): BrowserAdapter {
  return {
    getPageInfo: vi.fn().mockResolvedValue({
      title: 'HollywoodBets',
      url: 'https://www.hollywoodbets.net/',
    }),
    navigateTo: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
    captureEvidence: vi.fn().mockResolvedValue(
      'evidence/test.png'
    ),
    openGame: vi.fn().mockResolvedValue({ frameSrc: 'https://example.test/game' }),
    playSlot: vi.fn().mockResolvedValue([
      { stake: 0.2, win: 0, balance: 99.8 },
      { stake: 0.2, win: 0.5, balance: 100.1 },
    ]),
    prepareSportsBet: vi.fn().mockResolvedValue({
      betType: 'single',
      selections: [{ fixture: 'Nottingham Forest vs Example FC', selection: 'Nottingham Forest', market: 'Match Result' }],
      market: 'match-winner',
      stakeCents: 500,
      status: 'BETSLIP_READY',
      submitted: false,
    }),
  };
}

describe('Browser Executor', () => {
  it('executes a valid plan', async () => {
    const browser = mockBrowser();

    const report = await executePlan(
      {
        thought: 'Verify homepage',
        actions: [
          { type: 'get_page_info' },
          { type: 'check_visible', selector: 'body' },
        ],
      },
      browser
    );

    expect(report.success).toBe(true);
    expect(report.results).toHaveLength(2);
    expect(browser.getPageInfo).toHaveBeenCalledOnce();
    expect(browser.isVisible).toHaveBeenCalledWith('body');
  });

  it('rejects disallowed navigation', async () => {
    const browser = mockBrowser();

    const report = await executePlan(
      {
        thought: 'Navigate to admin',
        actions: [
          {
            type: 'navigate_to_allowlisted_path',
            path: '/admin',
          },
        ],
      },
      browser
    );

    expect(report.success).toBe(false);
    expect(browser.navigateTo).not.toHaveBeenCalled();
  });

  it('fails when element is not visible', async () => {
  const browser = mockBrowser();

  vi.mocked(browser.isVisible).mockResolvedValue(false);

  const report = await executePlan(
    {
      thought: 'Check Live Sports event visibility',
      actions: [
        {
          type: 'check_visible',
          selector: '.match-list-item-container',
        },
      ],
    },
    browser
  );

  expect(report.success).toBe(false);
  expect(report.results).toHaveLength(1);
  expect(report.results[0].success).toBe(false);

  expect(browser.isVisible).toHaveBeenCalledWith(
    '.match-list-item-container'
  );
});

  it('stops after a failed action', async () => {
  const browser = mockBrowser();

  vi.mocked(browser.isVisible).mockResolvedValue(false);

  const report = await executePlan(
    {
      thought: 'Check multiple actions',
      actions: [
        {
          type: 'check_visible',
          selector: '.match-list-item-container',
        },
        {
          type: 'get_page_info',
        },
      ],
    },
    browser
  );

  expect(report.success).toBe(false);
  expect(report.results).toHaveLength(1);
  expect(report.results[0].success).toBe(false);

  expect(browser.isVisible).toHaveBeenCalledWith(
    '.match-list-item-container'
  );

  expect(browser.getPageInfo).not.toHaveBeenCalled();
});

  it('captures evidence', async () => {
    const browser = mockBrowser();

    const report = await executePlan(
      {
        thought: 'Capture screenshot',
        actions: [
          {
            type: 'capture_evidence',
            reason: 'Homepage verification',
          },
        ],
      },
      browser
    );

    expect(report.success).toBe(true);
    expect(browser.captureEvidence).toHaveBeenCalledWith(
      'Homepage verification'
    );
  });

  it('plays slot spins within the limits and totals them', async () => {
    const browser = mockBrowser();

    const report = await executePlan(
      {
        thought: 'Play two spins',
        actions: [
          { type: 'open_game', game: 'games-in-olympus' },
          { type: 'play_slot', game: 'games-in-olympus', spins: 2, stake: 0.2 },
        ],
      },
      browser
    );

    expect(report.success).toBe(true);
    expect(browser.playSlot).toHaveBeenCalledWith('games-in-olympus', 2, 0.2);
    expect(report.results[1].observation).toMatchObject({
      totalStaked: 0.4,
      totalWon: 0.5,
      finalBalance: 100.1,
    });
  });

  it('rejects an unsupported requested stake before opening the game', async () => {
    const browser = mockBrowser();
    const report = await executePlan({
      thought: 'Play at the requested stake',
      actions: [
        { type: 'open_game', game: 'games-in-olympus' },
        { type: 'play_slot', game: 'games-in-olympus', spins: 2, stake: 0.21 },
      ],
    }, browser);
    expect(report.success).toBe(false);
    expect(browser.openGame).not.toHaveBeenCalled();
    expect(browser.playSlot).not.toHaveBeenCalled();
  });

  it('reports a pre-spin failure as zero completed and zero attempted spins', async () => {
    const browser = mockBrowser();
    const failure = Object.assign(new Error('BET_NOT_AT_STAKE'), { completedSpins: 0, attemptedSpins: 0 });
    vi.mocked(browser.playSlot).mockRejectedValue(failure);
    const report = await executePlan({
      thought: 'Play the verified stake',
      actions: [
        { type: 'open_game', game: 'games-in-olympus' },
        { type: 'play_slot', game: 'games-in-olympus', spins: 2, stake: 0.2 },
      ],
    }, browser);
    expect(report.results[1].observation).toEqual({
      completedSpins: 0, attemptedSpins: 0, stoppedBeforeAnySpin: true,
    });
  });

  it('prepares the approved sports betslip without submitting it', async () => {
    const browser = mockBrowser();
    const report = await executePlan({
      thought: 'Prepare the requested test betslip.',
      actions: [{
        type: 'prepare_sports_bet',
        competition: 'premier-league',
        selections: [{ team: 'Arsenal' }],
        market: 'match-winner',
        stakeCents: 500,
        submit: false,
      }],
    }, browser);

    expect(report.success).toBe(true);
    expect(browser.prepareSportsBet).toHaveBeenCalledWith(
      'premier-league', [{ team: 'Arsenal' }], 'match-winner', 500, false
    );
    expect(report.results[0].observation).toMatchObject({
      status: 'BETSLIP_READY',
      submitted: false,
      stakeCents: 500,
    });
  });

  it.each([
    ['too many spins', { spins: MAX_SPINS + 1, stake: 0.2 }],
    ['zero spins', { spins: 0, stake: 0.2 }],
    ['unapproved stake', { spins: 1, stake: 5 }],
  ])('rejects %s without touching the browser', async (_name, extra) => {
    const browser = mockBrowser();

    const report = await executePlan(
      {
        thought: 'Out-of-limit request',
        actions: [{ type: 'play_slot', game: 'games-in-olympus', ...extra }],
      },
      browser
    );

    expect(report.success).toBe(false);
    expect(browser.playSlot).not.toHaveBeenCalled();
  });

  it('rejects an unknown game', async () => {
    const browser = mockBrowser();

    const report = await executePlan(
      {
        thought: 'Unknown game',
        actions: [{ type: 'open_game', game: 'book-of-dead' }],
      },
      browser
    );

    expect(report.success).toBe(false);
    expect(browser.openGame).not.toHaveBeenCalled();
  });

  it('stops after a stake mismatch reported by the adapter', async () => {
    const browser = mockBrowser();
    (browser.playSlot as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('STAKE_MISMATCH')
    );

    const report = await executePlan(
      {
        thought: 'Spin then check',
        actions: [
          { type: 'open_game', game: 'games-in-olympus' },
          { type: 'play_slot', game: 'games-in-olympus', spins: 3, stake: 0.2 },
          { type: 'get_page_info' },
        ],
      },
      browser
    );

    expect(report.success).toBe(false);
    expect(report.results).toHaveLength(2);
    expect(report.results[1].error).toBe('STAKE_MISMATCH');
    expect(browser.getPageInfo).not.toHaveBeenCalled();
  });
});
