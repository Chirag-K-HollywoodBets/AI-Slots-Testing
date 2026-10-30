import type { Browser } from '@e2e-dev/web';
import { SPORTSBOOK } from './sportsbook-contract';
import { SportsPreparationError, verifySportsAmounts, type SlipSelection } from '../sports-preparation';
import { waitForBetslip } from '../sports-readiness';
import type { Screen } from 'e2e';
import { expect } from 'e2e';
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
  constructor(message: string, readonly completedSpins: number, readonly attemptedSpins: number) {
    super(message);
    this.name = 'SlotRunError';
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
  anteOn: boolean;
  win: number | null;
  nextAction: string | null;
  freeSpins: boolean;
}
 
function parseGameResponse(body: string): GameResponse {
  // Querystring-style body: "tw=0.00&balance=999.85&c=0.01&l=20&bl=0&na=s&..."
  const p = new URLSearchParams(body.trim());
  // Amounts can use thousands separators ("60,000,000.00").
  const num = (k: string) => {
    const v = p.get(k);
    if (v === null || v === '') return null;
    const n = Number(v.replace(/,/g, ''));
    return Number.isNaN(n) ? null : n;
  };
  const c = num('c');
  const l = num('l');
  return {
    balance: num('balance'),
    stake: c !== null && l !== null ? round2(c * l) : null,
    anteOn: !p.has('bl') || p.get('bl') !== '0',
    win: num('tw'),
    nextAction: p.get('na'),
    freeSpins: (num('fs') ?? 0) > 0,
  };
}
 
export function createE2EBrowserAdapter(
  browser: Browser,
  app: { open(path: string): Promise<unknown> },
  allowedOrigin: string,
  screen: Screen
): BrowserAdapter {
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
  let slotGuard: { armed: boolean; blocked: string | null; stake: number | null; requests: number; attempted: number } | null = null;
 
  /** Collects every game-service response for one spin until the game goes quiet. */
  async function collectSpin(trigger: () => Promise<void>, firstTimeoutMs = FIRST_RESPONSE_TIMEOUT_MS): Promise<GameResponse[]> {
    // allSettled, not all: if one half fails, still wait for the other so no
    // framework step is left running (that fails the test with STEP_NOT_AWAITED).
    const [waited, pressed] = await Promise.allSettled([
      browser.waitForResponse(GAME_SERVICE, { timeout: firstTimeoutMs }),
      trigger(),
    ]);
    if (pressed.status === 'rejected') throw new Error('SPIN_KEY_FAILED');
    if (waited.status === 'rejected') throw new Error('SPIN_RESPONSE_TIMEOUT');
    const first = waited.value;
 
    if (first.status !== 200) throw new Error('SPIN_RESPONSE_FAILED');
    const responses = [parseGameResponse(await first.text())];
 
    for (;;) {
      try {
        const next = await browser.waitForResponse(GAME_SERVICE, { timeout: QUIET_MS });
        if (next.status !== 200) throw new Error('SPIN_RESPONSE_FAILED');
        responses.push(parseGameResponse(await next.text()));
      } catch (error) {
        if (error instanceof Error && error.message === 'SPIN_RESPONSE_FAILED') throw error;
        return responses; // timed out waiting = spin finished
      }
    }
  }
 
  const adapter: BrowserAdapter = {
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
      const path = (ALLOWED_GAMES as Record<string, string>)[game];
      if (!path) throw new Error('GAME_NOT_ALLOWED');

      // Install the doSpin guard before loading the game. It blocks every spin
      // throughout setup and only permits the exact, armed plan stake later.
      slotGuard = { armed: false, blocked: null, stake: null, requests: 0, attempted: 0 };
      const guard = slotGuard;
      await browser.route(GAME_SERVICE, async (route) => {
        const params = new URLSearchParams(route.request.postData ?? '');
        if (params.get('action') !== 'doSpin') {
          await route.continue();
          return;
        }
        guard.requests++;
        if (guard.armed) guard.attempted++;
        const error = validateSpinRequest(route.request.postData ?? '', guard.stake ?? 0, guard.armed);
        if (error) {
          guard.blocked ??= error;
          await route.abort();
          return;
        }
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
      const gameUrl = new URL(path, origin).href;
      let navigated = false;
      for (let attempt = 1; attempt <= 2 && !navigated; attempt++) {
        try {
          await browser.goto(gameUrl);
          navigated = true;
        } catch {
          console.log(`GAME NAVIGATION attempt ${attempt} failed`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!navigated) {
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
 
      // Give the game's own loading screen time to finish before any input.
      await new Promise((r) => setTimeout(r, 15000));
      return { frameSrc: rect.host };
    },
 
    async playSlot(game: string, spins: number, stake: number) {
      // Re-check limits here too: the adapter must never trust its caller.
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
      if (gameState.stake !== stake || gameState.anteOn) {
        console.log(`BET NOT AT STAKE: game is at ${gameState.stake}${gameState.anteOn ? ' with ante bet on' : ''}, `
          + `requested ${stake}. Set it by hand in the game once; the game remembers it.`);
        await browser.unroute(GAME_SERVICE);
        slotGuard = null;
        throw new SlotRunError('BET_NOT_AT_STAKE', 0, 0);
      }
 
      // Network guard: every doSpin request is checked before it leaves the browser.
      // Outside our own spin window, or at any other stake, it is aborted.
      const results: SpinResult[] = [];
      const guard = slotGuard;
      try {
        if (!guard || guard.blocked) throw new Error(guard?.blocked ?? 'GAME_NOT_OPEN');
        guard.stake = stake;
        await verifyOrigin();
        const rect = await frameRect();
 
        const centre = { x: rect.x + rect.w * 0.5, y: rect.y + rect.h * 0.5 };
        const spinButton = { x: rect.x + rect.w * SPIN_BUTTON.fx, y: rect.y + rect.h * SPIN_BUTTON.fy };
        let previousBalance = gameState.balance;
 
        for (let i = 0; i < spins; i++) {
          let responses: GameResponse[] | null = null;
 
          // Up to 3 tries per spin, but only while the guard has seen NO spin
          // request for this spin. If one went out, never press again.
          // Tries 1 and 3 click the spin button; try 2 falls back to the Space key
          // (Space is only sometimes picked up by this game).
          for (let attempt = 1; attempt <= 3 && !responses; attempt++) {
            // Focus the game canvas. Not armed: if this click itself spins, it is blocked.
            await clickAt(centre.x, centre.y);
            await new Promise((r) => setTimeout(r, 1500));
            if (guard.blocked) throw new Error(guard.blocked);
 
            const requestsBefore = guard.requests;
            guard.armed = true;
            try {
              const useKey = attempt === 2;
              const trigger = useKey
                ? () => browser.keyboard.press('Space')
                : () => clickAt(spinButton.x, spinButton.y);
              responses = await collectSpin(trigger, 10000);
              if (useKey) console.log(`SPIN ${i + 1}: started by the Space key`);
            } catch (error) {
              // An aborted request never gets a response; report why it was aborted.
              if (guard.blocked) throw new Error(guard.blocked);
              const sent = guard.requests > requestsBefore;
              if (sent || !(error instanceof Error) || error.message !== 'SPIN_RESPONSE_TIMEOUT') {
                // A spin went out without a reply, or something else failed: stop.
                throw error;
              }
              console.log(`SPIN ${i + 1}: try ${attempt} (${attempt === 2 ? 'Space key' : 'spin button'}) sent no spin request`);
            } finally {
              guard.armed = false;
            }
          }
          if (!responses) throw new Error('SPIN_NOT_STARTED');
          if (guard.blocked) throw new Error(guard.blocked);
 
          // The spin's own response is the first one carrying a stake; a late
          // doCollect from the previous win can arrive ahead of it and has none.
          const first = responses.find((r) => r.stake !== null);
          if (!first) throw new Error('SPIN_RESPONSE_UNRECOGNISED');
          // Second check, from the server's side.
          if (first.stake !== stake || first.anteOn) throw new Error('STAKE_MISMATCH');
          if (responses.some((r) => r.freeSpins)) throw new Error('FREE_SPINS_TRIGGERED');
 
          // Win and balance come from the last responses that carry them
          // (doSpin, any tumbles, then doCollect when there was a win).
          const win = [...responses].reverse().find((r) => r.win !== null)?.win ?? 0;
          const balance = [...responses].reverse().find((r) => r.balance !== null)?.balance ?? null;
 
          if (i === 0) console.log('SPIN RESPONSE COUNT:', responses.length);
 
          // Hard check, confirmed on losing and winning spins: new balance must equal
          // previous balance - stake + win. Stop before the next spin if it doesn't.
          if (balance === null) throw new Error('BALANCE_NOT_REPORTED');
          if (previousBalance !== null) {
            const expected = round2(previousBalance - stake + win);
            if (round2(balance) !== expected) {
              console.log(`BALANCE CHECK spin ${i + 1}: expected ${expected}, got ${balance}`);
              throw new Error('BALANCE_MISMATCH');
            }
          }
 
          results.push({ stake: first.stake, win, balance });
          previousBalance = balance;
        }
      } catch (error) {
        const code = error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'SLOT_RUN_FAILED';
        throw new SlotRunError(code, results.length, guard?.attempted ?? 0);
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
