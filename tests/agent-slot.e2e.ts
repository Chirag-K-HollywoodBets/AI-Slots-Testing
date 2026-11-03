// Runs an already-planned, user-confirmed casino plan as the signed-in test account.
// Started by chat/server.cjs only after the user confirms. Never plans by itself.

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright';
import { PlaywrightPageAgent } from '@midscene/web/playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { executePlan } from '../src/agent/executor';
import { isWagerPlan, needsAuth, PlannerPlanSchema } from '../src/agent/schema';
import { createE2EBrowserAdapter, type ReadOnlyMidscene } from '../src/agent/adapters/e2e-browser';

const SITE_URL = 'https://www.hollywoodbets.net/';
const CDP_ENDPOINT = 'http://127.0.0.1:9223';

export function parseRand(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.match(/R\s*([\d\s,]+(?:\.\d{1,2})?)/i) ?? value.match(/([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/[\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

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

test(
  'confirmed casino plan executes as the test account',
  { session: 'hb-test', timeout: 600_000, tags: ['wager'] },
  async ({ app, browser, screen }) => {
    const planPath = process.env.AGENT_PLAN_PATH;
    const reportPath = process.env.AGENT_REPORT_PATH;

    test.skip(!planPath, 'run from the chat server with AGENT_PLAN_PATH');

    async function saveReport(data: unknown) {
      if (!reportPath) return;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(data, null, 2), 'utf8');
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

    await app.open('/');

    let cdpBrowser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    let midsceneAgent: PlaywrightPageAgent | undefined;
    let balanceBefore: number | null = null;
    let balanceAfter: number | null = null;
    let midsceneBalance: number | null = null;
    let midsceneFailure: { step: string; spin: number | null } | null = null;

    try {
      const midscene = await runPhase('Attach read-only Midscene to the runner page', async () => {
        const runnerUrl = await browser.url();
        cdpBrowser = await chromium.connectOverCDP(CDP_ENDPOINT);
        const matchingPages = cdpBrowser.contexts()
          .flatMap((context) => context.pages())
          .filter((page) => page.url() === runnerUrl);
        if (matchingPages.length !== 1) {
          throw new Error(`MIDSCENE_PAGE_BINDING_FAILED: expected exactly one page for runner URL; found ${matchingPages.length}`);
        }
        midsceneAgent = new PlaywrightPageAgent(matchingPages[0], { cache: false });

        // Runtime capability restriction: the adapter receives a new object with only
        // these three methods; the full agent is never passed across this boundary.
        const trackFailure = (step: string, args: unknown[]) => {
          const prompt = String(args[0] ?? '');
          const spin = prompt.match(/spin number (\d+)/i);
          midsceneFailure = { step, spin: spin ? Number(spin[1]) : step === 'stake assertion' ? 1 : null };
        };
        const readOnlyMidscene: ReadOnlyMidscene = {
          aiWaitFor: async (...args) => {
            try { return await midsceneAgent!.aiWaitFor(...args); }
            catch (error) {
              trackFailure(String(args[0]).includes('fully loaded') ? 'game readiness' : 'spin completion', args);
              throw error;
            }
          },
          aiAssert: async (...args) => {
            try { return await midsceneAgent!.aiAssert(...args); }
            catch (error) {
              trackFailure('stake assertion', args);
              throw error;
            }
          },
          aiQuery: async (...args) => {
            try { return await midsceneAgent!.aiQuery(...args); }
            catch (error) {
              trackFailure('balance fallback query', args);
              throw error;
            }
          },
        };
        return readOnlyMidscene;
      });

      const balanceLocator = browser.locator('.account .balance-value').first();
      const balanceBeforeText = await runPhase('Read header balance before opening the game', async () => {
        await expect(balanceLocator).toBeVisible({ timeout: 20_000 });
        const value = await balanceLocator.textContent();
        balanceBefore = parseRand(value);
        if (balanceBefore === null || balanceBefore < 0) throw new Error('HEADER_BALANCE_BEFORE_INVALID');
        console.log(`Balance before (header): ${value?.trim() ?? ''} => R${balanceBefore.toFixed(2)}`);
        return value?.trim() ?? '';
      });

      const adapter = createE2EBrowserAdapter(browser, app, SITE_URL, screen, midscene);
      const started = Date.now();
      const report = await runPhase('Open Games in Olympus, verify R0.20, and play the confirmed spins', async () =>
        executePlan(plan, adapter));
      const durationMs = Date.now() - started;

      const actionReports = report.results.map((r) => ({
        type: r.action.type,
        success: r.success,
        ...('game' in r.action ? { game: r.action.game } : {}),
        ...(r.action.type === 'play_slot'
          ? {
            spins: r.action.spins,
            stake: r.action.stake,
            result: Array.isArray(r.observation)
              ? {
                spins: r.observation,
                completedSpins: r.observation.length,
                attemptedSpins: r.observation.length,
                stoppedBeforeAnySpin: false,
              }
              : r.observation ?? null,
          }
          : {}),
        ...(r.error ? { error: r.error } : {}),
      }));

      if (!report.success) {
        const failedReport = {
          status: 'FAIL',
          success: false,
          durationMs,
          balanceBefore,
          headerBalanceBefore: balanceBeforeText,
          ...(midsceneFailure ? { midsceneFailure } : {}),
          actions: actionReports,
        };
        await saveReport(failedReport);
        console.log('Execution report:', JSON.stringify(failedReport, null, 2));
        const failure = report.results.find((result) => !result.success);
        throw new Error(failure?.error ?? 'Casino plan failed');
      }

      const balanceAfterText = await runPhase('Read header balance after the spins and compare', async () => {
        await expect(balanceLocator).toBeVisible({ timeout: 20_000 });
        const value = (await balanceLocator.textContent())?.trim() ?? '';
        const headerBalanceAfter = parseRand(value);
        console.log(`Balance after (header): ${value} => ${headerBalanceAfter === null ? 'unreadable' : `R${headerBalanceAfter.toFixed(2)}`}`);

        if (headerBalanceAfter === balanceBefore) {
          const visual = await midscene.aiQuery(
            '{ balance: number }, read the current in-game balance shown in the game canvas as a South African rand amount. Return only the numeric balance, without currency symbols.'
          ) as unknown;
          const visualValue = typeof visual === 'object' && visual !== null && 'balance' in visual
            ? (visual as { balance: unknown }).balance
            : visual;
          midsceneBalance = parseRand(typeof visualValue === 'string' || typeof visualValue === 'number' ? visualValue : null);
          console.log(`Balance fallback (Midscene): ${JSON.stringify(visual)} => ${midsceneBalance === null ? 'unreadable' : `R${midsceneBalance.toFixed(2)}`}`);
          balanceAfter = midsceneBalance;
        } else {
          balanceAfter = headerBalanceAfter;
        }

        if (balanceAfter === null || !Number.isFinite(balanceAfter) || balanceAfter < 0) {
          throw new Error('BALANCE_AFTER_INVALID');
        }
        if (balanceAfter === balanceBefore) throw new Error('BALANCE_DID_NOT_CHANGE');
        return value;
      });

      const safeReport = {
        status: report.success ? 'PASS' : 'FAIL',
        success: report.success,
        durationMs,
        balanceBefore,
        balanceAfter,
        headerBalanceBefore: balanceBeforeText,
        headerBalanceAfter: balanceAfterText,
        ...(midsceneBalance === null ? {} : { midsceneBalance }),
        actions: actionReports,
      };

      await saveReport(safeReport);
      console.log('Execution report:', JSON.stringify(safeReport, null, 2));
    } finally {
      try {
        await midsceneAgent?.destroy();
      } finally {
        // Closing a CDP-connected Playwright Browser disconnects this client only.
        // Do not close the shared Edge browser, context, or runner page.
        await cdpBrowser?.close();
      }
    }
  },
);
