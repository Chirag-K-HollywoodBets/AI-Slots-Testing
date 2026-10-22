
import { test } from '@e2e-dev/web';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { checkLLMHealth } from '../src/agent/llm-health';
import { Planner } from '../src/agent/planner';
import { executePlan } from '../src/agent/executor';
import {
  ALLOWED_PATHS,
  needsAuth,
  PlannerPlanSchema,
  type PlannerResponse,
} from '../src/agent/schema';
import { createE2EBrowserAdapter } from
  '../src/agent/adapters/e2e-browser';

const LLM_URL = 'http://10.6.49.95:8007/gemma/v1';

const MODEL_NAME =
  'Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf';

const SITE_URL = 'https://www.hollywoodbets.net/';

test(
  'AI instruction executes against HollywoodBets',
  async ({ app, browser }) => {

    const instruction =
      process.env.AGENT_INSTRUCTION ??
      'Inspect the HollywoodBets homepage and verify it is visible';

    const reportPath = process.env.AGENT_REPORT_PATH;

    // Write sanitized results for the chat interface.
    async function saveReport(data: unknown) {
      if (!reportPath) return;

      await mkdir(dirname(reportPath), {
        recursive: true,
      });

      await writeFile(
        reportPath,
        JSON.stringify(data, null, 2),
        'utf8'
      );
    }

    // The chat server plans first (scripts/plan.ts) and passes the plan in.
    // When it does, skip straight to execution instead of planning twice.
    const planPath = process.env.AGENT_PLAN_PATH;
    let plan: PlannerResponse;

    if (planPath) {
      plan = PlannerPlanSchema.parse(
        JSON.parse(await readFile(planPath, 'utf8'))
      );

      // Game and spin plans run signed in, in tests/agent-slot.e2e.ts only.
      if (needsAuth(plan)) {
        await saveReport({
          status: 'BLOCKED',
          success: false,
          reason: 'Casino plans must run through the confirmed slot flow',
          actions: [],
        });
        throw new Error('AUTH_PLAN_IN_READ_ONLY_TEST');
      }
    } else {

    // Deterministically reject explicit disallowed paths.
    // The schema and adapter remain the enforcement layers.
    const requestedPaths = [
      ...instruction.matchAll(
        /(?:^|[\s"'(])(\/[a-zA-Z0-9/_-]+)/g
      ),
    ].map((match) => match[1]);

    const disallowedPath = requestedPaths.find(
      (path) =>
        !(ALLOWED_PATHS as readonly string[]).includes(path)
    );

    if (disallowedPath) {
      const reason =
        'Requested navigation path is not allowlisted';

      await saveReport({
        status: 'BLOCKED',
        success: false,
        reason,
        actions: [],
      });

      console.log('BLOCKED:', reason);
      return;
    }

    // Check model availability before browser navigation.
    const health = await checkLLMHealth(LLM_URL);

    if (!health.available) {
      await saveReport({
        status: 'ERROR',
        success: false,
        code: 'LLM_UNAVAILABLE',
        reason: health.error ?? 'Model unavailable',
        actions: [],
      });

      throw new Error('LLM_UNAVAILABLE');
    }

    const planner = new Planner({
      baseUrl: LLM_URL,
      modelName: MODEL_NAME,
    });

    console.log('Planning test instruction');

    // Generate and validate the AI plan.
    plan = await planner.plan(instruction);

    if ('status' in plan && plan.status === 'blocked') {
      await saveReport({
        status: 'BLOCKED',
        success: false,
        reason: plan.reason,
        actions: [],
      });

      console.log('BLOCKED:', plan.reason);
      return;
    }

    // Defence in depth: this read-only test never runs casino actions.
    if (needsAuth(plan)) {
      await saveReport({
        status: 'BLOCKED',
        success: false,
        reason: 'Casino plans must run through the confirmed slot flow',
        actions: [],
      });
      return;
    }
    } // end of in-test planning

    if ('status' in plan) return;

    console.log(
      'Validated AI plan:',
      JSON.stringify(plan, null, 2)
    );

    // Only navigate after obtaining an executable plan.
    await app.open('/');

    const adapter = createE2EBrowserAdapter(
      browser,
      app,
      SITE_URL
    );

    const started = Date.now();

    const report = await executePlan(plan, adapter);

    const durationMs = Date.now() - started;

    const safeReport = {
      status: report.success ? 'PASS' : 'FAIL',
      success: report.success,
      durationMs,
      actions: report.results.map((result) => ({
        type: result.action.type,
        success: result.success,

        ...(result.action.type === 'check_visible'
          ? { selector: result.action.selector }
          : {}),

        ...(result.action.type ===
          'navigate_to_allowlisted_path'
          ? { path: result.action.path }
          : {}),

        ...(result.action.type === 'get_page_info' &&
        result.success &&
        result.observation &&
        typeof result.observation === 'object'
          ? (() => {
              const info = result.observation as {
                title?: string;
                url?: string;
              };

              const url = new URL(info.url ?? SITE_URL);

              return {
                title: info.title ?? '',
                url: url.origin + url.pathname,
              };
            })()
          : {}),

        ...(result.error
          ? { error: result.error }
          : {}),
      })),
    };

    await saveReport(safeReport);

    console.log(
      'Execution report:',
      JSON.stringify(safeReport, null, 2)
    );

    if (!report.success) {
      throw new Error('AI browser verification failed');
    }
  }
);
