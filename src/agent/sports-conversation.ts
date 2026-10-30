import { z } from 'zod';
import { PlannerPlanSchema, SPORTS_MAX_ACCUMULATOR_SELECTIONS, SPORTS_STAKE_LIMITS } from './schema';
import { validateSportsStakeCents, establishedTeamName } from './sports-fixtures';
import { TeamSuggestionSchema, CompetitionResolutionSchema, answerTeamSuggestions, clarifyTeamsAndFixtures,
  usableFixtureSnapshot, type FixtureSnapshot } from './sports-team-clarification';
import { CHAT_SESSION_TIMEOUT_MS, CONFIRM_WINDOW_MS } from '../../chat/timeouts.cjs';

const name = z.string().trim().min(2).max(80).regex(/^[\p{L}\p{N}][\p{L}\p{N} .&'’()-]*$/u);
const detail = z.string().trim().min(1).max(80);

/** Unknown values are explicit nulls; a draft is never an executable action. */
export const PendingSportsRequestSchema = z.object({
  selections: z.array(z.object({ team: name.nullable(), opponent: name.nullable() }).strict())
    .min(1).max(SPORTS_MAX_ACCUMULATOR_SELECTIONS),
  competition: detail.nullable(),
  market: detail.nullable(),
  stakeCents: z.number().int().nonnegative().nullable(),
}).strict();
export type PendingSportsRequest = z.infer<typeof PendingSportsRequestSchema>;

// Every update quotes the current user message. Canonicalization happens below,
// rather than allowing the model to manufacture canonical field values.
const quotedDetail = z.object({ value: detail, evidence: z.string().trim().min(1).max(500) }).strict();
export const SportsRequestUpdatesSchema = z.object({
  selections: z.array(z.object({
    index: z.number().int().min(0).max(SPORTS_MAX_ACCUMULATOR_SELECTIONS - 1),
    team: quotedDetail.optional(),
    opponent: quotedDetail.optional(),
  }).strict().refine((item) => item.team !== undefined || item.opponent !== undefined, 'EMPTY_SELECTION_UPDATE'))
    .max(SPORTS_MAX_ACCUMULATOR_SELECTIONS).optional(),
  competition: quotedDetail.optional(),
  market: quotedDetail.optional(),
  totalStake: quotedDetail.optional(),
}).strict();

export const SportsInterpretationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new_request'), updates: SportsRequestUpdatesSchema }).strict(),
  z.object({ kind: z.literal('answer_to_clarification'), updates: SportsRequestUpdatesSchema }).strict(),
  z.object({ kind: z.literal('correction'), updates: SportsRequestUpdatesSchema }).strict(),
  z.object({ kind: z.literal('cancellation') }).strict(),
  z.object({ kind: z.literal('unrelated_message') }).strict(),
  z.object({ kind: z.literal('ambiguous_interpretation'), question: z.string().trim().min(1).max(300) }).strict(),
]);
export type SportsInterpretation = z.infer<typeof SportsInterpretationSchema>;
export type SportsRequestUpdates = z.infer<typeof SportsRequestUpdatesSchema>;

/** Existing slot/read-only commands keep their executable planner path. */
export function usesSportsConversation(message: string): boolean {
  if (/\b(?:slot|slots|spin|spins|casino)\b/i.test(message)) return false;
  const legacy = /^(?:inspect|verify|check|report|navigate|open|log\s?in)\b/i.test(message);
  const sports = /\b(?:soccer|football|premier league|accumulator|sports?\s+bet|to beat|to win|vs\.?|versus)\b/i.test(message)
    || /^(?:prepare|place|bet|choose|select)\b/i.test(message);
  return sports || !legacy;
}

export function emptySportsRequest(): PendingSportsRequest {
  return { selections: [{ team: null, opponent: null }], competition: null, market: null, stakeCents: null };
}

export function missingSportsDetails(request: PendingSportsRequest): string[] {
  const parsed = PendingSportsRequestSchema.parse(request);
  const missing: string[] = [];
  parsed.selections.forEach((selection, index) => {
    if (selection.team === null) missing.push(`selections.${index}.team`);
    if (selection.opponent === null) missing.push(`selections.${index}.opponent`);
  });
  for (const field of ['competition', 'market', 'stakeCents'] as const) {
    if (parsed[field] === null) missing.push(field);
  }
  return missing;
}

const words = (text: string) => text.trim().toLocaleLowerCase().replace(/\s+/g, ' ');

function grounded(update: z.infer<typeof quotedDetail>, message: string): string {
  if (!words(message).includes(words(update.evidence)) || !words(update.evidence).includes(words(update.value))) {
    throw new Error('UNGROUNDED_DETAIL');
  }
  return update.value.trim();
}

function competition(value: string): string {
  return /^(?:english\s+|england\s+)?premier\s+league$|^epl$|^premier-league$/i.test(value)
    ? 'premier-league' : value;
}

function market(value: string): string {
  return /\bto\s+(?:beat|win)\b|^match[ -]winner$|^full[ -]time\s+(?:result|winner)$|^1x2$/i.test(value)
    ? 'match-winner' : value;
}

function stake(value: string, pending: PendingSportsRequest | null, message: string): number {
  const explicit = /^(?:R\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*ZAR)$/i.exec(value);
  // Bare amounts are allowed only when answering a saved stake question or an
  // explicit stake correction. A number in a new request is not assumed money.
  const bare = /^\d+(?:\.\d{1,2})?$/.test(value)
    && ((pending !== null && pending.stakeCents === null && words(message) === words(value)) || /\bstake\b/i.test(message));
  const amount = explicit?.[1] ?? explicit?.[2] ?? (bare ? value : null);
  if (amount === null) throw new Error('STAKE_NOT_EXPLICIT');
  const [whole, fraction = ''] = amount.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('STAKE_INVALID');
  return cents;
}

export const ClarificationRequirementSchema = z.object({
  field: z.string().min(1),
  code: z.enum(['missing', 'invalid', 'unsupported', 'conflicting_answer', 'ambiguous_replacement',
    'expired', 'no_pending_request', 'SPORTS_STAKE_INVALID', 'SPORTS_STAKE_BELOW_MINIMUM',
    'SPORTS_STAKE_OVER_R50', 'SPORTS_STAKE_INCREMENT_INVALID', 'team_suggestion', 'fixture_ambiguous', 'fixture_not_found']),
  question: z.string().min(1),
}).strict();
export type ClarificationRequirement = z.infer<typeof ClarificationRequirementSchema>;

export const SportsConversationStateSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['idle', 'collecting', 'ready', 'cancelled', 'expired']),
  request: PendingSportsRequestSchema.nullable(),
  revision: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  confirmation: z.object({ revision: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative() }).strict().nullable(),
  // Resolutions use application-supplied read-only observations. These
  // transitions never obtain fixture evidence from a model or browser.
  fixtureResolutions: z.record(z.string(), z.object({ fixtureId: z.string().min(1), fixture: z.string().min(1),
    source: z.string().min(1).optional(), observedAt: z.number().int().nonnegative().optional() }).strict()),
  teamSuggestions: z.array(TeamSuggestionSchema).max(20).optional(),
  competitionResolution: CompetitionResolutionSchema.optional(),
  rejectedUpdates: z.array(ClarificationRequirementSchema),
  summaryRequired: z.boolean(),
  processedMessageIds: z.array(z.string().min(1).max(1000)).max(64),
  lastMessage: z.string().nullable(),
}).strict();
export type SportsConversationState = z.infer<typeof SportsConversationStateSchema>;

export const SportsConversationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), messageId: z.string().min(1).max(1000),
    message: z.string().trim().min(1).max(500), interpretation: SportsInterpretationSchema }).strict(),
  z.object({ type: z.literal('expire') }).strict(),
  z.object({ type: z.literal('summary_generated'), revision: z.number().int().nonnegative() }).strict(),
]);
export type SportsConversationEvent = z.infer<typeof SportsConversationEventSchema>;

export interface SportsConversationTransition {
  state: SportsConversationState;
  status: 'CLARIFICATION' | 'AMBIGUOUS' | 'UNRELATED' | 'CANCELLED' | 'EXPIRED' | 'UNCHANGED'
    | 'READY_FOR_SUMMARY' | 'SUMMARY_RECORDED';
  reason: string;
  requirements: ClarificationRequirement[];
  changed: boolean;
  confirmationInvalidated: boolean;
  /** A conversation transition never emits executable actions. */
  actions: [];
}

function requirement(field: string, code: ClarificationRequirement['code'], question: string): ClarificationRequirement {
  return { field, code, question };
}

function invalidStake(cents: number | null): ClarificationRequirement {
  const code = cents === null || !Number.isSafeInteger(cents) || cents < 0 ? 'SPORTS_STAKE_INVALID'
    : cents < SPORTS_STAKE_LIMITS.minCents ? 'SPORTS_STAKE_BELOW_MINIMUM'
    : cents > SPORTS_STAKE_LIMITS.maxCents ? 'SPORTS_STAKE_OVER_R50' : 'SPORTS_STAKE_INCREMENT_INVALID';
  return requirement('stakeCents', code, 'Provide a total stake from R1.00 through R50.00, with at most two decimal places.');
}

/** Validate supplied fields as well as missing fields, using existing stake rules. */
export function sportsClarificationRequirements(request: PendingSportsRequest): ClarificationRequirement[] {
  const requirements: ClarificationRequirement[] = [];
  request.selections.forEach((selection, index) => {
    for (const field of ['team', 'opponent'] as const) {
      if (selection[field] === null) requirements.push(requirement(`selections.${index}.${field}`, 'missing',
        field === 'opponent' && selection.team ? `Who is ${selection.team} playing?` : `Which team do you mean for selection ${index + 1}?`));
    }
    if (selection.team !== null && selection.opponent !== null && words(selection.team) === words(selection.opponent)) {
      requirements.push(requirement(`selections.${index}.opponent`, 'invalid', `Selection ${index + 1} needs two different teams. Which opponent?`));
    }
  });
  for (const [field, supported, question] of [
    ['competition', 'premier-league', 'Which competition do you mean? This flow supports Premier League.'],
    ['market', 'match-winner', 'Which market would you like? This flow supports match winner.'],
  ] as const) {
    if (request[field] === null) requirements.push(requirement(field, 'missing', question));
    else if (request[field] !== supported) requirements.push(requirement(field, 'unsupported', question));
  }
  if (request.stakeCents === null) requirements.push(requirement('stakeCents', 'missing', 'What total stake would you like to use?'));
  else if (!validateSportsStakeCents(request.stakeCents, SPORTS_STAKE_LIMITS)) requirements.push(invalidStake(request.stakeCents));
  return requirements;
}

export function requirementsFor(state: SportsConversationState): ClarificationRequirement[] {
  const byField = new Map((state.request ? sportsClarificationRequirements(state.request) : []).map((issue) => [issue.field, issue]));
  for (const issue of state.rejectedUpdates) byField.set(issue.field, issue);
  return [...byField.values()];
}

export function createSportsConversationState(request: PendingSportsRequest | null = null, now = 0): SportsConversationState {
  const parsed = request === null ? null : PendingSportsRequestSchema.parse(request);
  const complete = parsed !== null && sportsClarificationRequirements(parsed).length === 0;
  return { version: 1, request: parsed, phase: parsed ? complete ? 'ready' : 'collecting' : 'idle',
    revision: 0, expiresAt: parsed ? now + CHAT_SESSION_TIMEOUT_MS : null, confirmation: null,
    fixtureResolutions: {}, rejectedUpdates: [], summaryRequired: complete,
    processedMessageIds: [], lastMessage: null };
}

/** Pure, clock-driven transition function. No model, I/O, plan execution or browser. */
export function transitionSportsConversation(
  input: SportsConversationState, event: SportsConversationEvent, now: number, fixtureSnapshot?: FixtureSnapshot | null,
): SportsConversationTransition {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_CONVERSATION_TIME');
  fixtureSnapshot = usableFixtureSnapshot(fixtureSnapshot, now);
  event = SportsConversationEventSchema.parse(event);
  const original = SportsConversationStateSchema.parse(input);
  let state = structuredClone(original);
  let confirmationInvalidated = false;
  let expired = state.phase === 'expired';
  const finish = (status: SportsConversationTransition['status'], reason: string,
    requirements = requirementsFor(state)): SportsConversationTransition => ({
    state, status, reason, requirements, changed: JSON.stringify(state) !== JSON.stringify(original),
    confirmationInvalidated, actions: [],
  });
  const expire = () => {
    confirmationInvalidated = state.request !== null || state.confirmation !== null;
    state = { ...createSportsConversationState(), phase: 'expired', revision: state.revision + 1,
      processedMessageIds: state.processedMessageIds };
    expired = true;
  };
  if (state.request && state.expiresAt !== null && now >= state.expiresAt) expire();
  if (state.confirmation && now >= state.confirmation.expiresAt) {
    state.confirmation = null;
    state.summaryRequired = true;
    confirmationInvalidated = true;
  }
  const expiredRequirement = requirement('request', 'expired', 'The previous request expired. Start a new request; a short answer cannot restore it.');
  if (event.type === 'expire') {
    return expired ? finish('EXPIRED', expiredRequirement.question, [expiredRequirement]) : finish('UNCHANGED', 'The request has not expired.');
  }
  if (event.type === 'summary_generated') {
    if (expired) return finish('EXPIRED', expiredRequirement.question, [expiredRequirement]);
    if (!state.request || event.revision !== state.revision || requirementsFor(state).length || !state.summaryRequired) {
      return finish('UNCHANGED', 'No fresh summary is available for that revision.');
    }
    state.confirmation = { revision: state.revision, expiresAt: now + CONFIRM_WINDOW_MS };
    state.summaryRequired = false;
    return finish('SUMMARY_RECORDED', 'Summary recorded. Confirm and run authorizes preparation only; submission requires a separate explicit chat button after review.');
  }
  const interpretation = SportsInterpretationSchema.parse(event.interpretation);
  if (state.processedMessageIds.includes(event.messageId) || (state.lastMessage !== null && words(event.message) === state.lastMessage)) {
    if (expired) return finish('EXPIRED', expiredRequirement.question, [expiredRequirement]);
    return finish('UNCHANGED', 'This message was already handled. Use the existing summary or provide a correction.');
  }
  const receipt = () => {
    state.processedMessageIds = [...state.processedMessageIds, event.messageId].slice(-64);
    state.lastMessage = words(event.message);
  };
  if (interpretation.kind === 'cancellation') {
    confirmationInvalidated = state.request !== null || state.confirmation !== null;
    state = { ...createSportsConversationState(), phase: 'cancelled', revision: state.revision + 1,
      processedMessageIds: state.processedMessageIds };
    receipt();
    return finish('CANCELLED', 'Cancelled. Nothing was run.');
  }
  if (expired && (interpretation.kind === 'unrelated_message' || interpretation.kind === 'ambiguous_interpretation')) {
    return finish('EXPIRED', expiredRequirement.question, [expiredRequirement]);
  }
  if (interpretation.kind === 'unrelated_message') return finish('UNRELATED', 'Your pending sports request is unchanged.');
  if (interpretation.kind === 'ambiguous_interpretation') return finish('AMBIGUOUS',
    requirementsFor(state)[0]?.question ?? 'Please specify the sports preparation details or the detail you want to correct.');
  if (expired && interpretation.kind === 'new_request'
    && !/^(?:prepare|place|bet|choose|select|new request|start over|replace)\b/i.test(event.message.trim())) {
    return finish('EXPIRED', expiredRequirement.question, [expiredRequirement]);
  }
  if (interpretation.kind !== 'new_request' && !state.request) {
    return expired ? finish('EXPIRED', expiredRequirement.question, [expiredRequirement])
      : finish('CLARIFICATION', 'There is no pending request. Please start a sports preparation request.',
        [requirement('request', 'no_pending_request', 'Which sports request would you like to prepare?')]);
  }
  if (state.request && interpretation.kind === 'new_request'
    && !/\bnew request\b|\bstart over\b|\breplace\s+(?:(?:the|my|this|existing)\s+)?request\b/i.test(event.message)) {
    const issue = requirement('request', 'ambiguous_replacement', 'Replace the current request or correct it? Say “New request: …” to replace it, or name the detail to correct.');
    state.rejectedUpdates = [...state.rejectedUpdates.filter((item) => item.field !== 'request'), issue];
    confirmationInvalidated = true;
    state.confirmation = null;
    state.summaryRequired = false;
    state.phase = 'collecting';
    state.revision++;
    receipt();
    return finish('CLARIFICATION', issue.question);
  }
  const isNew = interpretation.kind === 'new_request';
  const correction = interpretation.kind === 'correction';
  if (isNew) {
    const revision = state.revision;
    const processedMessageIds = state.processedMessageIds;
    confirmationInvalidated = state.request !== null || state.confirmation !== null;
    state = createSportsConversationState(emptySportsRequest(), now);
    state.revision = revision;
    state.processedMessageIds = processedMessageIds;
  }
  const request = state.request!;
  const updates = interpretation.updates;
  // Grounding and target validation are atomic. Invalid field VALUES below are
  // rejected independently so an invalid stake cannot discard valid selections.
  try {
    const seen = new Set<number>();
    let length = request.selections.length;
    for (const update of updates.selections ?? []) {
      if (seen.has(update.index) || update.index > length) throw new Error('AMBIGUOUS_SELECTION');
      seen.add(update.index);
      if (update.index === length) length++;
      for (const field of ['team', 'opponent'] as const) if (update[field]) grounded(update[field], event.message);
    }
    for (const field of ['competition', 'market', 'totalStake'] as const) if (updates[field]) grounded(updates[field], event.message);
  } catch {
    state = structuredClone(original);
    // Never resurrect an expired request when grounding fails.
    if (expired && original.request) expire();
    return finish('AMBIGUOUS', 'Please identify the selection and the detail to add or correct. Saved details are unchanged.');
  }
  const beforeRequest = JSON.stringify(request);
  const beforeIssues = JSON.stringify(state.rejectedUpdates);
  const rejected = new Map(state.rejectedUpdates.map((issue) => [issue.field, issue]));
  if (correction) rejected.delete('request');
  const invalidCurrent = new Set(sportsClarificationRequirements(request).filter((issue) => issue.code !== 'missing').map((issue) => issue.field));
  let supplied = answerTeamSuggestions(state, event.message);
  function assign<T extends string | number>(field: string, current: T | null, next: T): T | null {
    supplied++;
    if (current !== null && current !== next && !correction && !invalidCurrent.has(field)) {
      rejected.set(field, requirement(field, 'conflicting_answer', `A value for ${field} is already saved. Explicitly correct it to change it.`));
      return current;
    }
    rejected.delete(field);
    return next;
  }
  for (const update of updates.selections ?? []) {
    if (update.index === request.selections.length) request.selections.push({ team: null, opponent: null });
    const selection = request.selections[update.index];
    for (const field of ['team', 'opponent'] as const) {
      if (!update[field]) continue;
      const target = `selections.${update.index}.${field}`;
      const value = name.safeParse(update[field].value);
      if (!value.success) {
        supplied++;
        rejected.set(target, requirement(target, 'invalid', `Provide a valid ${field} for selection ${update.index + 1}.`));
        continue;
      }
      const previous = selection[field];
      selection[field] = assign(target, previous === null ? null : establishedTeamName(previous), establishedTeamName(value.data));
      if (previous !== selection[field]) {
        delete state.fixtureResolutions[String(update.index)];
        rejected.delete(`selections.${update.index}.fixture`);
        if (state.competitionResolution) { request.competition = null; delete state.competitionResolution; }
      }
    }
  }
  if (updates.competition) {
    const previous = request.competition;
    request.competition = assign('competition', previous, competition(updates.competition.value));
    if (previous !== request.competition) state.fixtureResolutions = {};
    if (request.competition === competition(updates.competition.value)) delete state.competitionResolution;
  }
  if (updates.market) request.market = assign('market', request.market, market(updates.market.value));
  if (updates.totalStake) {
    let parsed: number | null = null;
    try { parsed = stake(updates.totalStake.value, original.request, event.message); } catch { /* targeted rejection below */ }
    if (parsed === null || !validateSportsStakeCents(parsed, SPORTS_STAKE_LIMITS)) {
      supplied++;
      rejected.set('stakeCents', invalidStake(parsed));
      // Retain an earlier VALID stake for display, but the rejected correction
      // blocks readiness until a valid answer resolves it.
      if (request.stakeCents !== null && !validateSportsStakeCents(request.stakeCents, SPORTS_STAKE_LIMITS)) request.stakeCents = null;
    } else request.stakeCents = assign('stakeCents', request.stakeCents, parsed);
  }
  const fixtureAnswer = fixtureSnapshot && state.rejectedUpdates.some((issue) => issue.code === 'fixture_ambiguous')
    && fixtureSnapshot.fixtures.some((fixture) => event.message.includes(fixture.kickoff) || event.message === fixture.id);
  if (!supplied && !isNew && !fixtureAnswer) {
    const suggestions = requirementsFor(state).filter((issue) => issue.code === 'team_suggestion');
    return suggestions.length
      ? finish('CLARIFICATION', suggestions.map((issue) => issue.question).join(' '))
      : finish('AMBIGUOUS', 'Please provide a missing detail or use the confirmation buttons.');
  }
  state.rejectedUpdates = [...rejected.values()];
  clarifyTeamsAndFixtures(state, fixtureSnapshot, now, event.message);
  const contentChanged = beforeRequest !== JSON.stringify(request) || beforeIssues !== JSON.stringify(state.rejectedUpdates)
    || JSON.stringify(original.fixtureResolutions) !== JSON.stringify(state.fixtureResolutions);
  if (contentChanged || correction || isNew) {
    confirmationInvalidated = true;
    state.confirmation = null;
    state.revision++;
    state.expiresAt = now + CHAT_SESSION_TIMEOUT_MS;
  }
  receipt();
  const requirements = requirementsFor(state);
  if (requirements.length) {
    state.phase = 'collecting';
    state.summaryRequired = false;
    return finish('CLARIFICATION', requirements.map((issue) => issue.question).join(' '), requirements);
  }
  state.phase = 'ready';
  if (contentChanged || correction || isNew || state.summaryRequired) {
    state.summaryRequired = true;
    return finish('READY_FOR_SUMMARY', 'All required details are valid. A fresh summary is required before confirmation.', []);
  }
  return finish('UNCHANGED', 'The saved request has not changed. Use the existing confirmation summary.', []);
}

type ConversationResponseBase = {
  pendingSports: PendingSportsRequest | null;
  conversationState: SportsConversationState;
  requirements: ClarificationRequirement[];
  changed: boolean;
  confirmationInvalidated: boolean;
};
export type SportsConversationResult = ConversationResponseBase & ({
  status: 'CLARIFICATION' | 'AMBIGUOUS' | 'UNRELATED' | 'CANCELLED' | 'EXPIRED' | 'UNCHANGED' | 'BLOCKED';
  reason: string;
  actions: [];
} | {
  status: 'PLANNED';
  plan: z.infer<typeof PlannerPlanSchema>;
  auth: true;
  wager: true;
});

/** Adapter to the existing summary/confirmation contract; never starts execution. */
export function reduceSportsConversation(
  pendingInput: PendingSportsRequest | null,
  interpretation: SportsInterpretation,
  message: string,
  options: { state?: SportsConversationState; now?: number; messageId?: string; fixtureSnapshot?: FixtureSnapshot | null } = {},
): SportsConversationResult {
  const now = options.now ?? Date.now();
  const state = options.state ?? createSportsConversationState(pendingInput, now);
  const result = transitionSportsConversation(state, {
    type: 'message', messageId: options.messageId ?? message, message, interpretation,
  }, now, options.fixtureSnapshot);
  const base = { pendingSports: result.state.request, conversationState: result.state,
    requirements: result.requirements, changed: result.changed, confirmationInvalidated: result.confirmationInvalidated };
  if (result.status !== 'READY_FOR_SUMMARY') {
    return { ...base, status: result.status === 'SUMMARY_RECORDED' ? 'UNCHANGED' : result.status, reason: result.reason, actions: [] };
  }
  const request = result.state.request!;
  const parsed = PlannerPlanSchema.safeParse({ thought: 'Prepare the requested sports betslip for manual review.', actions: [{
    type: 'prepare_sports_bet', competition: request.competition, selections: request.selections,
    market: request.market, stakeCents: request.stakeCents, submit: false,
  }] });
  if (!parsed.success) return { ...base, status: 'BLOCKED', reason: 'The saved details do not form a supported preparation plan.', actions: [] };
  const recorded = transitionSportsConversation(result.state, { type: 'summary_generated', revision: result.state.revision }, now);
  return { ...base, conversationState: recorded.state, status: 'PLANNED', plan: parsed.data, auth: true, wager: true };
}
