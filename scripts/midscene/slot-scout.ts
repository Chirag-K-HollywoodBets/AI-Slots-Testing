import { chromium, type Browser, type Page } from 'playwright';
import { PlaywrightPageAgent } from '@midscene/web/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loginTestAccount } from '../../src/agent/test-account-login';
import { navigateToSlotGame } from '../../src/agent/slot-navigation';
import { guardSlotAction, MAX_WAGER } from '../../src/agent/slot-safety';
import {
  assessSettlementRead,
  decideSettlementPoll,
  normalizeSlotReadout,
  type SlotReadout,
} from '../../src/agent/slot-settlement';

const SITE_ORIGIN = 'https://www.hollywoodbets.net';
const GAME_ID = 'games-in-olympus';
const VIEWPORT = { width: 1024, height: 576 };
const GAME_LOAD_TIMEOUT_MS = 90_000;
const SPIN_FINISH_TIMEOUT_MS = 60_000;
const MIDSCENE_POLL_INTERVAL_MS = 4_000;
const SCOUT_MAX_SPINS = 20;
const BALANCE_SETTLEMENT_TIMEOUT_MS = 45_000;
const BALANCE_SETTLEMENT_POLL_MS = 2_000;

interface UnexpectedStates {
  freeSpinsPopup: boolean;
  bigWinScreen: boolean;
  blockingDialog: boolean;
  details: string;
}

interface SpinRecord {
  spin: number;
  balanceBefore?: number;
  bet?: number;
  win?: number;
  balanceAfter?: number;
  balanceChanged?: boolean;
  expectedBalance?: number;
  actualBalance?: number;
  reconciliation?: string;
  locateTapMs?: number;
  waitMs?: number;
  readMs?: number;
  status: string;
}

class BalanceSettlementTimeoutError extends Error {
  constructor(
    readonly lastRead: SlotReadout | undefined,
    readonly expectedBalance: number | undefined,
  ) {
    const summary = lastRead && expectedBalance !== undefined
      ? `last expected R${expectedBalance.toFixed(2)}, actual R${lastRead.balance.toFixed(2)}, win R${lastRead.win.toFixed(2)}`
      : 'no valid balance read was received';
    super(`BALANCE_SETTLEMENT_TIMEOUT after ${BALANCE_SETTLEMENT_TIMEOUT_MS}ms: ${summary}.`);
    this.name = 'BalanceSettlementTimeoutError';
  }
}

function parseArgs(): { spins: number; headed: boolean } {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const positional = args.filter((arg) => arg !== '--headed');
  if (positional.length > 1) throw new Error(`Usage: slot-scout.ts [spins: 1-${SCOUT_MAX_SPINS}] [--headed]`);
  const raw = positional[0];
  if (raw === undefined) return { spins: 1, headed };
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > SCOUT_MAX_SPINS) {
    throw new Error(`Spin count must be a whole number from 1 to ${SCOUT_MAX_SPINS}.`);
  }
  return { spins: count, headed };
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
    '{ bet: number, balance: number, win: number }, read the current bet per spin, account balance, ' +
    'and the win amount shown for the most recently completed spin. Return numeric amounts in South African rand, ' +
    'without currency symbols or text. If no win amount is shown, return win: 0.'
  ) as unknown;
  return normalizeSlotReadout(values);
}

async function waitForSettledSlotValues(
  agent: PlaywrightPageAgent,
  balanceBefore: number,
  bet: number,
  spin: number,
): Promise<SlotReadout> {
  const deadline = Date.now() + BALANCE_SETTLEMENT_TIMEOUT_MS;
  let previous: SlotReadout | undefined;
  let lastRead: SlotReadout | undefined;
  let lastExpectedBalance: number | undefined;
  let readNumber = 0;

  while (Date.now() < deadline) {
    readNumber++;
    try {
      // One aiQuery reads all three values from the same visual observation.
      const current = await readSlotValues(agent);
      lastRead = current;
      const assessment = assessSettlementRead(current, previous, balanceBefore, bet);
      lastExpectedBalance = assessment.expectedBalance;

      console.log(
        `[spin ${spin}] settlement read ${readNumber}: bet=R${current.bet.toFixed(2)}, ` +
        `balance=R${current.balance.toFixed(2)}, win=R${current.win.toFixed(2)}, ` +
        `expected=R${lastExpectedBalance.toFixed(2)}, delta=R${assessment.difference.toFixed(2)}, ` +
        `reconciled=${assessment.reconciled}, stable=${assessment.stable}`,
      );

      const decision = decideSettlementPoll(assessment, Date.now(), deadline);
      if (decision === 'settled') return current;
      if (decision === 'timeout') break;
      previous = current;
    } catch (error) {
      // A failed or malformed observation breaks the consecutive-read pair.
      previous = undefined;
      console.log(
        `[spin ${spin}] settlement read ${readNumber} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(BALANCE_SETTLEMENT_POLL_MS, remainingMs)));
    }
  }

  throw new BalanceSettlementTimeoutError(lastRead, lastExpectedBalance);
}

async function detectUnexpectedStates(agent: PlaywrightPageAgent): Promise<string[]> {
  const state = await agent.aiQuery(
    '{ freeSpinsPopup: boolean, bigWinScreen: boolean, blockingDialog: boolean, details: string }, ' +
    'check whether an unexpected game overlay is active. freeSpinsPopup is true only for a modal/popup ' +
    'about free spins that overlays the playfield; a persistent free-spins banner alone is false. ' +
    'bigWinScreen is true for an active Big Win/Mega Win style overlay. blockingDialog is true for any ' +
    'dialog or modal covering the game. Return all booleans and a short details string.'
  ) as UnexpectedStates;

  if (!state || typeof state !== 'object'
    || typeof state.freeSpinsPopup !== 'boolean'
    || typeof state.bigWinScreen !== 'boolean'
    || typeof state.blockingDialog !== 'boolean') {
    throw new Error('Midscene could not classify unexpected game states.');
  }
  const found: string[] = [];
  if (state.freeSpinsPopup) found.push('free spins popup');
  if (state.bigWinScreen) found.push('big win screen');
  if (state.blockingDialog) found.push('dialog covering the game');
  if (found.length) throw new Error(`UNEXPECTED_GAME_STATE: ${found.join(', ')}${state.details ? ` (${state.details})` : ''}`);
  return found;
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeResultsCsv(records: SpinRecord[]): Promise<void> {
  const outputPath = resolve('midscene_run/scout-results.csv');
  await mkdir(resolve('midscene_run'), { recursive: true });
  const columns: Array<keyof SpinRecord> = [
    'spin', 'balanceBefore', 'bet', 'win', 'balanceAfter', 'balanceChanged',
    'expectedBalance', 'actualBalance', 'reconciliation', 'locateTapMs', 'waitMs', 'readMs', 'status',
  ];
  const lines = [
    columns.join(','),
    ...records.map((record) => columns.map((column) => csvCell(record[column])).join(',')),
  ];
  await writeFile(outputPath, `${lines.join('\r\n')}\r\n`, 'utf8');
  console.log(`Results CSV saved: ${outputPath}`);
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
  const { spins: targetSpins, headed } = parseArgs();
  const credentials = requireEnvironment();
  let browser: Browser | undefined;
  let page: Page | undefined;
  let agent: PlaywrightPageAgent | undefined;
  let currentStep = 'launch Edge';
  let failed = false;
  let screenshotSaved = false;
  const screenshotPath = resolve('midscene_run/scout-failure.png');
  const saveFailureScreenshot = async () => {
    if (!page || screenshotSaved) return;
    try {
      await mkdir(resolve('midscene_run'), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshotSaved = true;
      console.error(`Failure screenshot saved: ${screenshotPath}`);
    } catch (screenshotError) {
      console.error(`Could not save failure screenshot: ${screenshotError instanceof Error ? screenshotError.message : String(screenshotError)}`);
    }
  };

  try {
    browser = await chromium.launch({ channel: 'msedge', headless: !headed });
    // Keep Playwright's normal 1280x720 default viewport for login/navigation.
    const context = await browser.newContext();
    const activePage = await context.newPage();
    page = activePage;

    currentStep = 'log in to the test account';
    await loginTestAccount({
      openHome: async () => { await activePage.goto(SITE_ORIGIN, { waitUntil: 'domcontentloaded' }); },
      clickLogin: async () => { await activePage.getByRole('button', { name: /log in/i }).click(); },
      waitForUsername: async () => { await activePage.locator('#Username').waitFor({ state: 'visible', timeout: 20_000 }); },
      fillUsername: async (username) => { await activePage.locator('#Username').fill(username); },
      fillPassword: async (password) => { await activePage.locator('#password').fill(password); },
      submit: async () => { await activePage.locator('#btnLogin').click(); },
      waitForSignedInUrl: async () => {
        await activePage.waitForURL(/^https:\/\/www\.hollywoodbets\.net\//, { timeout: 30_000 });
      },
      verifySignedIn: () => verifySignedIn(activePage),
    }, credentials);

    currentStep = 'open Games in Olympus';
    await navigateToSlotGame(GAME_ID, SITE_ORIGIN, (url) =>
      activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 }));

    currentStep = 'resize game viewport';
    await activePage.setViewportSize(VIEWPORT);
    // Allow the game's resize handler to redraw its canvas at the scouting size.
    await activePage.waitForTimeout(1_000);
    agent = new PlaywrightPageAgent(activePage, { cache: false });

    currentStep = 'wait for the resized game canvas to render';
    await agent.aiWaitFor(
      'The resized Games in Olympus game has finished rendering, its game canvas is visible, and the spin button is displayed.',
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
    guardSlotAction({ type: 'spin', spins: targetSpins }, { maxSpins: SCOUT_MAX_SPINS });

    let currentBalance = initial.balance;
    let currentBet = initial.bet;
    for (let index = 1; index <= targetSpins; index++) {
      const record: SpinRecord = {
        spin: index,
        balanceBefore: currentBalance,
        bet: currentBet,
        status: 'RUNNING',
      };
      records.push(record);

      try {
        if (index === 1) {
          currentStep = `spin ${index}: unexpected-state check`;
          await detectUnexpectedStates(agent);
        }

        currentStep = `spin ${index}: safety guard`;
        guardSlotAction({ type: 'wager', wager: currentBet });
        guardSlotAction({ type: 'spin', spins: index }, { maxSpins: SCOUT_MAX_SPINS });

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

        currentStep = `spin ${index}: wait for balance settlement`;
        started = performance.now();
        const after = await waitForSettledSlotValues(agent, currentBalance, currentBet, index);
        record.readMs = Math.round(performance.now() - started);
        record.win = after.win;
        record.balanceAfter = after.balance;
        record.balanceChanged = Math.round(after.balance * 100) !== Math.round(currentBalance * 100);
        record.expectedBalance = Math.round((currentBalance - currentBet + after.win) * 100) / 100;
        record.actualBalance = after.balance;
        record.reconciliation = `expected R${record.expectedBalance.toFixed(2)} vs actual R${after.balance.toFixed(2)}`;
        currentBalance = after.balance;
        currentBet = after.bet;

        currentStep = `spin ${index}: balance reconciliation`;
        const difference = Math.abs(after.balance - record.expectedBalance);
        const centTolerance = 0.01 + Number.EPSILON * 4 * Math.max(1, after.balance, record.expectedBalance);
        if (difference > centTolerance) {
          console.error(
            `Spin ${index} balance mismatch: expected R${record.expectedBalance.toFixed(2)}, ` +
            `actual R${after.balance.toFixed(2)} (bet R${record.bet!.toFixed(2)}, win R${after.win.toFixed(2)}).`,
          );
          throw new Error('BALANCE_RECONCILIATION_FAILED');
        }

        currentStep = `spin ${index}: unexpected-state check`;
        await detectUnexpectedStates(agent);
        record.status = 'PASS';
      } catch (error) {
        if (error instanceof BalanceSettlementTimeoutError && error.lastRead && error.expectedBalance !== undefined) {
          record.win = error.lastRead.win;
          record.balanceAfter = error.lastRead.balance;
          record.balanceChanged = Math.round(error.lastRead.balance * 100) !== Math.round(currentBalance * 100);
          record.expectedBalance = error.expectedBalance;
          record.actualBalance = error.lastRead.balance;
          record.reconciliation = `expected R${error.expectedBalance.toFixed(2)} vs actual R${error.lastRead.balance.toFixed(2)}`;
          console.error(
            `Spin ${index} settlement timed out: expected R${error.expectedBalance.toFixed(2)}, ` +
            `actual R${error.lastRead.balance.toFixed(2)}, win R${error.lastRead.win.toFixed(2)}.`,
          );
        }
        record.status = `FAILED: ${currentStep}`;
        throw error;
      }
    }
  } catch (error) {
    failed = true;
    console.error(`SCOUT FAILED at ${currentStep}: ${error instanceof Error ? error.message : String(error)}`);
    await saveFailureScreenshot();
  } finally {
    try {
      await writeResultsCsv(records);
    } catch (error) {
      failed = true;
      console.error(`SCOUT FAILED while writing CSV: ${error instanceof Error ? error.message : String(error)}`);
      await saveFailureScreenshot();
    }
    await agent?.destroy().catch((error: unknown) => {
      failed = true;
      console.error(`SCOUT FAILED while closing Midscene: ${error instanceof Error ? error.message : String(error)}`);
      return saveFailureScreenshot();
    });
    await browser?.close().catch((error: unknown) => {
      failed = true;
      console.error(`SCOUT FAILED while closing Edge: ${error instanceof Error ? error.message : String(error)}`);
      return saveFailureScreenshot();
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
