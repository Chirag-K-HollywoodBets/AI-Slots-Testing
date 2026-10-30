import type { Planner } from './planner';
import {
  createSportsConversationState, reduceSportsConversation, requirementsFor,
  SportsInterpretationSchema, type PendingSportsRequest, type SportsConversationState,
  type SportsInterpretation,
} from './sports-conversation';
import { usableFixtureSnapshot, type FixtureSnapshot } from './sports-team-clarification';

/** Only this small, session-owned context is sent to the interpreter. */
export interface SportsInterpretationContext {
  outstandingClarification: { field: string; question: string } | null;
  recentContext: { role: 'user'; content: string }[];
}

export class SportsInterpretationError extends Error {
  constructor(public readonly code: 'MODEL_TIMEOUT' | 'MODEL_UNAVAILABLE' | 'INVALID_INTERPRETATION') {
    super(code);
  }
}

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const explicitRequest = (message: string) => /\b(?:prepare|place|bet|accumulator|to win|to beat|vs\.?|versus|new request|start over|replace\s+(?:(?:the|my|this|existing)\s+)?request)\b/i.test(message);

/** Validate evidence and intent independently of the model's instructions. */
export function validateSportsInterpretation(raw: unknown, message: string, pending: PendingSportsRequest | null): SportsInterpretation {
  const parsed = SportsInterpretationSchema.parse(raw);
  if (parsed.kind === 'cancellation' && !/^(?:cancel|cancel (?:it|that|the request|my request)|never mind|nevermind|forget it)[.!]?$/i.test(message.trim())) {
    throw new SportsInterpretationError('INVALID_INTERPRETATION');
  }
  if (!('updates' in parsed)) return parsed;
  if (parsed.kind === 'correction' && !/\b(?:actually|instead|change|correct|make it|replace|rather|meant|update|switch)\b/i.test(message)) {
    throw new SportsInterpretationError('INVALID_INTERPRETATION');
  }
  if (parsed.kind === 'new_request' && !explicitRequest(message)) {
    throw new SportsInterpretationError('INVALID_INTERPRETATION');
  }
  if (!pending && parsed.kind !== 'new_request') throw new SportsInterpretationError('INVALID_INTERPRETATION');
  const updates = parsed.updates;
  const quoted = [updates.competition, updates.market, updates.totalStake];
  const seen = new Set<number>();
  for (const selection of updates.selections ?? []) {
    if (seen.has(selection.index)) throw new SportsInterpretationError('INVALID_INTERPRETATION');
    seen.add(selection.index);
    quoted.push(selection.team, selection.opponent);
  }
  for (const item of quoted) {
    if (item && (!normalize(message).includes(normalize(item.evidence)) || !normalize(item.evidence).includes(normalize(item.value)))) {
      throw new SportsInterpretationError('INVALID_INTERPRETATION');
    }
  }
  if (updates.totalStake) {
    // Evidence must contain a whole amount, not a convenient substring such as
    // R10 from R100 or R1.00 from R1.001. A sentence-ending full stop is allowed.
    const literal = updates.totalStake.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?<![\\p{L}\\p{N}.,-])${literal}(?![\\p{L}\\p{N}]|[.,]\\d)`, 'iu').test(message)) {
      throw new SportsInterpretationError('INVALID_INTERPRETATION');
    }
    // A model must not choose one of two conflicting monetary amounts or drop
    // a sign/decimal separator from the amount actually supplied by the user.
    const amount = (value: string) => Number(value.replace(/R|ZAR|\s/gi, '').replace(',', '.'));
    const amounts = new Set([...message.matchAll(/(?:-\s*)?\bR\s*\d+(?:[.,]\d+)?\b|(?:-\s*)?\b\d+(?:[.,]\d+)?\s*ZAR\b/gi)]
      .map(([value]) => amount(value)));
    if (amounts.size > 1 || (amounts.size === 1 && !amounts.has(amount(updates.totalStake.value)))) {
      throw new SportsInterpretationError('INVALID_INTERPRETATION');
    }
  }
  return parsed;
}

/** Interpretation and deterministic collection only; this function has no executor. */
export async function interpretSportsTurn(
  planner: Pick<Planner, 'interpretSportsMessage'>,
  message: string,
  pending: PendingSportsRequest | null,
  options: { state?: SportsConversationState; messageId?: string; now?: number; fixtureSnapshot?: FixtureSnapshot | null } = {},
) {
  const now = options.now ?? Date.now();
  const state = options.state ?? createSportsConversationState(pending, now);
  const active = state.request && state.expiresAt !== null && now < state.expiresAt ? state.request : null;
  if (state.request && /^(?:cancel|cancel (?:it|that|the request|my request)|never mind|nevermind|forget it)[.!]?$/i.test(message.trim())) {
    return reduceSportsConversation(pending, { kind: 'cancellation' }, message, { ...options, state, now });
  }
  const issues = active ? requirementsFor(state) : [];
  const issue = issues.find((item) => item.code === 'team_suggestion') ?? issues[0];
  const context: SportsInterpretationContext = {
    outstandingClarification: issue ? { field: issue.field, question: issue.question } : null,
    // The draft already carries older facts. One previous user turn is enough;
    // do not send cookies, confirmations, resolved fixtures or the full chat log.
    recentContext: active && state.lastMessage ? [{ role: 'user', content: state.lastMessage.slice(0, 500) }] : [],
  };
  if (!active && !explicitRequest(message)) {
    return reduceSportsConversation(pending, { kind: 'answer_to_clarification', updates: {} }, message, { ...options, state, now });
  }
  // Consent applies only to the pending name suggestion. It never authorizes a
  // wager or preparation. Combined replies still use the model for other fields.
  if (active && state.teamSuggestions?.length && /^(?:yes|yep|correct|no|nope|neither|none)[.!]?$/i.test(message.trim())) {
    return reduceSportsConversation(pending, { kind: 'answer_to_clarification', updates: {} }, message, { ...options, state, now });
  }
  const observedFixtures = usableFixtureSnapshot(options.fixtureSnapshot, now);
  if (active && issues.some((item) => item.code === 'fixture_ambiguous')
    && observedFixtures?.fixtures.some((fixture) => message.trim() === fixture.kickoff || message.trim() === fixture.id)) {
    return reduceSportsConversation(pending, { kind: 'answer_to_clarification', updates: {} }, message, { ...options, state, now });
  }
  try {
    const result = await planner.interpretSportsMessage(message, active, context);
    const interpretation = validateSportsInterpretation(result.interpretation, message, active);
    // A model reply must not extend a request that expired during generation.
    // Tests may supply a deterministic clock value through options.now.
    return { ...reduceSportsConversation(pending, interpretation, message, { ...options, state, now: options.now ?? Date.now() }),
      ...(result.usage ? { usage: result.usage } : {}) };
  } catch (error) {
    const code = error instanceof SportsInterpretationError ? error.code : 'INVALID_INTERPRETATION';
    const failure = code === 'MODEL_TIMEOUT'
      ? 'The local model took too long to respond.'
      : code === 'MODEL_UNAVAILABLE'
        ? 'The local model request failed.'
        : 'I could not interpret that message safely.';
    const recovery = active
      ? 'Saved details are unchanged. Please send your reply again.'
      : 'No pending request was saved. Please resend the full sports preparation request, rather than just the missing detail.';
    return { status: 'CLARIFICATION' as const, code,
      reason: `${failure} ${recovery}`,
      pendingSports: pending, conversationState: state, changed: false, confirmationInvalidated: false,
      requirements: active ? requirementsFor(state) : [], actions: [] };
  }
}
