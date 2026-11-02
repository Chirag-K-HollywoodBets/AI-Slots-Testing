import { chromium, type Browser, type Page } from 'playwright';
import { PlaywrightPageAgent } from '@midscene/web/playwright';
import { loginTestAccount } from '../../src/agent/test-account-login';
import { navigateToSlotGame } from '../../src/agent/slot-navigation';
import { guardSlotAction, MAX_WAGER } from '../../src/agent/slot-safety';

const SITE_ORIGIN = 'https://www.hollywoodbets.net';
const GAME_ID = 'games-in-olympus';
const VIEWPORT = { width: 1024, height: 576 };
const GAME_LOAD_TIMEOUT_MS = 90_000;
const SPIN_FINISH_TIMEOUT_MS = 60_000;
const MIDSCENE_POLL_INTERVAL_MS = 4_000;

interface SlotReadout {
  bet: number;
  balance: number;
}

interface SpinRecord {
  spin: number;
  balanceBefore?: number;
  balanceAfter?: number;
  balanceChanged?: boolean;
  locateTapMs?: number;
  waitMs?: number;
  readMs?: number;
  status: string;
}

function spinCountFromArgs(): number {
  const raw = process.argv[2];
  if (raw === undefined) return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw new Error('Spin count must be a whole number from 1 to 5.');
  }
  return count;
}

function requireEnvironment(): { username: string; password: string } {
  const username = process.env.E2E_USER_HB_TEST_USERNAME;
  const password = process.env.E2E_USER_HB_TEST_PASSWORD;
  const missing = [
    !username && 'E2E_USER_HB_TEST_USERNAME',
    !password && 'E2E_USER_HB_TEST_PASSWORD',
    !process.env.MIDSCENE_MODEL_BASE_URL && 'MIDSCENE_MODEL_BASE_URL',
    !process.env.MIDSCENE_MODEL_API_KEY && 'MIDSCENE_MODEL_API_KEY',
    !process.env.MIDSCENE_MODEL_NAME && 'MIDSCENE_MODEL_NAME',
    !process.env.MIDSCENE_MODEL_FAMILY && 'MIDSCENE_MODEL_FAMILY',
  ].filter(Boolean);
  if (missing.length) throw new Error(`Missing .env settings: ${missing.join(', ')}`);
  return { username: username!, password: password! };
}

async function readSlotValues(agent: PlaywrightPageAgent): Promise<SlotReadout> {
  const values = await agent.aiQuery(
    '{ bet: number, balance: number }, read the current bet per spin and the account balance. ' +
    'Return both as numeric amounts in South African rand, without currency symbols or text.'
  ) as SlotReadout;

  if (!values || typeof values !== 'object'
    || typeof values.bet !== 'number' || !Number.isFinite(values.bet)
    || typeof values.balance !== 'number' || !Number.isFinite(values.balance)) {
    throw new Error('Midscene did not return numeric bet and balance values.');
  }
  return values;
}

async function verifySignedIn(page: Page): Promise<void> {
  const loginButton = page.getByRole('button', { name: /log in/i });
  await loginButton.waitFor({ state: 'hidden', timeout: 20_000 });
  const balance = page.locator('.account .balance-value').first();
  await balance.waitFor({ state: 'visible', timeout: 20_000 });
  const text = await balance.innerText();
  if (!/R\s?[\d\s]+,\d{2}/.test(text)) throw new Error('Signed-in balance was not displayed.');
}

async function main(): Promise<void> {
  const records: SpinRecord[] = [];
  const targetSpins = spinCountFromArgs();
  const credentials = requireEnvironment();
  let browser: Browser | undefined;
  let agent: PlaywrightPageAgent | undefined;
  let currentStep = 'launch Edge';
  let failed = false;

  try {
    browser = await chromium.launch({ channel: 'msedge', headless: false });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    currentStep = 'log in to the test account';
    await loginTestAccount({
      openHome: async () => { await page.goto(SITE_ORIGIN, { waitUntil: 'domcontentloaded' }); },
      clickLogin: async () => { await page.getByRole('button', { name: /log in/i }).click(); },
      waitForUsername: async () => { await page.locator('#Username').waitFor({ state: 'visible', timeout: 20_000 }); },
      fillUsername: async (username) => { await page.locator('#Username').fill(username); },
      fillPassword: async (password) => { await page.locator('#password').fill(password); },
      submit: async () => { await page.locator('#btnLogin').click(); },
      waitForSignedInUrl: async () => {
        await page.waitForURL(/^https:\/\/www\.hollywoodbets\.net\//, { timeout: 30_000 });
      },
      verifySignedIn: () => verifySignedIn(page),
    }, credentials);

    currentStep = 'open Games in Olympus';
    await navigateToSlotGame(GAME_ID, SITE_ORIGIN, (url) =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 }));
    agent = new PlaywrightPageAgent(page, { cache: false });

    currentStep = 'wait for the game canvas to load';
    await agent.aiWaitFor(
      'The Games in Olympus slot game has finished loading, its game canvas is visible, and the spin button is displayed.',
      { timeoutMs: GAME_LOAD_TIMEOUT_MS, checkIntervalMs: MIDSCENE_POLL_INTERVAL_MS },
    );

    currentStep = 'read initial bet and balance';
    const initial = await readSlotValues(agent);
    console.log(`Initial bet: R${initial.bet.toFixed(2)} | Balance: R${initial.balance.toFixed(2)}`);

    currentStep = 'validate wager and spin safety caps';
    if (initial.bet > MAX_WAGER) {
      throw new Error(
        `Current bet R${initial.bet.toFixed(2)} exceeds MAX_WAGER R${MAX_WAGER.toFixed(2)}; stopping without spinning.`,
      );
    }
    guardSlotAction({ type: 'wager', wager: initial.bet });
    guardSlotAction({ type: 'spin', spins: targetSpins });

    let currentBalance = initial.balance;
    for (let index = 1; index <= targetSpins; index++) {
      const record: SpinRecord = {
        spin: index,
        balanceBefore: currentBalance,
        status: 'RUNNING',
      };
      records.push(record);

      try {
        currentStep = `spin ${index}: safety guard`;
        guardSlotAction({ type: 'wager', wager: initial.bet });
        guardSlotAction({ type: 'spin', spins: index });

        currentStep = `spin ${index}: locate/tap spin button`;
        let started = performance.now();
        await agent.aiTap('the slot game spin button');
        record.locateTapMs = Math.round(performance.now() - started);

        currentStep = `spin ${index}: wait for spin to finish`;
        started = performance.now();
        await agent.aiWaitFor(
          'The current spin has finished, the reels have stopped, and its result is displayed.',
          { timeoutMs: SPIN_FINISH_TIMEOUT_MS, checkIntervalMs: MIDSCENE_POLL_INTERVAL_MS },
        );
        record.waitMs = Math.round(performance.now() - started);

        currentStep = `spin ${index}: read balance`;
        started = performance.now();
        const after = await readSlotValues(agent);
        record.readMs = Math.round(performance.now() - started);
        record.balanceAfter = after.balance;
        record.balanceChanged = Math.round(after.balance * 100) !== Math.round(currentBalance * 100);
        currentBalance = after.balance;
        record.status = 'PASS';
      } catch (error) {
        record.status = `FAILED: ${currentStep}`;
        throw error;
      }
    }
  } catch (error) {
    failed = true;
    console.error(`SCOUT FAILED at ${currentStep}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await agent?.destroy().catch((error: unknown) => {
      failed = true;
      console.error(`SCOUT FAILED while closing Midscene: ${error instanceof Error ? error.message : String(error)}`);
    });
    await browser?.close().catch((error: unknown) => {
      failed = true;
      console.error(`SCOUT FAILED while closing Edge: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  console.table(records);
  const passed = records.filter((record) => record.status === 'PASS').length;
  const average = (key: 'locateTapMs' | 'waitMs' | 'readMs') => {
    const values = records.map((record) => record[key]).filter((value): value is number => value !== undefined);
    return values.length ? `${Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)} ms` : 'n/a';
  };
  console.log(`Summary: ${passed}/${targetSpins} spins completed.`);
  console.log(`Average locate/tap: ${average('locateTapMs')} | wait: ${average('waitMs')} | read: ${average('readMs')}`);
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`SCOUT FAILED before launch: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
