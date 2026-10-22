// Read-only: loads Games in Olympus and reads the game's startup (doInit) response
// to see which bet sizes are allowed. The only click is one on the centre of the
// game to dismiss its start screen; the spin button is not in the centre.

import { test } from '@e2e-dev/web';

const GAME_URL = 'https://www.hollywoodbets.net/lobby/top-games/#/g/games-in-olympus';
const GAME_SERVICE = /\/gs2c\/.*gameService/i;

// Fields worth printing in full. Everything else is listed by name only.
const SHOW = ['action', 'sc', 'defc', 'c', 'l', 'balance', 'balance_cash', 'balance_bonus', 'currency', 'na', 'total_bet_max', 'total_bet_min', 'bls'];

test('read the allowed bet sizes', { session: 'hb-test', timeout: 240_000 }, async ({ app, browser }) => {
  const actions: string[] = [];

  // Record which game-service action each request is (doInit, doSpin, ...).
  await browser.route(GAME_SERVICE, async (route) => {
    const body = new URLSearchParams(route.request.postData ?? '');
    actions.push(body.get('action') ?? '(none)');
    if (body.get('action') === 'doSpin') {
      // Safety net: this diagnostic must never place a bet.
      await route.abort();
      return;
    }
    await route.continue();
  });

  await app.open('/');
  await new Promise((r) => setTimeout(r, 3000));

  const waitForInit = async (ms: number) => {
    try {
      const res = await browser.waitForResponse(GAME_SERVICE, { timeout: ms });
      return await res.text();
    } catch {
      return null;
    }
  };

  const initPromise = waitForInit(90_000);
  await browser.goto(GAME_URL);
  let body = await initPromise;

  if (!body) {
    // Some games only initialise after the start screen is dismissed.
    const rect = await browser.evaluate(() => {
      const found: Element[] = [];
      const walk = (root: Document | ShadowRoot) => {
        root.querySelectorAll('*').forEach((n) => {
          if (n.tagName === 'IFRAME') found.push(n);
          if (n.shadowRoot) walk(n.shadowRoot);
        });
      };
      walk(document);
      const f = found.find((x) => x.parentElement?.classList.contains('game-container'));
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (rect) {
      await browser.mouse.move(rect.x, rect.y);
      await browser.mouse.down();
      await browser.mouse.up();
      body = await waitForInit(60_000);
    }
  }

  const fields: Record<string, string> = {};
  const otherFieldNames: string[] = [];
  if (body) {
    const p = new URLSearchParams(body.trim());
    for (const k of p.keys()) {
      if (SHOW.includes(k)) fields[k] = (p.get(k) ?? '').slice(0, 200);
      else otherFieldNames.push(k);
    }
  }

  const sc = (fields.sc ?? '').split(',').map(Number).filter((n) => !Number.isNaN(n));
  const lines = Number(fields.l ?? NaN);

  console.log('BET CONFIG DIAGNOSTIC:', JSON.stringify({
    gotInitResponse: Boolean(body),
    requestActions: actions,
    fields,
    otherFieldNames: otherFieldNames.slice(0, 60),
    check: {
      lines,
      minCoin: sc.length ? Math.min(...sc) : null,
      minStake: sc.length && lines ? Math.round(Math.min(...sc) * lines * 100) / 100 : null,
      r020Possible: sc.includes(0.01) && lines === 20,
      defaultStake: fields.defc && lines ? Math.round(Number(fields.defc) * lines * 100) / 100 : null,
    },
  }, null, 2));
});
