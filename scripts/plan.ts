// Turns one chat instruction into a validated plan, without opening a browser.
// The chat server runs this first so it can ask for confirmation before any
// wagering plan is executed.
//
//   AGENT_INSTRUCTION="..." node node_modules/tsx/dist/cli.mjs scripts/plan.ts
//
// Prints exactly one line starting with PLAN_RESULT: followed by JSON.

import { checkLLMHealth } from '../src/agent/llm-health';
import { Planner } from '../src/agent/planner';
import { ALLOWED_PATHS, isWagerPlan, needsAuth, PlannerPlanSchema } from '../src/agent/schema';

const LLM_URL = process.env.LLM_URL ?? 'http://10.6.49.95:8007/gemma/v1';
const MODEL_NAME = process.env.LLM_MODEL ?? 'Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf';

function emit(result: unknown): never {
  console.log('PLAN_RESULT:' + JSON.stringify(result));
  process.exit(0);
}

const instruction = (process.env.AGENT_INSTRUCTION ?? '').trim();
if (!instruction) emit({ status: 'ERROR', code: 'NO_INSTRUCTION', reason: 'No instruction given' });

// Deterministically reject explicit non-allowlisted paths before asking the model.
const requestedPaths = [...instruction.matchAll(/(?:^|[\s"'(])(\/[a-zA-Z0-9/_-]+)/g)].map((m) => m[1]);
if (requestedPaths.some((p) => !(ALLOWED_PATHS as readonly string[]).includes(p))) {
  emit({ status: 'BLOCKED', reason: 'Requested navigation path is not allowlisted' });
}

const health = await checkLLMHealth(LLM_URL);
if (!health.available) {
  emit({ status: 'ERROR', code: 'LLM_UNAVAILABLE', reason: health.error ?? 'Model unavailable' });
}

try {
  const response = await new Planner({ baseUrl: LLM_URL, modelName: MODEL_NAME }).plan(instruction);

  if ('status' in response) emit({ status: 'BLOCKED', reason: response.reason });

  const plan = PlannerPlanSchema.parse(response);
  emit({ status: 'PLANNED', plan, wager: isWagerPlan(plan), auth: needsAuth(plan) });
} catch {
  emit({ status: 'ERROR', code: 'PLANNING_FAILED', reason: 'The model did not return a valid plan' });
}
