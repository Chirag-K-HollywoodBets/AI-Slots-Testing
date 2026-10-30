// Interprets one chat turn with an optional saved sports draft, without opening a browser.
// The chat server runs this first so it can ask for confirmation before any
// wagering plan is executed.
//
//   AGENT_INSTRUCTION="..." node node_modules/tsx/dist/cli.mjs scripts/plan.ts
//
// Prints exactly one line starting with PLAN_RESULT: followed by JSON.

import { checkLLMHealth } from '../src/agent/llm-health';
import { Planner } from '../src/agent/planner';
import { ALLOWED_PATHS, isWagerPlan, needsAuth, PlannerPlanSchema, resolveGameName } from '../src/agent/schema';
import { PendingSportsRequestSchema, SportsConversationStateSchema, reduceSportsConversation, usesSportsConversation } from '../src/agent/sports-conversation';
import { interpretSportsTurn } from '../src/agent/sports-interpreter';
import { readFixtureSnapshot } from '../src/agent/sports-fixture-source';

const LLM_URL = process.env.LLM_URL ?? 'http://10.6.49.95:8007/gemma/v1';
const MODEL_NAME = process.env.LLM_MODEL ?? 'Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf';

function emit(result: unknown): never {
  console.log('PLAN_RESULT:' + JSON.stringify(result));
  process.exit(0);
}

const instruction = (process.env.AGENT_INSTRUCTION ?? '').trim();
if (!instruction) emit({ status: 'ERROR', code: 'NO_INSTRUCTION', reason: 'No instruction given' });

const pendingSports = process.env.AGENT_PENDING_SPORTS_REQUEST
  ? PendingSportsRequestSchema.parse(JSON.parse(process.env.AGENT_PENDING_SPORTS_REQUEST)) : null;
const conversationOptions = {
  state: process.env.AGENT_SPORTS_CONVERSATION_STATE
    ? SportsConversationStateSchema.parse(JSON.parse(process.env.AGENT_SPORTS_CONVERSATION_STATE)) : undefined,
  messageId: process.env.AGENT_CONVERSATION_MESSAGE_ID || undefined,
};
if (pendingSports && /^(?:cancel|cancel (?:it|that|the request|my request)|never mind|nevermind|forget it)[.!]?$/i.test(instruction)) {
  emit(reduceSportsConversation(pendingSports, { kind: 'cancellation' }, instruction, conversationOptions));
}

// Slot titles are resolved before model planning. Never let the model map an
// unknown or ambiguous title onto the one supported route.
const requestsSlots = /\b(slot|slots|spin|spins|casino)\b/i.test(instruction);
const gameMention = instruction.match(/\bgames\s+in\s+olympus\b/i)?.[0];
const namesVerifiedGame = gameMention !== undefined && resolveGameName(gameMention) !== null;
if (requestsSlots && !namesVerifiedGame) {
  emit({
    status: 'BLOCKED',
    reason: 'No verified slot game matched the request. Known route: Games in Olympus; its stake controls are unverified. The legacy remembered R0.20 path supports 1–100 spins with ante off. No game was opened.',
  });
}

// Deterministically reject explicit non-allowlisted paths before asking the model.
const requestedPaths = [...instruction.matchAll(/(?:^|[\s"'(])(\/[a-zA-Z0-9/_-]+)/g)].map((m) => m[1]);
if (requestedPaths.some((p) => !(ALLOWED_PATHS as readonly string[]).includes(p))) {
  emit({ status: 'BLOCKED', reason: 'Requested navigation path is not allowlisted' });
}

// Sports interpretation handles unavailable services and timeouts as recoverable
// conversation replies. The executable planner keeps its existing health check.
if (usesSportsConversation(instruction)) {
  const planner = new Planner({ baseUrl: LLM_URL, modelName: MODEL_NAME });
  const fixtureSnapshot = await readFixtureSnapshot(process.env.SPORTS_FIXTURE_SNAPSHOT_PATH);
  emit(await interpretSportsTurn(planner, instruction, pendingSports, { ...conversationOptions, fixtureSnapshot }));
}

const health = await checkLLMHealth(LLM_URL);
if (!health.available) {
  emit({ status: 'ERROR', code: 'LLM_UNAVAILABLE', reason: health.error ?? 'Model unavailable' });
}

try {
  const planner = new Planner({ baseUrl: LLM_URL, modelName: MODEL_NAME });
  const response = await planner.plan(instruction);

  if ('status' in response) emit({ status: 'BLOCKED', reason: response.reason });

  // Keep provider usage metadata outside the strict plan schema. The planner
  // response may include this optional reporting field, but plans themselves
  // must remain limited to the fields accepted by PlannerPlanSchema.
  const { usage, ...planResponse } = response;
  const plan = PlannerPlanSchema.parse(planResponse);
  const sportsActions = plan.actions.filter((action) => action.type === 'prepare_sports_bet');
  if (sportsActions.length > 0) {
    // Sports actions are constructed only from the validated conversation draft.
    // An unexpected sports action from the legacy planner must not bypass it.
    emit({ status: 'AMBIGUOUS', reason: 'Please state the sports preparation request and its details explicitly. Saved details are unchanged.',
      pendingSports, changed: false, actions: [] });
  }
  emit({
    status: 'PLANNED',
    plan,
    usage,
    wager: isWagerPlan(plan),
    auth: needsAuth(plan)
  });
} catch {
  if (/\b(soccer|football|premier league|accumulator|sports?\s+bet|\bbet\b)\b/i.test(instruction)) {
    emit({
      status: 'BLOCKED',
      reason: 'Sports request requires an explicit positive ZAR stake at or below R50 and exact selections. Provider stake limits and controls remain unverified. No browser action was run.',
    });
  }
  if (/\b(slot|slots|spin|spins|casino|games in olympus)\b/i.test(instruction)) {
    emit({
      status: 'BLOCKED',
      reason: 'Slot request could not be resolved to a verified game and stake. Known route: Games in Olympus; stake controls are unverified. The legacy remembered R0.20 path supports 1–100 spins with ante off. No game was opened.',
    });
  }
  emit({ status: 'ERROR', code: 'PLANNING_FAILED', reason: 'The model did not return a valid plan' });
}
