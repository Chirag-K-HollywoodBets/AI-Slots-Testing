
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

// ---- Slot settings. Confirm each TODO with a single manual spin first. ----

// TODO: confirm the real iframe src in DevTools and narrow this selector.
const GAME_FRAME = 'iframe[src*="pragmatic" i], iframe[src*="gs2c" i], iframe[src*="game" i]';

// Pragmatic Play game server endpoint. TODO: confirm in DevTools > Network.
const SPIN_RESPONSE = /gameService/i;

// Games in Olympus pays on 20 "lines": stake = coin value (c) x lines (l).
// "-" bet button as a fraction of the iframe size. TODO: calibrate.
const MINUS_BUTTON = {
  fx: Number(process.env.MINUS_FX ?? 0.8),
  fy: Number(process.env.MINUS_FY ?? 0.9),
};

// A paid spin can return several responses (tumbles). We treat the spin as
// finished once no new response arrives for this long.
const QUIET_MS = 4000;
const FIRST_RESPONSE_TIMEOUT_MS = 30000;

const round2 = (n: number) => Math.round(n * 100) / 100;

interface SpinResponse {
  balance: number;
  stake: number;
  win: number;
  freeSpins: boolean;
}

function parseSpinResponse(body: string): SpinResponse {
  // Querystring-style body: "tw=0.00&balance=99.80&c=0.01&l=20&..."
  const p = new URLSearchParams(body);
  const num = (k: string) => Number(p.get(k) ?? NaN);
  return {
    balance: num('balance'),
    stake: round2(num('c') * num('l')),
    win: num('tw'),
    // TODO: confirm the free-spins marker for this game ("fs" in Pragmatic responses).
    freeSpins: Number(p.get('fs') ?? 0) > 0,
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

  async function frameRect() {
    const rect = await browser.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, src: el.getAttribute('src') ?? null };
    }, GAME_FRAME);

    if (!rect || rect.w === 0 || rect.h === 0) {
      throw new Error('GAME_FRAME_NOT_FOUND');
    }
    return rect;
  }

  // The framework's mouse has move/down/up only.
  async function clickAt(x: number, y: number) {
    await browser.mouse.move(x, y);
    await browser.mouse.down();
    await browser.mouse.up();
  }

  /** Collects every spin response until the game goes quiet. */
  async function collectSpin(trigger: () => Promise<void>): Promise<SpinResponse[]> {
    const [first] = await Promise.all([
      browser.waitForResponse(SPIN_RESPONSE, { timeout: FIRST_RESPONSE_TIMEOUT_MS }),
      trigger(),
    ]).catch(() => {
      throw new Error('SPIN_RESPONSE_TIMEOUT');
    });

    if (first.status !== 200) throw new Error('SPIN_RESPONSE_FAILED');
    const responses = [parseSpinResponse(await first.text())];

    for (;;) {
      try {
        const next = await browser.waitForResponse(SPIN_RESPONSE, { timeout: QUIET_MS });
        if (next.status !== 200) throw new Error('SPIN_RESPONSE_FAILED');
        responses.push(parseSpinResponse(await next.text()));
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

      await browser .goto(new URL(path, origin).href);
      await verifyOrigin();

      try {
        await expect(browser.locator(GAME_FRAME).first()).toBeVisible({ timeout: 30000 });
      } catch {
        throw new Error('GAME_FRAME_NOT_FOUND');
      }

      const rect = await frameRect();
      return { frameSrc: rect.src ? new URL(rect.src, origin).origin : null };
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

      await verifyOrigin();
      const rect = await frameRect();
      const at = (fx: number, fy: number) => ({ x: rect.x + rect.w * fx, y: rect.y + rect.h * fy });

      // Dismiss the splash screen and give the canvas keyboard focus.
      const centre = at(0.5, 0.5);
      await clickAt(centre.x, centre.y);
      await new Promise((r) => setTimeout(r, 3000));

      // Drive the bet down to the table minimum.
      const minus = at(MINUS_BUTTON.fx, MINUS_BUTTON.fy);
      for (let i = 0; i < 15; i++) await clickAt(minus.x, minus.y);

      const results: SpinResult[] = [];
      let previousBalance: number | null = null;

      for (let i = 0; i < spins; i++) {
        // Space is the desktop spin key in Pragmatic Play games.
        const responses = await collectSpin(() => browser.keyboard.press('Space'));
        const first = responses[0];
        const last = responses[responses.length - 1];

        if (i === 0) {
          // Field names only, never values. Use this to resolve the TODOs above.
          console.log('SPIN RESPONSE COUNT:', responses.length);
        }

        // Stop immediately on any stake mismatch. Never keep spinning at an unintended bet.
        if (first.stake !== stake) throw new Error('STAKE_MISMATCH');

        if (responses.some((r) => r.freeSpins)) {
          // Free spins play a different sequence. Stop and let a human look.
          throw new Error('FREE_SPINS_TRIGGERED');
        }

        // TODO: after the first manual spin, confirm whether `balance` is reported
        // before or after the win, then turn this into a hard check.
        if (previousBalance !== null) {
          const expected = round2(previousBalance - stake + last.win);
          if (round2(last.balance) !== expected) {
            console.log(`BALANCE CHECK spin ${i + 1}: expected ${expected}, got ${last.balance}`);
          }
        }

        results.push({ stake: first.stake, win: last.win, balance: last.balance });
        previousBalance = last.balance;
      }

      return results;
    },
  };

  return adapter;
}
