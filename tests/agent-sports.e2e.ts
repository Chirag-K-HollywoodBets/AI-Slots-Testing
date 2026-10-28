// Preparation-only sports runner. Final submission remains a manual user action.
import { test } from '@e2e-dev/web';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { executePlan } from '../src/agent/executor';
import { isSportsWagerPlan, needsAuth, PlannerPlanSchema } from '../src/agent/schema';
import { createE2EBrowserAdapter } from '../src/agent/adapters/e2e-browser';

const SITE_URL = 'https://www.hollywoodbets.net/';

test(
  'prepare the requested Premier League betslip for manual submission',
  {
    session: 'hb-test',
    timeout: 950_000,
    tags: ['wager'],
    agentContext: "Prepare and verify the requested soccer betslip only. The authenticated session comes from the terminal-configured test-account credentials; no separate client ID is required. Never submit any sports wager from this runner; leave the final Submit click to the user.",
  },
  async ({ app, browser, screen }) => {
    const planPath = process.env.AGENT_PLAN_PATH;
    const reportPath = process.env.AGENT_REPORT_PATH;
    test.skip(!planPath, 'run from the chat server with AGENT_PLAN_PATH');

    async function saveReport(data: unknown) {
      if (!reportPath) return;
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(data, null, 2), 'utf8');
    }

    async function pauseForManualReview(betslip: Record<string, unknown>) {
      const id = process.env.AGENT_REVIEW_ID;
      const readyPath = process.env.AGENT_REVIEW_READY_PATH;
      const decisionPath = process.env.AGENT_REVIEW_DECISION_PATH;
      const statePath = process.env.AGENT_REVIEW_STATE_PATH;
      const timeoutMs = Number(process.env.AGENT_REVIEW_TIMEOUT_MS);
      if (!id || !readyPath || !decisionPath || !statePath || !Number.isFinite(timeoutMs)
        || timeoutMs < 1_000 || timeoutMs > 600_000) throw new Error('REVIEW_CONFIGURATION_INVALID');
      const expiresAt = Date.now() + timeoutMs;
      await mkdir(dirname(readyPath), { recursive: true });
      await writeFile(readyPath, JSON.stringify({ id, expiresAt, betslip, submitted: false }), 'utf8');

      let outcome: 'finished' | 'expired' | 'browser_closed' | 'server_stopped' = 'expired';
      while (Date.now() < expiresAt) {
        try {
          const decision = JSON.parse(await readFile(decisionPath, 'utf8')) as { id?: string; runId?: string };
          if (decision.id === id && decision.runId === process.env.AGENT_REVIEW_RUN_ID) {
            outcome = 'finished';
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (process.env.AGENT_REVIEW_STOP_PATH) {
          try {
            await readFile(process.env.AGENT_REVIEW_STOP_PATH, 'utf8');
            outcome = 'server_stopped';
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        try {
          await browser.evaluate(() => document.visibilityState);
        } catch {
          outcome = 'browser_closed';
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await writeFile(statePath, JSON.stringify({ id, runId: process.env.AGENT_REVIEW_RUN_ID, outcome }), 'utf8');
      return outcome;
    }

    if (process.env.ALLOW_SPORTS_PREPARE !== '1') {
      await saveReport({ status: 'BLOCKED', success: false, reason: 'The sports wager was not confirmed in chat', actions: [] });
      throw new Error('SPORTS_WAGER_NOT_CONFIRMED');
    }

    const plan = PlannerPlanSchema.parse(JSON.parse(await readFile(planPath!, 'utf8')));
    const sportsPlanAction = plan.actions.length === 1 ? plan.actions[0] : undefined;
    if (!needsAuth(plan) || !isSportsWagerPlan(plan) || sportsPlanAction?.type !== 'prepare_sports_bet') {
      await saveReport({
        status: 'FAIL',
        success: false,
        reason: 'The sports plan must contain exactly one approved wager action. No browser action was run.',
        actions: []
      });
      throw new Error('INVALID_SPORTS_PLAN');
    }

    await app.open('/');
    const adapter = createE2EBrowserAdapter(browser, app, SITE_URL, screen);
    const started = Date.now();
    const report = await executePlan(plan, adapter);
    const durationMs = Date.now() - started;
    const sportsAction = report.results.find((result) => result.action.type === 'prepare_sports_bet');
    const preview = sportsAction?.success ? sportsAction.observation : undefined;
    const ready = report.success && Boolean(preview && typeof preview === 'object'
      && (preview as { status?: string }).status === 'BETSLIP_READY'
      && (preview as { submitted?: boolean }).submitted === false);
    const failureCode = sportsAction?.error;
    const requestedTeam = sportsPlanAction.selections.map((selection) => selection.team).join(', ');
    const failureReason = failureCode === 'SPORTS_FIXTURE_NOT_FOUND'
      ? `No visible Premier League fixture matched ${requestedTeam}. No selection was added.`
      : failureCode === 'SPORTS_FIXTURE_AMBIGUOUS'
        ? `More than one Premier League fixture matched ${requestedTeam}. No selection was added; specify the opponent and try again.`
        : failureCode === 'BETSLIP_NOT_EMPTY'
          ? 'The betslip already contains a selection. Clear it manually and try again.'
          : failureCode === 'SPORTS_PAGE_NOT_READY'
            ? 'The sportsbook betslip did not become visible within 30 seconds. No odds were selected and no bet was submitted.'
          : failureCode === 'BETSLIP_NOT_VERIFIED'
            ? 'The betslip details could not be verified. No bet was submitted.'
        : 'The betslip could not be prepared safely. No bet was submitted.';

    const safeReport = {
      status: ready ? 'BETSLIP_READY' : 'FAIL',
      success: ready,
      durationMs,
      reason: ready
        ? 'Preparation completed successfully. No bet was submitted.'
        : failureReason + ' Inspect the remaining selections in the report and clear the slip manually before retrying. If the slip could not be read, check it in the sportsbook.',
      actions: report.results.map((result) => ({
        type: result.action.type,
        success: result.success,
        ...(result.action.type === 'prepare_sports_bet' && result.success
          ? { betslip: result.observation }
          : {}),
        ...(!result.success && result.observation ? { preparation: result.observation } : {}),
        ...(result.error ? { error: result.error } : {}),
      })),
    };

    await saveReport(safeReport);
    console.log('Sports betslip report:', JSON.stringify(safeReport, null, 2));
    if (!ready) throw new Error('SPORTS_BETSLIP_PREPARATION_FAILED');
    const betslip = safeReport.actions.find((action) => action.type === 'prepare_sports_bet')?.betslip as
      Record<string, unknown> | undefined;
    if (!betslip) throw new Error('REVIEW_BETSLIP_MISSING');
    const outcome = await pauseForManualReview(betslip);
    if (outcome === 'expired') {
      safeReport.status = 'REVIEW_EXPIRED';
      safeReport.reason = 'Review expired — no bet submitted';
    } else if (outcome === 'browser_closed') {
      safeReport.status = 'REVIEW_CLOSED';
      safeReport.reason = 'The review browser was closed; no bet was submitted.';
    } else if (outcome === 'server_stopped') {
      safeReport.status = 'REVIEW_CLOSED';
      safeReport.reason = 'The chat server stopped and closed the review; no bet was submitted.';
    } else {
      safeReport.status = 'REVIEW_FINISHED';
      safeReport.reason = 'Review finished — no bet submitted';
    }
    await saveReport(safeReport);
  }
);
