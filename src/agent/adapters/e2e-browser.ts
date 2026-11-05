import type { Browser } from '@e2e-dev/web';
import { SPORTSBOOK } from './sportsbook-contract';
import { SportsPreparationError, verifySportsAmounts, type SlipSelection } from '../sports-preparation';
import { waitForBetslip } from '../sports-readiness';
import type { Screen } from 'e2e';
import { expect } from 'e2e';
import type { PlaywrightPageAgent } from '@midscene/web/playwright';
import type { Page, Response as PlaywrightResponse } from 'playwright';
import {
  ALLOWED_GAMES,
  ALLOWED_PATHS,
  ALLOWED_SELECTORS,
  ALLOWED_STAKES,
  MAX_SPINS,
  validateSlotStake,
} from '../schema';
import type { BrowserAdapter, SpinResult, SportsBetPreview } from '../executor';
import {
  calculateAccumulatorBaseOdds,
  applyObservedAccumulatorBonus,
  payoutCentsAtDisplayedOdds,
  soccerMultiplePayoutLimitCents,
  fixtureMatchesTeams,
  parseStakeToCents,
  textContainsTeam,
  validateRequestedSelections,
  validateSportsStakeCents,
} from '../sports-fixtures';
import { SPORTS_MAX_ACCUMULATOR_SELECTIONS, SPORTS_STAKE_LIMITS } from '../schema';
import {
  guardSlotAction,
  isSlotDismissTargetSafe,
  SLOT_BOTTOM_CENTRE_GUARD,
  SLOT_DISMISS_TARGET_MARGIN,
  SLOT_NO_CLICK_ZONES,
  SlotSpinResponseCounter,
} from '../slot-safety';
import { getSlotGameUrl, navigateToSlotGameUrl } from '../slot-navigation';
import { canRetrySpin, collectResponseQuietWindow, decidePreSpinOverlay, extractSpinSettlement, persistSpinSettlement, spinBalanceMatches, spinCollectionFailureCode, spinStakeFailureCode, waitForWinCelebrationClear, winCelebrationFailureCode, type SlotOverlayType } from '../slot-run-control';
 
// ---- Slot settings ----
 
// Games in Olympus is Pragmatic Play's vs20olygames, served from a disguised host
// (e.g. *.jwzdickbwa.net). Its iframe sits in div.game-container inside the lobby's
// <bet-casino-and-slots-lobby> shadow DOM, so plain document.querySelector can't see it.
const GAME_CONTAINER_CLASS = 'game-container';
const GAME_FRAME_SRC = /\/gs2c\//i;
 
// Pragmatic Play game-server calls on any host. Confirmed by the bet-config
// diagnostic: actions doInit, doSpin, doCollect.
const GAME_SERVICE = /\/gs2c\/.*gameService/i;
 
// vs20 games use 20 lines: stake = coin value (c) x lines (l), so R0.20 = c 0.01.
// "bl" is the ante-bet flag; anything other than 0 raises the real stake.
// The game remembers the player's last bet, and doInit reports it, so we never
// click the bet buttons: we refuse to play unless the remembered bet already
// equals the requested stake, and block any spin request that doesn't match.
 
// Round spin button, as a fraction of the game iframe (measured from a
// 1280x562 game area: centre at about x 0.713, y 0.902). The "+" bet button sits
// just to its right; a misclick there cannot place a higher bet because the
// network guard aborts any spin that isn't at the requested stake.
const SPIN_BUTTON = {
  fx: Number(process.env.SPIN_BUTTON_FX ?? 0.713),
  fy: Number(process.env.SPIN_BUTTON_FY ?? 0.902),
};
 
// A paid spin can return several responses (tumbles). We treat the spin as
// finished once no new response arrives for this long.
const QUIET_MS = 4000;
const FIRST_RESPONSE_TIMEOUT_MS = 30000;
const MIDSCENE_GAME_READY_TIMEOUT_MS = 120000;
const MIDSCENE_SPIN_FINISH_TIMEOUT_MS = 120000;
const GAME_READINESS_PROMPT = 'Games in Olympus is fully loaded and the reels and spin button are visible. An overlay means a modal, popup, or dialog covering the reels or central play area; readiness is false if one is present. The persistent Prize Drops counter widget at top-left (prize count and countdown timer), Buy Free Spins and Double Chance side panels, and bottom control bar are not overlays and never block readiness.';
const STAKE_READINESS_PROMPT = 'The stake displayed in the game canvas is exactly R0.20 and ante bet is off. An overlay means a modal, popup, or dialog covering the reels or central play area; this check is false if one is present. The persistent top-left Prize Drops counter widget (prize count and countdown timer), Buy Free Spins and Double Chance side panels, and bottom control bar are not overlays and never block this check.';

/** The runner receives only read-only Midscene operations; clicks stay in this adapter. */
export type ReadOnlyMidscene = Pick<PlaywrightPageAgent, 'aiWaitFor' | 'aiAssert' | 'aiQuery' | 'aiLocate'>;
 
const round2 = (n: number) => Math.round(n * 100) / 100;

function parseDisplayedFractionalOdds(value: string): number | null {
  const matches = value.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/g);
  const last = matches?.at(-1)?.trim();
  const odds = last ? Number(last) : Number.NaN;
  return Number.isFinite(odds) && odds >= 0 ? odds : null;
}

export function validateSpinRequest(body: string, confirmedStake: number, armed: boolean): string | null {
  const params = new URLSearchParams(body);
  if (!armed) return 'SPIN_OUTSIDE_WINDOW';
  if (!params.has('c') || !params.has('l') || !params.has('bl')) return 'STAKE_UNVERIFIED';
  const coinText = params.get('c') ?? '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(coinText)) return 'STAKE_UNVERIFIED';
  const [coinWhole, coinFraction = ''] = coinText.split('.');
  const coinCents = Number(coinWhole) * 100 + Number(coinFraction.padEnd(2, '0'));
  const lines = Number(params.get('l'));
  if (!Number.isSafeInteger(coinCents) || !Number.isSafeInteger(lines)) return 'STAKE_UNVERIFIED';
  const requestCents = coinCents * lines;
  if (requestCents !== Math.round(confirmedStake * 100) || params.get('bl') !== '0') return 'STAKE_MISMATCH';
  return null;
}

export class SlotRunError extends Error {
  constructor(message: string, readonly spinsSettled: number, readonly doSpinRequestsSent: number,
    readonly doSpinResponsesReceived = 0, readonly settledSpins: SpinResult[] = [], readonly stage = 'spin',
    readonly requestGuardCounts: Array<Record<string, number>> = [], readonly settlementEvents: Array<Record<string, unknown>> = [],
    originalError?: unknown) {
    super(message, { cause: originalError });
    this.name = 'SlotRunError';
    (this as Error & { code?: string }).code = /^[A-Z0-9_]+$/.test(message) ? message : 'SLOT_RUN_FAILED';
  }
}

type SportsGuardState = { blocked: boolean; remove: () => void };

export async function installSportsSubmitGuard(browser: Browser): Promise<void> {
  await browser.evaluate(() => {
    type GuardState = { blocked: boolean; remove: () => void };
    const windowWithGuard = window as Window & { __hbSportsSubmitGuard?: GuardState };
    windowWithGuard.__hbSportsSubmitGuard?.remove();
    const state: GuardState = { blocked: false, remove: () => undefined };
    const blockSubmit = (event: Event) => {
      if (event.type === 'click') {
        const controls = event.composedPath().filter((node): node is Element =>
          node instanceof Element && node.matches('button, a, [role="button"], input[type="submit"]')
        );
        const label = controls.map((element) => [
          element.textContent ?? '',
          element.getAttribute('aria-label') ?? '',
          element.getAttribute('title') ?? '',
          (element as HTMLInputElement).value ?? '',
        ].join(' ')).join(' ').replace(/\s+/g, ' ').trim();
        if (!/\b(place|submit|confirm|accept)\b|\bbet\s+now\b/i.test(label)) return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      state.blocked = true;
    };
    const blockFormSubmit = (event: Event) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      const submitter = (event as SubmitEvent).submitter;
      const label = [
        form?.getAttribute('aria-label') ?? '',
        form?.innerText ?? '',
        submitter instanceof Element ? submitter.textContent ?? '' : '',
        submitter instanceof Element ? submitter.getAttribute('aria-label') ?? '' : '',
      ].join(' ').replace(/\s+/g, ' ').trim();
      if (!/bet\s*slip|place\s+(the\s+)?bet|submit\s+(the\s+)?bet|confirm\s+(the\s+)?bet|stake/i.test(label)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      state.blocked = true;
    };
    document.addEventListener('click', blockSubmit, true);
    document.addEventListener('submit', blockFormSubmit, true);
    state.remove = () => {
      document.removeEventListener('click', blockSubmit, true);
      document.removeEventListener('submit', blockFormSubmit, true);
    };
    windowWithGuard.__hbSportsSubmitGuard = state;
    return true;
  });
}

export async function sportsSubmitWasBlocked(browser: Browser): Promise<boolean> {
  return browser.evaluate(() =>
    Boolean((window as Window & { __hbSportsSubmitGuard?: { blocked: boolean } })
      .__hbSportsSubmitGuard?.blocked)
  );
}

export async function removeSportsSubmitGuard(browser: Browser): Promise<void> {
  await browser.evaluate(() => {
    const windowWithGuard = window as Window & { __hbSportsSubmitGuard?: SportsGuardState };
    windowWithGuard.__hbSportsSubmitGuard?.remove();
    delete windowWithGuard.__hbSportsSubmitGuard;
    return true;
  });
}
 
interface GameResponse {
  balance: number | null;
  stake: number | null;
  anteOn: boolean | null;
  win: number | null;
  nextAction: string | null;
  freeSpins: boolean;
  serverFields: { c: number | null; l: number | null; tw: number | null; balance: number | null };
}

interface SlotOverlayState {
  overlay: SlotOverlayType;
  blocksSpin: boolean;
}

function normalizeOverlayState(value: unknown): SlotOverlayState {
  if (!value || typeof value !== 'object') throw new Error('OVERLAY_STATE_INVALID');
  const record = value as Record<string, unknown>;
  const overlays = ['none', 'win_celebration', 'prize_drops', 'free_spins', 'other'];
  if (!overlays.includes(String(record.overlay)) || typeof record.blocksSpin !== 'boolean') {
    throw new Error('OVERLAY_STATE_INVALID');
  }
  return { overlay: record.overlay as SlotOverlayState['overlay'], blocksSpin: record.blocksSpin };
}

export function parseGameResponse(body: string): GameResponse {
  // Querystring-style body: "tw=0.00&balance=999.85&c=0.01&l=20&bl=0&na=s&..."
  const p = new URLSearchParams(body.trim());
  // Amounts can use thousands separators ("60,000,000.00").
  const num = (k: string) => {
    const v = p.get(k);
    if (v === null || v === '') return null;
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const c = num('c');
  const l = num('l');
  return {
    balance: num('balance'),
    stake: c !== null && l !== null ? round2(c * l) : null,
    anteOn: p.get('bl') === '0' ? false : p.get('bl') === '1' ? true : null,
    win: num('tw'),
    nextAction: p.get('na'),
    freeSpins: (num('fs') ?? 0) > 0,
    serverFields: { c, l, tw: num('tw'), balance: num('balance') },
  };
}
 
export function createE2EBrowserAdapter(
  browser: Browser,
  app: { open(path: string): Promise<unknown> },
  allowedOrigin: string,
  screen: Screen,
  midscene?: ReadOnlyMidscene,
  onSpinSettlement?: (event: { spin: number; responseIndex: number; serverFields: GameResponse['serverFields']; doSpinRequestsSent: number; doSpinResponsesReceived: number }) => Promise<void> | void,
  responsePage?: Pick<Page, 'on' | 'off'>,
): BrowserAdapter & { leaveSlotGame(): Promise<void> } {
  const origin = new URL(allowedOrigin).origin;
 
  async function verifyOrigin(): Promise<void> {
    const current = new URL(await browser.url());
 
    if (current.origin !== origin) {
      throw new Error('Browser is outside the allowed origin');
    }
  }
 
  /** Finds the game iframe, looking inside shadow DOM too. Null if not there yet. */
  async function findFrame() {
    return browser.evaluate((arg: { cls: string; src: string }) => {
      const srcRe = new RegExp(arg.src, 'i');
      const found: Element[] = [];
      const walk = (root: Document | ShadowRoot) => {
        root.querySelectorAll('*').forEach((n) => {
          if (n.tagName === 'IFRAME') found.push(n);
          if (n.shadowRoot) walk(n.shadowRoot);
        });
      };
      walk(document);
      const frame = found.find((f) =>
        f.parentElement?.classList.contains(arg.cls) || srcRe.test(f.getAttribute('src') ?? '')
      );
      if (!frame) return null;
      const r = frame.getBoundingClientRect();
      if (r.width < 300 || r.height < 200) return null;
      const src = frame.getAttribute('src') ?? '';
      let host: string | null = null;
      try { host = new URL(src, location.href).host; } catch { host = null; }
      return { x: r.x, y: r.y, w: r.width, h: r.height, host };
    }, { cls: GAME_CONTAINER_CLASS, src: GAME_FRAME_SRC.source });
  }
 
  async function frameRect() {
    const rect = await findFrame();
    if (!rect) throw new Error('GAME_FRAME_NOT_FOUND');
    return rect;
  }
 
  // The framework's mouse has move/down/up only.
  async function clickAt(x: number, y: number) {
    await browser.mouse.move(x, y);
    await browser.mouse.down();
    await browser.mouse.up();
  }

  // What doInit reported when the game was opened (the remembered bet).
  let gameState: GameResponse | null = null;
  let slotGuard: {
    armed: boolean;
    blocked: string | null;
    stake: number | null;
    requests: number;
    sent: number;
    attempted: number;
    expectedSpins: number | null;
  } | null = null;
  let slotRunSettled = false;
 
  /** Collects every game-service response for one spin until the game goes quiet. */
  async function collectSpin(
    trigger: () => Promise<void>,
    onGameResponse: (response: GameResponse) => Promise<void> | void,
    firstTimeoutMs = FIRST_RESPONSE_TIMEOUT_MS,
  ): Promise<GameResponse[]> {
    if (!responsePage) throw new Error('SPIN_RESPONSE_LISTENER_REQUIRED');
    const responses: GameResponse[] = [];
    const window = await collectResponseQuietWindow<PlaywrightResponse>(
      (listener) => {
        const onResponse = (response: PlaywrightResponse) => {
          if (GAME_SERVICE.test(response.url())) listener(response);
        };
        responsePage.on('response', onResponse);
        return () => responsePage.off('response', onResponse);
      },
      trigger,
      async (response) => {
        if (response.status() !== 200) throw new Error('SPIN_RESPONSE_FAILED');
        const parsed = parseGameResponse(await response.text());
        await onGameResponse(parsed);
        responses.push(parsed);
      },
      { firstResponseTimeoutMs: firstTimeoutMs, quietMs: QUIET_MS },
    );
    if (window.responseCount === 0) {
      if (window.triggerError !== undefined) throw new Error('SPIN_KEY_FAILED', { cause: window.triggerError });
      throw new Error('SPIN_RESPONSE_TIMEOUT');
    }
    return responses;
  }
 
  const adapter: BrowserAdapter & { leaveSlotGame(): Promise<void> } = {
    async getPageInfo() {
      await verifyOrigin();
 
      return {
        title: await browser.title(),
        url: await browser.url(),
      };
    },
 
    async navigateTo(path: string) {
      if (!(ALLOWED_PATHS as readonly string[]).includes(path)) {
        throw new Error('Navigation path is not allowlisted');
      }
 
      await verifyOrigin();
 
      await app.open(path);
 
      await verifyOrigin();
 
      const actualUrl = new URL(await browser.url());
 
      if (actualUrl.pathname !== path) {
        throw new Error(
          'Navigation did not reach the requested path'
        );
      }
    },

    async leaveSlotGame() {
      const guardRemoved = slotGuard === null;
      console.log(`SLOT EXIT GATE: ${JSON.stringify({ slotRunSettled, guardRemoved, decision: slotRunSettled && guardRemoved ? 'leave-game' : 'stop' })}`);
      if (!slotRunSettled || !guardRemoved) throw new Error('SLOT_EXIT_ORDER_INVALID');
      await app.open('/');
      await verifyOrigin();
      const currentUrl = new URL(await browser.url());
      if (currentUrl.pathname !== '/') throw new Error('LOBBY_NAVIGATION_FAILED');
    },
 
    async isVisible(selector: string): Promise<boolean> {
      await verifyOrigin();
 
      if (
        !(ALLOWED_SELECTORS as readonly string[]).includes(
          selector
        )
      ) {
        throw new Error('SELECTOR_NOT_ALLOWED');
      }
 
      try {
        await expect(
          browser.locator(selector).first()
        ).toBeVisible({ timeout: 15000 });
 
        return true;
      } catch {
        return false;
      }
    },
 
    async captureEvidence(_reason: string): Promise<string> {
      throw new Error(
        'EVIDENCE_CAPTURE_NOT_IMPLEMENTED'
      );
    },
 
    async openGame(game: string) {
      if (!midscene) throw new Error('MIDSCENE_SLOT_READER_REQUIRED');
      const gameUrl = getSlotGameUrl(game, origin);

      // Install the doSpin guard before loading the game. It blocks every spin
      // throughout setup and only permits the exact, armed plan stake later.
      slotGuard = { armed: false, blocked: null, stake: null, requests: 0, sent: 0, attempted: 0, expectedSpins: null };
      const guard = slotGuard;
      await browser.route(GAME_SERVICE, async (route) => {
        const params = new URLSearchParams(route.request.postData ?? '');
        if (params.get('action') !== 'doSpin') {
          await route.continue();
          return;
        }
        guard.requests++;
        if (guard.armed) guard.attempted++;
        if (guard.expectedSpins !== null && guard.requests > guard.expectedSpins) {
          guard.blocked ??= 'EXTRA_SPIN_REQUEST';
          await route.abort();
          return;
        }
        const error = validateSpinRequest(route.request.postData ?? '', guard.stake ?? 0, guard.armed);
        if (error) {
          guard.blocked ??= error;
          await route.abort();
          return;
        }
        guard.sent++;
        await route.continue();
      });
 
      // Let the homepage finish its own post-login navigation first; navigating
      // during it gets interrupted (seen as ENGINE_FAILURE on browser.goto).
      await new Promise((r) => setTimeout(r, 3000));
 
      // The first game-service response after opening is doInit, which reports
      // the remembered bet. Start listening before navigating. This promise is
      // always awaited below, even on failure, so no step is left running.
      const initBody = browser
        .waitForResponse(GAME_SERVICE, { timeout: 90000 })
        .then((r) => r.text())
        .catch(() => null);
 
      // browser.goto keeps the #/g/... part of the route; app.open does not.
      // One retry after a pause, in case the page was still navigating.
      try {
        await navigateToSlotGameUrl(gameUrl, (url) => browser.goto(url));
      } catch {
        await initBody; // settle the pending wait before failing
        throw new Error('GAME_NAVIGATION_FAILED');
      }
      await verifyOrigin().catch(async (error) => {
        await initBody;
        throw error;
      });
 
      // The game takes a while to appear; poll for up to 60 s.
      const started = Date.now();
      let rect = await findFrame();
      while (!rect && Date.now() - started < 60000) {
        await new Promise((r) => setTimeout(r, 2000));
        rect = await findFrame();
      }
      const body = await initBody;
      if (!rect) throw new Error('GAME_FRAME_NOT_FOUND');
 
      if (!body) throw new Error('GAME_INIT_NOT_SEEN');
      gameState = parseGameResponse(body);
      console.log('GAME STATE:', JSON.stringify({
        rememberedStake: gameState.stake,
        anteOn: gameState.anteOn,
        nextAction: gameState.nextAction,
      }));
 
      // Wait for the canvas game to be ready using Midscene's read-only APIs.
      try {
        await midscene.aiWaitFor(
          'This setup wait only verifies that the Games in Olympus canvas, reels, and spin control have initialized; it does not assess readiness for a spin. A central modal, popup, or dialog may be present and will be handled by the pre-spin overlay gate. The persistent top-left Prize Drops counter widget (prize count and countdown timer), Buy Free Spins and Double Chance side panels, and bottom control bar are not overlays.',
          { timeoutMs: MIDSCENE_GAME_READY_TIMEOUT_MS, checkIntervalMs: 2000 },
        );
      } catch (error) {
        await browser.unroute(GAME_SERVICE);
        slotGuard = null;
        throw new Error('MIDSCENE_GAME_READY_FAILED', { cause: error });
      }
      return {
        frameSrc: rect.host,
        gameState: {
          rememberedStake: gameState.stake,
          anteOn: gameState.anteOn,
          balance: gameState.balance,
          nextAction: gameState.nextAction,
        },
      };
    },
 
    async playSlot(game: string, spins: number, stake: number) {
      slotRunSettled = false;
      if (!midscene) throw new SlotRunError('MIDSCENE_SLOT_READER_REQUIRED', 0, 0);
      // Re-check limits here too: the adapter must never trust its caller.
      guardSlotAction({ type: 'spin', spins });
      guardSlotAction({ type: 'wager', wager: stake });
      if (!(game in ALLOWED_GAMES)) throw new SlotRunError('GAME_NOT_ALLOWED', 0, 0);
      if (!Number.isInteger(spins) || spins < 1 || spins > MAX_SPINS) {
        throw new SlotRunError('SPIN_COUNT_NOT_ALLOWED', 0, 0);
      }
      if (!validateSlotStake(game, stake)) {
        throw new SlotRunError('STAKE_NOT_ALLOWED', 0, 0);
      }
      if (process.env.ALLOW_SPINS !== '1') {
        await browser.unroute(GAME_SERVICE);
        slotGuard = null;
        throw new SlotRunError('SPINS_NOT_ENABLED', 0, 0);
      }
 
      // Never touch the bet buttons. The game must already be at the requested stake.
      if (!gameState) {
        await browser.unroute(GAME_SERVICE);
        slotGuard = null;
        throw new SlotRunError('GAME_NOT_OPEN', 0, 0);
      }
      if (gameState.stake !== stake || gameState.anteOn !== false) {
        console.log(`BET NOT AT STAKE: game is at ${gameState.stake}${gameState.anteOn === false ? '' : ' with ante bet on or unverifiable'}, `
          + `requested ${stake}. Set it by hand in the game once; the game remembers it.`);
        await browser.unroute(GAME_SERVICE);
        slotGuard = null;
        throw new SlotRunError('BET_NOT_AT_STAKE', 0, 0);
      }

      if (stake !== 0.2) {
        await browser.unroute(GAME_SERVICE);
        slotGuard = null;
        throw new SlotRunError('STAKE_NOT_R020', 0, 0);
      }
      // Network guard: every doSpin request is checked before it leaves the browser.
      // Outside our own spin window, or at any other stake, it is aborted.
      const results: SpinResult[] = [];
      const spinResponses = new SlotSpinResponseCounter(spins);
      const settlementEvents: Array<{ spin: number; responseIndex: number; serverFields: GameResponse['serverFields'] }> = [];
      const requestGuardCounts: Array<Record<string, number>> = [];
      const guard = slotGuard;
      let currentSpinRequestStart = guard?.requests ?? 0;
      let currentSpinNumber = 1;
      try {
        if (!guard || guard.blocked) throw new Error(guard?.blocked ?? 'GAME_NOT_OPEN');
        guard.stake = stake;
        await verifyOrigin();
        const rect = await frameRect();
 
        const spinButton = { x: rect.x + rect.w * SPIN_BUTTON.fx, y: rect.y + rect.h * SPIN_BUTTON.fy };
        let previousBalance = gameState.balance;
        guard.expectedSpins = spins;
        console.log('SLOT NO-CLICK ZONES (normalized to game iframe):', JSON.stringify({
          zones: SLOT_NO_CLICK_ZONES,
          bottomCentreDismissGuard: {
            ...SLOT_BOTTOM_CENTRE_GUARD,
            allowedOnlyWhen: { overlay: 'prize_drops', blocksSpin: true, targetLabels: ['OK'] },
          },
          dismissalTargetMargin: SLOT_DISMISS_TARGET_MARGIN,
        }));

        const queryOverlayState = async (spinNumber: number): Promise<SlotOverlayState> => {
          const raw = await midscene.aiQuery(
            '{ overlay: "none" | "win_celebration" | "prize_drops" | "free_spins" | "other", blocksSpin: boolean }, ' +
            `Before spin ${spinNumber}, an overlay means a modal, popup, or dialog covering the reels or central play area; classify whether one is present. ` +
            'The persistent top-left Prize Drops counter widget with prize count and countdown timer, Buy Free Spins and Double Chance side panels, and bottom control bar are not overlays and never block a spin. ' +
            'Use prize_drops only for the central Prize Drops modal with its title, prize pool, and orange OK button. Use free_spins for a free-spin or bonus feature. Set blocksSpin true when a modal, popup, or dialog covers the reels or central play area, even if the spin button is visible behind it. Never interact with the game.',
          ) as unknown;
          const state = normalizeOverlayState(raw);
          console.log(`SPIN ${spinNumber} OVERLAY: ${JSON.stringify(state)}`);
          return state;
        };

        const clearBlockingOverlay = async (spinNumber: number): Promise<void> => {
          const failOverlay = (detail: string) => {
            const error = new Error(detail) as Error & { code?: string; stage?: string };
            error.code = 'OVERLAY_BLOCKING';
            error.stage = `pre-spin-overlay-${spinNumber}`;
            return error;
          };
          let state = await queryOverlayState(spinNumber);
          if (state.overlay === 'win_celebration') {
            const result = await waitForWinCelebrationClear(
              () => queryOverlayState(spinNumber),
              (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
              { intervalMs: 2500, maxWaitMs: 15000, initialState: state },
            );
            state = result.state;
            console.log(`SPIN ${spinNumber} WIN CELEBRATION WAIT: ${JSON.stringify({ cleared: result.cleared, finalState: state })}`);
            if (winCelebrationFailureCode(result.cleared)) throw failOverlay(`Win celebration remained after 15000ms: ${JSON.stringify(state)}`);
          }
          const overlayDecision = decidePreSpinOverlay({ overlay: state.overlay, blocksSpin: state.blocksSpin });
          if (overlayDecision === 'spin') {
            console.log(`SPIN ${spinNumber} OVERLAY GATE: ${JSON.stringify({ decision: 'spin', state })}`);
            return;
          }
          if (state.overlay !== 'prize_drops' || !state.blocksSpin) {
            console.log(`SPIN ${spinNumber} OVERLAY GATE: ${JSON.stringify({ decision: 'stop', state })}`);
            throw failOverlay(JSON.stringify(state));
          }
          console.log(`SPIN ${spinNumber} OVERLAY GATE: ${JSON.stringify({ decision: 'dismiss-candidate', state })}`);

          for (let attempt = 1; attempt <= 1; attempt++) {
            const located = await midscene.aiLocate(
              `The orange button visibly labelled OK on the central Prize Drops modal covering the reels or central play area before spin ${spinNumber}. ` +
              'The modal has a Prize Drops title and prize pool. Return only the OK button rectangle. ' +
              'Do not locate or click the persistent top-left Prize Drops counter widget, Buy Free Spins or Double Chance side panels, bottom control bar, spin button, autoplay, plus/bet, or ante controls.',
            );
            const frame = await frameRect();
            const dpr = located.dpr ?? 1;
            if (!Number.isFinite(dpr) || dpr <= 0) throw new Error('OVERLAY_DISMISS_LOCATION_INVALID');
            const target = {
              left: (located.rect.left / dpr - frame.x) / frame.w,
              top: (located.rect.top / dpr - frame.y) / frame.h,
              width: (located.rect.width / dpr) / frame.w,
              height: (located.rect.height / dpr) / frame.h,
            };
            const whollyInBottomCentre = target.left >= SLOT_BOTTOM_CENTRE_GUARD.left
              && target.top >= SLOT_BOTTOM_CENTRE_GUARD.top
              && target.left + target.width <= SLOT_BOTTOM_CENTRE_GUARD.right
              && target.top + target.height <= SLOT_BOTTOM_CENTRE_GUARD.bottom;
            let targetLabel: string | undefined;
            if (whollyInBottomCentre && state.overlay === 'prize_drops' && state.blocksSpin) {
              const labelResult = await midscene.aiQuery(
                '{ label: "OK" | "other" }, ' +
                `Read the visible label on the orange OK button of the central Prize Drops modal before spin ${spinNumber}, centered at iframe-relative x=${(located.center[0] / dpr - frame.x) / frame.w} and y=${(located.center[1] / dpr - frame.y) / frame.h}. ` +
                'Return OK only if this is the visibly orange OK button on the modal with title and prize pool; otherwise return other.',
              ) as unknown;
              const labelRecord = labelResult && typeof labelResult === 'object'
                ? labelResult as Record<string, unknown>
                : {};
              targetLabel = typeof labelRecord.label === 'string'
                ? labelRecord.label
                : typeof labelResult === 'string'
                  ? labelResult.trim().replace(/^['"]|['"]$/g, '')
                  : undefined;
            }
            const decision = decidePreSpinOverlay({ overlay: state.overlay, blocksSpin: state.blocksSpin,
              targetInsideGuardedZone: whollyInBottomCentre, targetLabel });
            const policy = { overlay: state.overlay, blocksSpin: state.blocksSpin, targetLabel };
            const margin = SLOT_DISMISS_TARGET_MARGIN;
            const expandedTarget = {
              left: target.left - margin.x,
              top: target.top - margin.y,
              right: target.left + target.width + margin.x,
              bottom: target.top + target.height + margin.y,
            };
            const zoneDecisions = SLOT_NO_CLICK_ZONES.map((zone) => ({
              name: zone.name,
              intersects: !(expandedTarget.right <= zone.left || expandedTarget.left >= zone.right
                || expandedTarget.bottom <= zone.top || expandedTarget.top >= zone.bottom),
            }));
            const bottomCentreIntersects = !(expandedTarget.right <= SLOT_BOTTOM_CENTRE_GUARD.left
              || expandedTarget.left >= SLOT_BOTTOM_CENTRE_GUARD.right
              || expandedTarget.bottom <= SLOT_BOTTOM_CENTRE_GUARD.top
              || expandedTarget.top >= SLOT_BOTTOM_CENTRE_GUARD.bottom);
            const safe = decision === 'dismiss-prize-drops' && isSlotDismissTargetSafe(target, policy);
            const click = { x: located.center[0] / dpr, y: located.center[1] / dpr };
            console.log(`SPIN ${spinNumber} OVERLAY DISMISS DECISION: ${JSON.stringify({
              decision: safe ? 'ALLOW' : 'REFUSE',
              targetWhollyInGuardedZone: whollyInBottomCentre,
              overlay: state.overlay,
              blocksSpin: state.blocksSpin,
              targetLabel,
              target,
              click,
              clickIframe: { x: (located.center[0] / dpr - frame.x) / frame.w, y: (located.center[1] / dpr - frame.y) / frame.h },
              protectedZones: zoneDecisions,
              bottomCentreIntersects,
            })}`);
            if (!safe) {
              console.log(`SPIN ${spinNumber} OVERLAY DISMISS REFUSED: ${JSON.stringify({ ...policy, target })}`);
              throw new Error('OVERLAY_DISMISS_TARGET_PROTECTED');
            }
            console.log(`SPIN ${spinNumber} DISMISS overlay=${state.overlay} attempt=${attempt} target=${JSON.stringify(target)}`);
            await clickAt(click.x, click.y);
            state = await queryOverlayState(spinNumber);
            if (state.overlay === 'none' && !state.blocksSpin) {
              console.log(`SPIN ${spinNumber} OVERLAY VERIFY: gone`);
              return;
            }
          }
          throw failOverlay(`Prize Drops remained after dismissal: ${JSON.stringify(state)}`);
        };

        const runPreSpinReadiness = async (spinNumber: number): Promise<void> => {
          try {
            await midscene.aiWaitFor(
              GAME_READINESS_PROMPT,
              { timeoutMs: MIDSCENE_GAME_READY_TIMEOUT_MS, checkIntervalMs: 2000 },
            );
          } catch (error) {
            throw new SlotRunError('GAME_NOT_READY', results.length, guard?.sent ?? 0, spinResponses.count,
              results, `pre-spin-${spinNumber}`, requestGuardCounts, settlementEvents, error);
          }
          try {
            await midscene.aiAssert(STAKE_READINESS_PROMPT);
          } catch (error) {
            throw new SlotRunError('MIDSCENE_STAKE_ASSERT_FAILED', results.length, guard?.sent ?? 0, spinResponses.count,
              results, `pre-spin-${spinNumber}`, requestGuardCounts, settlementEvents, error);
          }
        };
 
        for (let i = 0; i < spins; i++) {
          currentSpinNumber = i + 1;
          currentSpinRequestStart = guard.requests;
          requestGuardCounts.push({ spin: i + 1, clickAttempt: 0, requestsSeen: 0, requestsSent: 0,
            responsesReceived: spinResponses.count });
          // Re-enforce the total spend cap and remembered R0.20/ante-off state at every spin boundary.
          guardSlotAction({ type: 'spin', spins: i + 1 });
          guardSlotAction({ type: 'wager', wager: stake });
          if (Math.round((i + 1) * stake * 100) > Math.round(spins * 0.2 * 100)) throw new Error('SPEND_CAP_EXCEEDED');
          if (stake !== 0.2 || gameState.stake !== stake || gameState.anteOn !== false) throw new Error('STAKE_MISMATCH');
          if (guard.blocked) throw new Error(guard.blocked);
          await clearBlockingOverlay(i + 1);
          await runPreSpinReadiness(i + 1);
          const preSpinGuard = requestGuardCounts.at(-1)!;
          preSpinGuard.requestsSeen = guard.requests - currentSpinRequestStart;
          preSpinGuard.requestsSent = guard.sent - (results.at(-1)?.doSpinRequestsSent ?? 0);
          if (guard.blocked || guard.requests !== currentSpinRequestStart) {
            throw new Error(guard.blocked ?? 'SPIN_OUTCOME_UNKNOWN');
          }
          let responses: GameResponse[] = [];
          let responseIndex = 0;
          const responseHandler = async (response: GameResponse) => {
            responseIndex++;
            const responseCount = response.stake !== null
              ? spinResponses.recordDoSpinResponse()
              : spinResponses.count;
            const event = { spin: i + 1, responseIndex, serverFields: response.serverFields };
            persistSpinSettlement(settlementEvents, event);
            console.log(`gameService response fields: ${JSON.stringify({ ...event, doSpinResponsesReceived: responseCount })}`);
            await onSpinSettlement?.({ ...event, doSpinRequestsSent: guard.sent, doSpinResponsesReceived: responseCount });
          };
          for (let clickAttempt = 0; clickAttempt < 2; clickAttempt++) {
            const requestStart = guard.requests;
            const sentStart = guard.sent;
            guard.armed = true;
            try {
              responses = await collectSpin(() => clickAt(spinButton.x, spinButton.y), responseHandler, 10000);
              requestGuardCounts.push({ spin: i + 1, clickAttempt: clickAttempt + 1,
                requestsSeen: guard.requests - requestStart, requestsSent: guard.sent - sentStart,
                responsesReceived: spinResponses.count });
              break;
            } catch (error) {
              guard.armed = false;
              const requestsForSpin = guard.requests - requestStart;
              requestGuardCounts.push({ spin: i + 1, clickAttempt: clickAttempt + 1,
                requestsSeen: requestsForSpin, requestsSent: guard.sent - sentStart,
                responsesReceived: spinResponses.count });
              if (requestsForSpin > 0) {
                const unknown = new Error(spinCollectionFailureCode(0, requestsForSpin) ?? 'SPIN_RESPONSE_TIMEOUT', { cause: error }) as Error & { code?: string; stage?: string };
                unknown.code = spinCollectionFailureCode(0, requestsForSpin) ?? 'SPIN_RESPONSE_TIMEOUT';
                unknown.stage = 'awaiting-spin-settlement';
                throw unknown;
              }
              if (clickAttempt > 0) throw error;
              console.log(`SPIN ${i + 1} NO REQUEST: rechecking overlay, readiness and stake before its single retry`);
              await clearBlockingOverlay(i + 1);
              await runPreSpinReadiness(i + 1);
              if (guard.requests !== requestStart) throw new Error('SPIN_OUTCOME_UNKNOWN');
              if (!canRetrySpin(requestsForSpin, clickAttempt, true, true)) throw error;
            } finally {
              guard.armed = false;
            }
          }
          if (guard.blocked) throw new Error(guard.blocked);
 
          // The spin's own response is the first one carrying a stake; a late
          // doCollect from the previous win can arrive ahead of it and has none.
          const extracted = extractSpinSettlement(responses);
          const first = extracted.firstStakeResponse;
          // Second check, from the server's side.
          const stakeFailure = spinStakeFailureCode(first, stake);
          if (stakeFailure || first.stake === null) throw new Error(stakeFailure ?? 'STAKE_MISMATCH');
 
          // Win and balance come from the last responses that carry those fields.
          const win = extracted.win;
          const balance = extracted.balance;
 
          // Hard check, confirmed on losing and winning spins: new balance must equal
          // previous balance - stake + win. Stop before the next spin if it doesn't.
          if (balance === null) throw new Error('BALANCE_NOT_REPORTED');
          if (previousBalance !== null) {
            const expected = round2(previousBalance - stake + win);
            if (!spinBalanceMatches(previousBalance, stake, win, balance)) {
              console.log(`BALANCE CHECK spin ${i + 1}: expected ${expected}, got ${balance}`);
              throw new Error('BALANCE_MISMATCH');
            }
          }

          console.log(`SPIN ${i + 1} SETTLED: stake=R${first.stake.toFixed(2)} win=R${win.toFixed(2)} balance=R${balance.toFixed(2)}`);
          const settled: SpinResult = {
            spin: i + 1,
            stake: first.stake,
            win,
            balance,
            serverFields: extracted.serverFields,
            doSpinRequestsSent: guard.sent,
            doSpinResponsesReceived: spinResponses.count,
            frameRect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
            spinClick: { iframe: { x: SPIN_BUTTON.fx, y: SPIN_BUTTON.fy }, page: { x: spinButton.x, y: spinButton.y } },
            requestGuardCounts: requestGuardCounts.filter((entry) => entry.spin === i + 1),
          };
          results.push(settled);
          previousBalance = balance;
          if (responses.some((r) => r.freeSpins)) {
            console.log(`SLOT RUN STOP: free spins or bonus feature triggered after spin ${i + 1}`);
            throw new Error('FREE_SPINS_TRIGGERED');
          }

          try {
            await midscene.aiWaitFor(
              `Spin number ${i + 1} has finished: all reels are stopped and win/tumble animations are settled. ` +
              'An overlay may cover the spin button, so do not require the button to be visible or active.',
              { timeoutMs: MIDSCENE_SPIN_FINISH_TIMEOUT_MS, checkIntervalMs: 1500 },
            );
          } catch (error) {
            throw new Error(`MIDSCENE_SPIN_FINISH_FAILED_${i + 1}`, { cause: error });
          }

          const afterSpinOverlay = await queryOverlayState(i + 1);
          console.log(`SPIN ${i + 1} POST-SPIN OVERLAY: ${JSON.stringify(afterSpinOverlay)}`);
          if (afterSpinOverlay.overlay === 'free_spins') throw new Error('FREE_SPINS_TRIGGERED');
          if (guard.blocked) throw new Error(guard.blocked);
        }
        spinResponses.assertComplete();
        if (guard.requests !== spins) throw new Error('SPIN_REQUEST_COUNT_MISMATCH');
        slotRunSettled = true;
      } catch (error) {
        let code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : (error as { code?: string } | null)?.code ?? 'SLOT_RUN_FAILED';
        let stage = (error as { stage?: string } | null)?.stage ?? 'spin';
        const hasParsedSpinResponse = settlementEvents.some((event) => event.spin === currentSpinNumber);
        if ((guard?.requests ?? 0) > currentSpinRequestStart && results.length < currentSpinNumber
          && (!hasParsedSpinResponse || code === 'BALANCE_NOT_REPORTED')) {
          code = 'SPIN_OUTCOME_UNKNOWN';
          stage = 'awaiting-spin-settlement';
        }
        throw new SlotRunError(code, results.length, guard?.sent ?? 0, spinResponses.count, results,
          stage, requestGuardCounts,
          settlementEvents.map((event) => ({ ...event })), error);
      } finally {
        await browser.unroute(GAME_SERVICE);
        slotGuard = null;
      }
 
      return results;
    },

    async prepareSportsBet(
      competition: string,
      selections: Array<{ team: string; opponent?: string }>,
      market: string,
      stakeCents: number,
      submit: boolean,
    ): Promise<SportsBetPreview> {
      if (competition !== 'premier-league' || selections.length === 0
        || selections.length > SPORTS_MAX_ACCUMULATOR_SELECTIONS || market !== 'match-winner'
        || !validateSportsStakeCents(stakeCents, SPORTS_STAKE_LIMITS)) {
        throw new Error('SPORTS_BET_NOT_ALLOWED');
      }
      if (submit) throw new Error('SPORTS_SUBMISSION_HANDOFF_REQUIRED');

      const attemptedSelections: SlipSelection[] = [];
      const addedSelections: SlipSelection[] = [];
      let failedStage = 'SPORTS_PAGE';
      const readSlipRows = () => browser.evaluate((selectors) =>
        Array.from(document.querySelectorAll<HTMLElement>(selectors.slipItem)).map((item) => ({
          selection: (item.querySelector<HTMLElement>(selectors.slipName)?.innerText.trim() ?? '')
            .replace(/^Full Time\s*[-–]\s*/i, ''),
          fixture: (item.querySelector<HTMLElement>(selectors.slipInfo)?.innerText.trim() ?? '')
            .split(/\r?\n/)[0]?.trim() ?? '',
        })), { slipItem: SPORTSBOOK.slipItem, slipName: SPORTSBOOK.slipName, slipInfo: SPORTSBOOK.slipInfo });
      try {
        await verifyOrigin();
        await app.open(SPORTSBOOK.route);
        await verifyOrigin();
        await expect(screen.getByTestId(SPORTSBOOK.leagueCard).first()).toBeVisible({ timeout: SPORTSBOOK.waits.page });
        const leagueCards = await screen.getByTestId(SPORTSBOOK.leagueCard).all();
        const premierLeagueCards = [];
        for (const card of leagueCards) {
          const cardText = (await card.textContent() ?? '').replace(/\s+/g, ' ').trim();
          if (!SPORTSBOOK.leagueName.test(cardText)) continue;
          if (await card.getByRole('img', { name: SPORTSBOOK.country }).count() === 1) premierLeagueCards.push(card);
        }
        if (premierLeagueCards.length !== 1) throw new Error('SPORTS_LEAGUE_NOT_UNIQUE');
        await premierLeagueCards[0].click({ timeout: SPORTSBOOK.waits.navigation });
        await expect(browser.locator(SPORTSBOOK.eventName).first()).toBeVisible({ timeout: SPORTSBOOK.waits.page });

        const fixtureNames = await browser.locator(SPORTSBOOK.eventName).allTextContents();
        const validation = validateRequestedSelections(selections, fixtureNames, SPORTS_MAX_ACCUMULATOR_SELECTIONS);
        if (!validation.ok) throw new Error(validation.reason);
        const initialSlip = await waitForBetslip(async () => {
          const body = await browser.evaluate(() => document.body.innerText);
          const rows = await readSlipRows();
          return { visible: body.includes(SPORTSBOOK.emptySlipText) || rows.length > 0, rows };
        }, SPORTSBOOK.waits.page, SPORTSBOOK.waits.poll);
        if (initialSlip.rows.length !== 0) {
          throw new Error('BETSLIP_NOT_EMPTY');
        }

        const requestedRows: Array<{ fixture: string; selection: string; fractionalOdds: number }> = [];
        failedStage = 'SPORTS_SELECTION';
        for (let index = 0; index < selections.length; index++) {
          const fixture = validation.fixtures[index];
          const requested = selections[index];
          const eventIndex = fixtureNames.findIndex((name) => name.toLocaleLowerCase() === fixture.toLocaleLowerCase());
          if (eventIndex < 0) throw new Error('SPORTS_FIXTURE_NOT_FOUND');
          const options = browser.locator(
            SPORTSBOOK.optionsForEvent(eventIndex)
          );
          const optionCount = await options.count();
          const optionTexts = await options.allTextContents();
          const matching: Array<{ optionIndex: number; odds: number }> = [];
          for (let optionIndex = 0; optionIndex < optionCount; optionIndex++) {
            const text = optionTexts[optionIndex] ?? '';
            if (!textContainsTeam(text, requested.team)) continue;
            const odds = parseDisplayedFractionalOdds(text);
            if (odds !== null) matching.push({ optionIndex, odds });
          }
          if (matching.length !== 1) throw new Error('SPORTS_OUTCOME_NOT_UNIQUE');
          const pick = { fixture, selection: requested.team };
          attemptedSelections.push(pick);
          await options.nth(matching[0].optionIndex).click({ timeout: SPORTSBOOK.waits.control });
          await expect(browser.locator(SPORTSBOOK.slipItem)).toHaveCount(index + 1, { timeout: SPORTSBOOK.waits.control });
          const rows = await readSlipRows();
          if (!rows.some((row) => textContainsTeam(row.selection, requested.team)
            && fixtureMatchesTeams(row.fixture, requested.team, requested.opponent))) {
            throw new Error('BETSLIP_NOT_VERIFIED');
          }
          addedSelections.push(pick);
          requestedRows.push({ fixture, selection: requested.team, fractionalOdds: matching[0].odds });
        }

        const betType = selections.length > 1 ? 'accumulator' : 'single';
        failedStage = 'SPORTS_BET_TYPE';
        // A one-leg slip has no Single tab. Verify its rows and stake controls below.
        if (betType === 'accumulator') {
          await screen.getByText(SPORTSBOOK.multiple, { exact: true })
            .click({ timeout: SPORTSBOOK.waits.control });
        }
        if (betType === 'accumulator'
          && await screen.getByText(SPORTSBOOK.accumulator, { exact: true }).isVisible() !== true) {
          throw new Error('BETSLIP_TYPE_NOT_VERIFIED');
        }

        failedStage = 'SPORTS_STAKE';
        const stakeField = screen.getByLabel(SPORTSBOOK.stakeLabel, { exact: true });
        if (await stakeField.count() !== 1) throw new Error('SPORTS_STAKE_CONTROL_UNVERIFIED');
        await stakeField.fill((stakeCents / 100).toFixed(2), { timeout: SPORTSBOOK.waits.control });
        const enteredStake = await stakeField.inputValue();
        if (parseStakeToCents(enteredStake) !== stakeCents) throw new Error('SPORTS_STAKE_MISMATCH');

        failedStage = 'SPORTS_SLIP_VERIFICATION';
        const bodyText = await browser.evaluate(() => document.body.innerText);
        const slipRows = await readSlipRows();
        if (slipRows.length !== selections.length) throw new Error('BETSLIP_NOT_VERIFIED');
        const unmatchedRows = [...slipRows];
        for (const requested of selections) {
          const matchIndex = unmatchedRows.findIndex((row) =>
            textContainsTeam(row.selection, requested.team)
            && fixtureMatchesTeams(row.fixture, requested.team, requested.opponent)
          );
          if (matchIndex < 0) throw new Error('BETSLIP_NOT_VERIFIED');
          unmatchedRows.splice(matchIndex, 1);
        }
        if (betType === 'single' && bodyText.includes(SPORTSBOOK.accumulator)) {
          throw new Error('BETSLIP_TYPE_NOT_VERIFIED');
        }

        const baseOdds = betType === 'single' ? requestedRows[0].fractionalOdds
          : calculateAccumulatorBaseOdds(requestedRows.map((row) => row.fractionalOdds));
        failedStage = 'SPORTS_PAYOUT';
        const displayedPayoutField = screen.getByLabel(SPORTSBOOK.payoutLabel, { exact: true });
        const displayedPayoutText = await displayedPayoutField.count() === 1
          ? await displayedPayoutField.inputValue()
          : '';
        // Preserve the sportsbook's Payout verbatim. For a single the confirmed
        // rule is displayed odds * stake; never add the stake to that amount.
        const displayedPayoutBasis = betType === 'single' ? 'sportsbook-payout' : 'unverified';
        const { payoutCents: displayedPayoutCents } = verifySportsAmounts(
          await stakeField.inputValue(), displayedPayoutText, stakeCents);
        if (baseOdds === null || baseOdds === undefined) throw new Error('SPORTS_ODDS_UNVERIFIED');
        const basePayoutCents = betType === 'single'
          ? payoutCentsAtDisplayedOdds(stakeCents, requestedRows[0].fractionalOdds) : null;
        if (betType === 'single' && (basePayoutCents === null || Math.abs(displayedPayoutCents - basePayoutCents) > 1)) {
          throw new Error('SPORTS_PAYOUT_BASIS_UNVERIFIED');
        }
        const singleLimit = soccerMultiplePayoutLimitCents(1, requestedRows.map((row) => row.fractionalOdds));
        const capped = betType === 'single'
          ? singleLimit === null ? null : {
            potentialPayoutCents: Math.min(displayedPayoutCents, singleLimit),
            potentialProfitCents: null,
            payoutLimitCents: singleLimit,
            capped: displayedPayoutCents > singleLimit,
          }
          : null;
        if (betType === 'single' && !capped) throw new Error('SOCCER_PAYOUT_LIMIT_UNAVAILABLE');

        // No stable sportsbook fields for accumulator base odds, applied bonus,
        // final odds, or payout basis are present in the verified selector contract.
        // Keep derived base math separate and never infer a bonus/profit from payout.
        const observedBonusPercent: number | null = null;
        const finalOdds = betType === 'single' ? baseOdds
          : observedBonusPercent === null ? null : applyObservedAccumulatorBonus(baseOdds, observedBonusPercent);

        return {
          betType,
          selections: requestedRows.map((row) => ({
            fixture: row.fixture,
            selection: row.selection,
            market,
            displayedOdds: row.fractionalOdds,
            ...(betType === 'accumulator' ? { decimalOdds: 1 + row.fractionalOdds } : {}),
          })),
          market,
          stakeCents,
          status: 'BETSLIP_READY',
          submitted: false,
          combinedOdds: baseOdds,
          baseOdds,
          ...(betType === 'accumulator' ? { observedBonusPercent, finalOdds } : {}),
          oddsBasis: betType === 'single' ? 'sportsbook-displayed' : 'fractional-accumulator-calculation',
          displayedPayoutCents,
          displayedPayoutBasis,
          payoutMultiplier: displayedPayoutCents / stakeCents,
          payoutAdjustmentCents: basePayoutCents === null ? null : displayedPayoutCents - basePayoutCents,
          bonusStatus: 'unverified',
          potentialPayoutCents: betType === 'single' ? capped?.potentialPayoutCents ?? null : null,
          potentialProfitCents: betType === 'single' ? capped?.potentialProfitCents ?? null : null,
          ...(capped ? { payoutLimitCents: capped.payoutLimitCents, potentialWinningsCapped: capped.capped } : {}),
        };
      } catch (error) {
        let remainingSelections: SlipSelection[] | null = null;
        try { remainingSelections = await readSlipRows(); } catch { /* Browser state is unknown. */ }
        const message = error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message : `${failedStage}_FAILED`;
        throw new SportsPreparationError(message, {
          addedSelections, attemptedSelections, remainingSelections, retryRequiresEmptySlip: true, failedStage,
        });
      }
    },
  };
 
  return adapter;
}
