import type { Browser } from '@e2e-dev/web';
import { expect } from 'e2e';
import {
  ALLOWED_GAMES,
  ALLOWED_PATHS,
  ALLOWED_SELECTORS,
  ALLOWED_STAKES,
  MAX_SPINS,
} from '../schema';
import type { BrowserAdapter, SpinResult } from '../executor';
 
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
    anteOn: (p.get('bl') ?? '0') !== '0',
    win: num('tw'),
    nextAction: p.get('na'),
    freeSpins: (num('fs') ?? 0) > 0,
  };
}
 
export function createE2EBrowserAdapter(
  browser: Browser,
  app: { open(path: string): Promise<unknown> },
  allowedOrigin: string
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
      if (!(game in ALLOWED_GAMES)) throw new Error('GAME_NOT_ALLOWED');
      if (!Number.isInteger(spins) || spins < 1 || spins > MAX_SPINS) {
        throw new Error('SPIN_COUNT_NOT_ALLOWED');
      }
      if (!(ALLOWED_STAKES as readonly number[]).includes(stake)) {
        throw new Error('STAKE_NOT_ALLOWED');
      }
      if (process.env.ALLOW_SPINS !== '1') {
        throw new Error('SPINS_NOT_ENABLED');
      }
 
      // Never touch the bet buttons. The game must already be at the requested stake.
      if (!gameState) throw new Error('GAME_NOT_OPEN');
      if (gameState.stake !== stake || gameState.anteOn) {
        console.log(`BET NOT AT STAKE: game is at ${gameState.stake}${gameState.anteOn ? ' with ante bet on' : ''}, `
          + `requested ${stake}. Set it by hand in the game once; the game remembers it.`);
        throw new Error('BET_NOT_AT_STAKE');
      }
 
      // Network guard: every doSpin request is checked before it leaves the browser.
      // Outside our own spin window, or at any other stake, it is aborted.
      let armed = false;
      let blocked: string | null = null;
      let loggedFieldNames = false;
      let doSpinRequests = 0; // every doSpin the game tried to send, allowed or not
 
      await browser.route(GAME_SERVICE, async (route) => {
        const params = new URLSearchParams(route.request.postData ?? '');
        if (params.get('action') !== 'doSpin') {
          await route.continue();
          return;
        }
        doSpinRequests++;
        if (!loggedFieldNames) {
          console.log('SPIN REQUEST FIELDS:', [...params.keys()].filter((k) => !/key|token|session/i.test(k)).join(','));
          loggedFieldNames = true;
        }
        const c = Number(params.get('c'));
        const l = Number(params.get('l'));
        const requestStake = params.has('c') && params.has('l') ? round2(c * l) : null;
        const anteOn = (params.get('bl') ?? '0') !== '0';
 
        if (!armed) blocked ??= 'SPIN_OUTSIDE_WINDOW';
        else if (requestStake === null) blocked ??= 'STAKE_UNVERIFIED';
        else if (requestStake !== stake || anteOn) blocked ??= 'STAKE_MISMATCH';
 
        if (blocked) {
          await route.abort();
          return;
        }
        await route.continue();
      });
 
      const results: SpinResult[] = [];
      try {
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
            if (blocked) throw new Error(blocked);
 
            const requestsBefore = doSpinRequests;
            armed = true;
            try {
              const useKey = attempt === 2;
              const trigger = useKey
                ? () => browser.keyboard.press('Space')
                : () => clickAt(spinButton.x, spinButton.y);
              responses = await collectSpin(trigger, 10000);
              if (useKey) console.log(`SPIN ${i + 1}: started by the Space key`);
            } catch (error) {
              // An aborted request never gets a response; report why it was aborted.
              if (blocked) throw new Error(blocked);
              const sent = doSpinRequests > requestsBefore;
              if (sent || !(error instanceof Error) || error.message !== 'SPIN_RESPONSE_TIMEOUT') {
                // A spin went out without a reply, or something else failed: stop.
                throw error;
              }
              console.log(`SPIN ${i + 1}: try ${attempt} (${attempt === 2 ? 'Space key' : 'spin button'}) sent no spin request`);
            } finally {
              armed = false;
            }
          }
          if (!responses) throw new Error('SPIN_NOT_STARTED');
          if (blocked) throw new Error(blocked);
 
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
      } finally {
        await browser.unroute(GAME_SERVICE);
      }
 
      return results;
    },
  };
 
  return adapter;
}