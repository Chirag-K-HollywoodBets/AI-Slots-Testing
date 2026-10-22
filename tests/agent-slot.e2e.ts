// Runs an already-planned, user-confirmed casino plan as the signed-in test account.
// Started by chat/server.cjs only after the user confirms. Never plans by itself.

import { test } from '@e2e-dev/web';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { executePlan } from '../src/agent/executor';
import { isWagerPlan, needsAuth, PlannerPlanSchema } from '../src/agent/schema';
import { createE2EBrowserAdapter } from '../src/agent/adapters/e2e-browser';

const SITE_URL = 'https://www.hollywoodbets.net/';

test(
  'confirmed casino plan executes as the test account',
  { session: 'hb-test', timeout: 600_000, tags: ['wager'] },
  async ({ app, browser }) => {
    const planPath = process.env.AGENT_PLAN_PATH;
    const reportPath = process.env.AGENT_REPORT_PATH;

    test.skip(!planPath, 'run from the chat server with AGENT_PLAN_PATH');

    async function saveReport(data: unknown) {
      if (!reportPath) return;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(data, null, 2), 'utf8');
    }

    // Re-validate: never trust the file just because the server wrote it.
    const plan = PlannerPlanSchema.parse(JSON.parse(await readFile(planPath!, 'utf8')));

    if (!needsAuth(plan)) {
      throw new Error('PLAN_DOES_NOT_NEED_AUTH');
    }
    if (isWagerPlan(plan) && process.env.ALLOW_SPINS !== '1') {
      await saveReport({ status: 'BLOCKED', success: false, reason: 'Spins were not confirmed', actions: [] });
      test.skip(true, 'set ALLOW_SPINS=1 to place spins');
    }

    await app.open('/');

    const adapter = createE2EBrowserAdapter(browser, app, SITE_URL);
    const started = Date.now();
    const report = await executePlan(plan, adapter);
    const durationMs = Date.now() - started;

    const safeReport = {
      status: report.success ? 'PASS' : 'FAIL',
      success: report.success,
      durationMs,
      actions: report.results.map((r) => ({
        type: r.action.type,
        success: r.success,
        ...('game' in r.action ? { game: r.action.game } : {}),
        ...(r.action.type === 'play_slot'
          ? { spins: r.action.spins, stake: r.action.stake, result: r.observation ?? null }
          : {}),
        ...(r.error ? { error: r.error } : {}),
      })),
    };

    await saveReport(safeReport);
    console.log('Execution report:', JSON.stringify(safeReport, null, 2));

    if (!report.success) {
      throw new Error('Casino plan failed');
    }
  }
);
