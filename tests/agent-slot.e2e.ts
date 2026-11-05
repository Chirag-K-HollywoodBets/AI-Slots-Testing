// Runs an already-planned, user-confirmed casino plan as the signed-in test account.
// Started by chat/server.cjs only after the user confirms. Never plans by itself.

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { randomUUID } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import { PlaywrightPageAgent } from '@midscene/web/playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { executePlan, type ActionResult, type SuccessfulPlaySlotActionResult } from '../src/agent/executor';
import { isWagerPlan, needsAuth, PlannerPlanSchema } from '../src/agent/schema';
import { createE2EBrowserAdapter, type ReadOnlyMidscene } from '../src/agent/adapters/e2e-browser';
import { parseRand, settleSlotObservation, type SlotObservation } from '../src/agent/slot-settlement';
import { configureMidsceneModel, logMidsceneModelConfig } from '../src/agent/midscene-model';

const SITE_URL = 'https://www.hollywoodbets.net/';

function isSuccessfulSlotResult(result: ActionResult): result is SuccessfulPlaySlotActionResult {
  return result.action.type === 'play_slot' && result.success;
}
const CDP_ENDPOINT = 'http://127.0.0.1:9223';
type MidsceneTimeout = number | 'Midscene default';

async function runPhase<T>(name: string, action: () => Promise<T>): Promise<T> {
  console.log(`PHASE START: ${name}`);
  try {
    const result = await action();
    console.log(`PHASE COMPLETE: ${name}`);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`PHASE FAILED: ${name}: ${detail}`);
    throw new Error(`PHASE FAILED: ${name}: ${detail}`);
  }
}

function redactModelSecret(text: string): string {
  const secrets = [
    process.env.MIDSCENE_MODEL_API_KEY,
    process.env.LLM_API_KEY,
    process.env.E2E_USER_HB_TEST_USERNAME,
    process.env.E2E_USER_HB_TEST_PASSWORD,
  ].filter(
    (value): value is string => Boolean(value),
  );
  return secrets.reduce((safe, secret) => safe.replaceAll(secret, '[REDACTED]'), text);
}

function midsceneErrorDetails(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return { cause: '[cause depth limit]' };
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const response = record.response && typeof record.response === 'object'
    ? record.response as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : String(error);
  const name = typeof record.name === 'string' ? record.name : typeof error;
  const status = [record.statusCode, record.status, response.status]
    .find((value) => typeof value === 'number');
  const cause = record.cause;
  return {
    name,
    message: redactModelSecret(message),
    ...(typeof record.code === 'string' || typeof record.code === 'number' ? { code: record.code } : {}),
    ...(typeof status === 'number' ? { httpStatus: status } : {}),
    ...(cause === undefined ? {} : { cause: midsceneErrorDetails(cause, depth + 1) }),
  };
}

async function runMidsceneCall<T>(
  step: string,
  timeoutMs: MidsceneTimeout,
  page: Page,
  runnerBrowser: Parameters<typeof createE2EBrowserAdapter>[0],
  markerKey: string,
  markerToken: string,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let midsceneUrl = '<unavailable>';
  let runnerUrl = '<unavailable>';
  try {
    [midsceneUrl, runnerUrl] = await Promise.all([page.url(), runnerBrowser.url()]);
    console.log(`[MIDSCENE_CALL] step=${step} timeoutMs=${timeoutMs} page.url=${JSON.stringify(midsceneUrl)} runner.page.url=${JSON.stringify(runnerUrl)}`);
    if (midsceneUrl !== runnerUrl) throw new Error('MIDSCENE_PAGE_URL_MISMATCH');

    // The runner page may have navigated to a new document since attachment.
    // Restamp from the runner connection before Midscene reads the token.
    await runnerBrowser.evaluate((binding) => {
      Object.defineProperty(window, binding.key, {
        value: binding.token, configurable: true,
      });
      return true;
    }, { key: markerKey, token: markerToken });

    let markerOnMidscenePage: unknown;
    try {
      markerOnMidscenePage = await page.evaluate((key) => Reflect.get(window, key), markerKey);
    } catch (error) {
      throw new Error('MIDSCENE_PAGE_BINDING_LOST', { cause: error });
    }
    if (markerOnMidscenePage !== markerToken) {
      throw new Error('MIDSCENE_PAGE_BINDING_LOST');
    }
    return await action();
  } catch (error) {
    console.error(`[MIDSCENE_STEP=${step}] error=${JSON.stringify(midsceneErrorDetails(error))}`);
    throw error;
  } finally {
    console.log(`[MIDSCENE_CALL] step=${step} elapsedMs=${Date.now() - startedAt} timeoutMs=${timeoutMs} page.url=${JSON.stringify(midsceneUrl)} runner.page.url=${JSON.stringify(runnerUrl)}`);
  }
}

test(
  'confirmed casino plan executes as the test account',
  { session: 'hb-test', timeout: 600_000, tags: ['wager'] },
  async ({ app, browser, screen }) => {
    const planPath = process.env.AGENT_PLAN_PATH;
    const reportPath = process.env.AGENT_REPORT_PATH;

    test.skip(!planPath, 'run from the chat server with AGENT_PLAN_PATH');

    const savedReportState: { value: Record<string, unknown> | null } = { value: null };
    let evidenceState: Record<string, unknown> = {
      runId: process.env.AGENT_RUN_ID ?? null,
      status: 'RUNNING',
      success: false,
      plan: null,
      balanceBefore: null,
      gameState: null,
      spinResults: [],
      overlayEvents: 'See run.log for overlay classifications, dismissal coordinates, and zone decisions.',
      screenshots: [],
    };

    async function saveReport(data: Record<string, unknown>) {
      const report = { ...evidenceState, ...data };
      savedReportState.value = report;
      if (!reportPath) return;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, redactModelSecret(JSON.stringify(report, null, 2)), 'utf8');
    }

    const preflight = await runPhase('Revalidate the confirmed casino plan and spin gate', async () => {
      const validated = PlannerPlanSchema.parse(JSON.parse(await readFile(planPath!, 'utf8')));
      if (!needsAuth(validated)) throw new Error('PLAN_DOES_NOT_NEED_AUTH');
      if (isWagerPlan(validated) && process.env.ALLOW_SPINS !== '1') {
        await saveReport({ status: 'BLOCKED', success: false, reason: 'Spins were not confirmed', actions: [] });
        return { skipReason: 'set ALLOW_SPINS=1 to place spins' };
      }
      const expectedSpins = Number(process.env.HB_SPINS ?? '1');
      if (!Number.isInteger(expectedSpins) || expectedSpins < 1 || expectedSpins > 100) {
        throw new Error('HB_SPINS_INVALID');
      }
      if (isWagerPlan(validated)) {
        const slotActions = validated.actions.filter((action) => action.type === 'play_slot');
        if (slotActions.length !== 1 || slotActions[0].spins !== expectedSpins) {
          throw new Error('CONFIRMED_PLAN_SPIN_COUNT_DOES_NOT_MATCH_HB_SPINS');
        }
      }
      return { plan: validated };
    });
    if (!('plan' in preflight)) {
      test.skip(true, preflight.skipReason);
      throw new Error('SLOT_PLAN_PREFLIGHT_SKIPPED');
    }
    const plan = preflight.plan;
    evidenceState = { ...evidenceState, plan };

    await app.open('/');

    let cdpBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    let midsceneAgent: PlaywrightPageAgent | undefined;
    let midscenePage: Page | undefined;
    let pageBindingKey: string | undefined;
    let pageBindingToken: string | undefined;
    const balanceBeforeState: { value: number | null } = { value: null };
    const balanceAfterState: { value: number | null } = { value: null };
    let midsceneBalance: number | null = null;
    let midsceneFailure: { step: string; spin: number | null } | null = null;
    try {
      const midscene = await runPhase('Attach read-only Midscene to the runner page', async () => {
        const modelConfig = configureMidsceneModel();
        logMidsceneModelConfig(modelConfig, process.env.MIDSCENE_MODEL_API_KEY);
        const runnerUrl = await browser.url();
        cdpBrowser = await chromium.connectOverCDP(CDP_ENDPOINT);
        const matchingPages = cdpBrowser.contexts()
          .flatMap((context) => context.pages())
          .filter((page) => page.url() === runnerUrl);
        if (matchingPages.length !== 1) {
          throw new Error(`MIDSCENE_PAGE_BINDING_FAILED: expected exactly one page for runner URL; found ${matchingPages.length}`);
        }
        midscenePage = matchingPages[0];
        pageBindingKey = `__hbSlotRunnerBinding_${randomUUID().replaceAll('-', '')}`;
        pageBindingToken = randomUUID();
        await browser.evaluate((binding: { key: string; token: string }) => {
          Object.defineProperty(window, binding.key, {
            value: binding.token, configurable: true,
          });
          return true;
        }, { key: pageBindingKey, token: pageBindingToken });

        const attachPageUrl = await midscenePage.url();
        const attachRunnerUrl = await browser.url();
        const midsceneMarker = await midscenePage.evaluate((key) => Reflect.get(window, key), pageBindingKey);
        console.log(`[MIDSCENE_BINDING] page.url=${JSON.stringify(attachPageUrl)} runner.page.url=${JSON.stringify(attachRunnerUrl)} samePageToken=${midsceneMarker === pageBindingToken}`);
        if (attachPageUrl !== attachRunnerUrl || midsceneMarker !== pageBindingToken) {
          throw new Error('MIDSCENE_PAGE_OBJECT_MISMATCH');
        }

        midsceneAgent = new PlaywrightPageAgent(midscenePage, { cache: false });

        // Runtime capability restriction: the adapter receives a new object with only
        // read-only methods; the full agent is never passed across this boundary.
        const invokeMidscene = <T>(step: string, spin: number | null, timeoutMs: MidsceneTimeout, action: () => Promise<T>) => {
          return runMidsceneCall(step, timeoutMs, midscenePage!, browser, pageBindingKey!, pageBindingToken!, action)
            .catch((error: unknown) => {
              midsceneFailure = { step, spin };
              throw error;
            });
        };
        const readOnlyMidscene: ReadOnlyMidscene = {
          aiWaitFor: (...args) => {
            const prompt = String(args[0] ?? '');
            const match = prompt.match(/spin number (\d+)/i);
            const step = prompt.includes('fully loaded') ? 'game readiness' : 'spin completion';
            const options = args[1] as { timeoutMs?: number } | undefined;
            return invokeMidscene(step, match ? Number(match[1]) : null, options?.timeoutMs ?? 'Midscene default',
              () => midsceneAgent!.aiWaitFor(...args));
          },
          aiAssert: (...args) => {
            return invokeMidscene('stake assertion', 1, 'Midscene default', () => midsceneAgent!.aiAssert(...args));
          },
          aiQuery: (...args) => {
            const prompt = String(args[0] ?? '');
            const step = prompt.includes('overlay') ? 'overlay state' : 'balance fallback query';
            const spinMatch = prompt.match(/spin (?:number )?(\d+)/i);
            return invokeMidscene(step, spinMatch ? Number(spinMatch[1]) : null, 'Midscene default',
              () => midsceneAgent!.aiQuery(...args));
          },
          aiLocate: (...args) => {
            const prompt = String(args[0] ?? '');
            const spinMatch = prompt.match(/spin (?:number )?(\d+)/i);
            return invokeMidscene('overlay dismissal location', spinMatch ? Number(spinMatch[1]) : null,
              'Midscene default', () => midsceneAgent!.aiLocate(...args));
          },
        };
        return readOnlyMidscene;
      });

      const balanceLocator = browser.locator('[data-testid="left-menu-available-balance-formatted"]').first();
      const balanceBeforeText = await runPhase('Read header balance before opening the game', async () => {
        await expect(balanceLocator).toBeVisible({ timeout: 20_000 });
        const value = await balanceLocator.textContent();
        const parsedBalance = parseRand(value);
        if (parsedBalance < 0) throw new Error('HEADER_BALANCE_BEFORE_INVALID');
        balanceBeforeState.value = parsedBalance;
        console.log(`Balance before (header): ${value?.trim() ?? ''} => R${parsedBalance.toFixed(2)}`);
        return value?.trim() ?? '';
      });
      const balanceBefore = balanceBeforeState.value;
      if (balanceBefore === null) throw new Error('HEADER_BALANCE_BEFORE_MISSING');
      evidenceState = { ...evidenceState, balanceBefore, headerBalanceBefore: balanceBeforeText };

      const adapter = createE2EBrowserAdapter(browser, app, SITE_URL, screen, midscene);
      const started = Date.now();
      const report = await runPhase('Open Games in Olympus, verify R0.20, and play the confirmed spins', async () =>
        executePlan(plan, adapter));
      const durationMs = Date.now() - started;
      const gameState = report.results.find((result) => result.action.type === 'open_game')?.observation ?? null;
      evidenceState = { ...evidenceState, gameState };

      const actionReports = report.results.map((r) => {
        const details: Record<string, unknown> = {
          type: r.action.type,
          success: r.success,
          ...('game' in r.action ? { game: r.action.game } : {}),
        };
        if (r.action.type === 'play_slot') {
          details.spins = r.action.spins;
          details.stake = r.action.stake;
          if (isSuccessfulSlotResult(r)) {
            const observation: SlotObservation = r.observation;
            details.result = {
              ...observation,
              completedSpins: observation.spins.length,
              attemptedSpins: observation.spins.length,
              stoppedBeforeAnySpin: false,
            };
          } else {
            details.result = r.observation ?? null;
            if (!r.success) details.error = r.error;
          }
        } else if (r.action.type === 'open_game') {
          details.gameState = r.observation ?? null;
          if (!r.success) details.error = r.error;
        } else if (!r.success) {
          details.error = r.error;
        }
        return details;
      });

      if (!report.success) {
        const failedReport = {
          status: 'FAIL',
          success: false,
          durationMs,
          plan,
          balanceBefore,
          headerBalanceBefore: balanceBeforeText,
          gameState,
          ...(midsceneFailure ? { midsceneFailure } : {}),
          actions: actionReports,
        };
        await saveReport(failedReport);
        console.log('Execution report:', JSON.stringify(failedReport, null, 2));
        const failure = report.results.find((result) => !result.success);
        if (failure && !failure.success) throw new Error(failure.error);
        throw new Error('Casino plan failed');
      }

      const slotResult = report.results.find(
        isSuccessfulSlotResult,
      );
      if (!slotResult) throw new Error('SPIN_SETTLEMENT_DATA_INCOMPLETE');
      const settledBalanceBefore = balanceBefore;
      const slotObservation: SlotObservation = slotResult.observation;
      const settlement = settleSlotObservation(
        settledBalanceBefore,
        slotObservation,
        Number(process.env.HB_SPINS ?? '1'),
      );
      const { spinResults } = settlement;
      evidenceState = {
        ...evidenceState,
        spinResults,
        settlement: {
          totalStaked: settlement.totalStaked,
          totalWon: settlement.totalWon,
          expectedBalance: settlement.expectedBalance,
        },
      };

      const balanceAfterText = await runPhase('Read header balance after the spins and compare', async () => {
        await expect(balanceLocator).toBeVisible({ timeout: 20_000 });
        const value = (await balanceLocator.textContent())?.trim() ?? '';
        const headerBalanceAfter = parseRand(value);
        console.log(`Balance after (header): ${value} => R${headerBalanceAfter.toFixed(2)}`);

        if (headerBalanceAfter === settledBalanceBefore) {
          const visual = await midscene.aiQuery(
            '{ balance: number }, read the current in-game balance shown in the game canvas as a South African rand amount. Return only the numeric balance, without currency symbols.'
          ) as unknown;
          const visualValue = typeof visual === 'object' && visual !== null && 'balance' in visual
            ? (visual as { balance: unknown }).balance
            : visual;
          midsceneBalance = parseRand(typeof visualValue === 'string' || typeof visualValue === 'number' ? visualValue : null);
          console.log(`Balance fallback (Midscene): ${JSON.stringify(visual)} => R${midsceneBalance.toFixed(2)}`);
          balanceAfterState.value = midsceneBalance;
        } else {
          balanceAfterState.value = headerBalanceAfter;
        }

        const balanceAfter = balanceAfterState.value;
        if (balanceAfter === null || !Number.isFinite(balanceAfter) || balanceAfter < 0) {
          throw new Error('BALANCE_AFTER_INVALID');
        }
        console.log(`Balance settlement: before=R${settledBalanceBefore.toFixed(2)} spins=${spinResults.length} staked=R${settlement.totalStaked.toFixed(2)} totalWon=R${settlement.totalWon.toFixed(2)} expected=R${settlement.expectedBalance.toFixed(2)} actual=R${balanceAfter.toFixed(2)}`);
        const settlementEvidence = evidenceState.settlement as Record<string, unknown>;
        evidenceState = {
          ...evidenceState,
          balanceAfter,
          settlement: { ...settlementEvidence, actualBalance: balanceAfter },
        };
        if (balanceAfter !== settlement.expectedBalance) {
          await saveReport({
            status: 'FAIL', success: false, reason: 'BALANCE_SETTLEMENT_MISMATCH', durationMs,
            plan, balanceBefore, balanceAfter, gameState, spinResults, actions: actionReports,
          });
          throw new Error('BALANCE_SETTLEMENT_MISMATCH');
        }
        return value;
      });
      const balanceAfter = balanceAfterState.value;
      if (balanceAfter === null) throw new Error('BALANCE_AFTER_INVALID');

      const safeReport = {
        status: report.success ? 'PASS' : 'FAIL',
        success: report.success,
        durationMs,
        plan,
        balanceBefore,
        balanceAfter,
        headerBalanceBefore: balanceBeforeText,
        headerBalanceAfter: balanceAfterText,
        gameState,
        spinResults,
        settlement: {
          totalStaked: settlement.totalStaked,
          totalWon: settlement.totalWon,
          expectedBalance: settlement.expectedBalance,
          actualBalance: balanceAfter,
        },
        ...(midsceneBalance === null ? {} : { midsceneBalance }),
        actions: actionReports,
      };

      await saveReport(safeReport);
      console.log('Execution report:', JSON.stringify(safeReport, null, 2));
    } catch (error) {
      if (!savedReportState.value || savedReportState.value.status === 'RUNNING') {
        const message = error instanceof Error ? error.message : '';
        await saveReport({
          status: 'FAIL',
          success: false,
          reason: /^[A-Z0-9_]+$/.test(message) ? message : 'SLOT_RUN_FAILED',
          ...(midsceneFailure ? { midsceneFailure } : {}),
        });
      }
      throw error;
    } finally {
      if (pageBindingKey) {
        await browser.evaluate((key: string) => Reflect.deleteProperty(window, key), pageBindingKey).catch(() => {});
      }
      await midsceneAgent?.destroy().catch((error: unknown) => {
        console.warn('MIDSCENE_CLEANUP_FAILED', JSON.stringify(midsceneErrorDetails(error)));
      });
      // Closing a CDP-connected Playwright Browser disconnects this client only.
      // Do not close the shared Edge browser, context, or runner page.
      await cdpBrowser?.close();
    }
  },
);
