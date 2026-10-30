import { describe, expect, it } from 'vitest';
import {
  createSportsConversationState, transitionSportsConversation, reduceSportsConversation,
  type PendingSportsRequest, type SportsConversationState, type SportsInterpretation,
} from '../../src/agent/sports-conversation';
import { CHAT_SESSION_TIMEOUT_MS, CONFIRM_WINDOW_MS } from '../../chat/timeouts.cjs';

const now = 1000;
const quoted = (value: string) => ({ value, evidence: value });
const request = (): PendingSportsRequest => ({
  selections: [{ team: 'Arsenal', opponent: 'Chelsea' }], competition: 'premier-league', market: 'match-winner', stakeCents: 1000,
});
const reply = (state: SportsConversationState, message: string, interpretation: SportsInterpretation, id = message, at = now + 1) =>
  transitionSportsConversation(state, { type: 'message', messageId: id, message, interpretation }, at);
const summary = (state: SportsConversationState, at = now) =>
  transitionSportsConversation(state, { type: 'summary_generated', revision: state.revision }, at);

describe('pure sports conversation state transitions', () => {
  it.each(['unrelated_message', 'ambiguous_interpretation'] as const)('reports expiry accurately for a late %s reply', (kind) => {
    const state = createSportsConversationState(request(), now);
    const interpretation: SportsInterpretation = kind === 'unrelated_message' ? { kind } : { kind, question: 'Model question' };
    const result = reply(state, 'hello', interpretation, 'late-unrelated', state.expiresAt!);
    expect(result.status).toBe('EXPIRED');
    expect(result.state.request).toBeNull();
    expect(result.requirements[0].code).toBe('expired');
    expect(result.actions).toEqual([]);
  });
  it('1. merges “R10” into a missing stake and requires a summary without emitting executable actions', () => {
    const initial = createSportsConversationState({ ...request(), stakeCents: null }, now);
    const result = reply(initial, 'R10', { kind: 'answer_to_clarification', updates: { totalStake: quoted('R10') } });
    expect(result).toMatchObject({ status: 'READY_FOR_SUMMARY', requirements: [], actions: [], state: {
      request: request(), summaryRequired: true, confirmation: null,
    } });
    expect(result).not.toHaveProperty('plan');
    expect(initial.request?.stakeCents).toBeNull();
  });

  it('2. merges “Brighton” into a missing opponent, preserving the stake, market, team and competition', () => {
    const initial = createSportsConversationState({ ...request(), selections: [{ team: 'Arsenal', opponent: null }] }, now);
    const result = reply(initial, 'Brighton', { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, opponent: quoted('Brighton') }],
    } });
    expect(result.state.request).toEqual({ ...request(), selections: [{ team: 'Arsenal', opponent: 'Brighton' }] });
    expect(result.status).toBe('READY_FOR_SUMMARY');
    expect(result.actions).toEqual([]);
  });

  it('3. applies “Actually, make it R20” as an explicit correction', () => {
    const initial = summary(createSportsConversationState(request(), now)).state;
    const corrected = reply(initial, 'Actually, make it R20', { kind: 'correction', updates: { totalStake: quoted('R20') } });
    expect(corrected).toMatchObject({ status: 'READY_FOR_SUMMARY', confirmationInvalidated: true,
      state: { request: { ...request(), stakeCents: 2000 }, confirmation: null, summaryRequired: true } });
    const ambiguous = reply(initial, 'R20', { kind: 'answer_to_clarification', updates: { totalStake: quoted('R20') } });
    expect(ambiguous.state.request?.stakeCents).toBe(1000);
    expect(ambiguous.requirements).toContainEqual(expect.objectContaining({ field: 'stakeCents', code: 'conflicting_answer' }));
  });

  it('4. rejects an invalid stake while retaining valid details, then accepts a corrected stake answer', () => {
    const initial = createSportsConversationState({ ...request(), stakeCents: null }, now);
    const invalid = reply(initial, 'R0.50', { kind: 'answer_to_clarification', updates: { totalStake: quoted('R0.50') } });
    expect(invalid).toMatchObject({ status: 'CLARIFICATION', actions: [], state: {
      request: { ...request(), stakeCents: null }, confirmation: null,
    } });
    expect(invalid.requirements).toEqual([expect.objectContaining({ field: 'stakeCents', code: 'SPORTS_STAKE_BELOW_MINIMUM' })]);
    const corrected = reply(invalid.state, 'R10', { kind: 'answer_to_clarification', updates: { totalStake: quoted('R10') } }, 'corrected', now + 2);
    expect(corrected).toMatchObject({ status: 'READY_FOR_SUMMARY', requirements: [], state: { request: request() }, actions: [] });
  });

  it('retains valid selection answers from a message with a malformed stake', () => {
    const initial = createSportsConversationState({ ...request(), selections: [{ team: 'Arsenal', opponent: null }], stakeCents: null }, now);
    const result = reply(initial, 'Brighton, R1.001 total', { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, opponent: quoted('Brighton') }], totalStake: quoted('R1.001'),
    } });
    expect(result.state.request).toEqual({ ...request(), selections: [{ team: 'Arsenal', opponent: 'Brighton' }], stakeCents: null });
    expect(result.requirements).toEqual([expect.objectContaining({ field: 'stakeCents', code: 'SPORTS_STAKE_INVALID' })]);
  });

  it.each(['R0', 'R0.99', 'R50.01', 'R100', 'R1.001', '-R5'])('rejects %s using the existing stake limits and precision rules', (amount) => {
    const result = reply(createSportsConversationState({ ...request(), stakeCents: null }, now), amount,
      { kind: 'answer_to_clarification', updates: { totalStake: quoted(amount) } });
    expect(result.status).toBe('CLARIFICATION');
    expect(result.state.request?.stakeCents).toBeNull();
    expect(result.requirements[0].field).toBe('stakeCents');
    expect(result.actions).toEqual([]);
  });

  it('invalid stake corrections invalidate an old summary but keep an earlier valid amount for display', () => {
    const initial = summary(createSportsConversationState(request(), now)).state;
    const result = reply(initial, 'Actually, make it R100', { kind: 'correction', updates: { totalStake: quoted('R100') } });
    expect(result).toMatchObject({ status: 'CLARIFICATION', confirmationInvalidated: true,
      state: { request: request(), confirmation: null, summaryRequired: false } });
    expect(summary(result.state, now + 2).status).toBe('UNCHANGED');
    const corrected = reply(result.state, 'Actually, make it R20', { kind: 'correction', updates: { totalStake: quoted('R20') } }, 'valid-correction', now + 3);
    expect(corrected.status).toBe('READY_FOR_SUMMARY');
    expect(corrected.requirements).toEqual([]);
  });

  it('5. cancellation clears the request, fixture resolution and confirmation without execution', () => {
    const initial = summary(createSportsConversationState(request(), now)).state;
    initial.fixtureResolutions['0'] = { fixtureId: 'fixture-1', fixture: 'Arsenal vs Chelsea' };
    const cancelled = reply(initial, 'Cancel', { kind: 'cancellation' });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', confirmationInvalidated: true, actions: [], state: {
      phase: 'cancelled', request: null, fixtureResolutions: {}, confirmation: null, expiresAt: null,
    } });
    const later = reply(cancelled.state, 'R10', { kind: 'answer_to_clarification', updates: { totalStake: quoted('R10') } }, 'later', now + 2);
    expect(later.state.request).toBeNull();
    expect(later.requirements[0].code).toBe('no_pending_request');
  });

  it('6. expires at the existing idle deadline and cannot restore the request with a short answer', () => {
    const initial = createSportsConversationState({ ...request(), stakeCents: null }, now);
    expect(transitionSportsConversation(initial, { type: 'expire' }, now + CHAT_SESSION_TIMEOUT_MS - 1).state).toEqual(initial);
    const expired = transitionSportsConversation(initial, { type: 'expire' }, now + CHAT_SESSION_TIMEOUT_MS);
    expect(expired).toMatchObject({ status: 'EXPIRED', state: { request: null, confirmation: null, fixtureResolutions: {} }, actions: [] });
    const later = reply(expired.state, 'R10', { kind: 'answer_to_clarification', updates: { totalStake: quoted('R10') } }, 'late', now + CHAT_SESSION_TIMEOUT_MS + 1);
    expect(later).toMatchObject({ status: 'EXPIRED', state: { request: null }, requirements: [expect.objectContaining({ field: 'request', code: 'expired' })], actions: [] });
    const immediate = reply(initial, 'Brighton', { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, opponent: quoted('Brighton') }],
    } }, 'late-direct', now + CHAT_SESSION_TIMEOUT_MS);
    expect(immediate.status).toBe('EXPIRED');
    expect(immediate.state.request).toBeNull();
  });

  it('uses the existing two-minute confirmation deadline without allowing a repeated message to execute', () => {
    const filled = reply(createSportsConversationState({ ...request(), stakeCents: null }, now), 'R10',
      { kind: 'answer_to_clarification', updates: { totalStake: quoted('R10') } }, 'stake');
    const recorded = summary(filled.state, now + 2);
    expect(recorded.state.confirmation?.expiresAt).toBe(now + 2 + CONFIRM_WINDOW_MS);
    const replay = reply(recorded.state, 'R10', { kind: 'answer_to_clarification', updates: { totalStake: quoted('R10') } }, 'stake', now + 2 + CONFIRM_WINDOW_MS);
    expect(replay).toMatchObject({ status: 'UNCHANGED', confirmationInvalidated: true, actions: [], state: { confirmation: null } });
  });

  it('does not let a new-request interpretation revive an expired request from a short answer', () => {
    const initial = createSportsConversationState({ ...request(), stakeCents: null }, now);
    const expired = transitionSportsConversation(initial, { type: 'expire' }, now + CHAT_SESSION_TIMEOUT_MS).state;
    const short = reply(expired, 'R10', { kind: 'new_request', updates: { totalStake: quoted('R10') } }, 'new-but-short', now + CHAT_SESSION_TIMEOUT_MS + 1);
    expect(short).toMatchObject({ status: 'EXPIRED', state: { request: null }, actions: [] });
    const fresh = reply(expired, 'Prepare Arsenal to win', { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quoted('Arsenal') }], market: quoted('to win'),
    } }, 'fresh', now + CHAT_SESSION_TIMEOUT_MS + 2);
    expect(fresh.state.request).toEqual({ selections: [{ team: 'Arsenal', opponent: null }],
      competition: null, market: 'match-winner', stakeCents: null });
  });

  it('7. unrelated replies leave the complete state unchanged', () => {
    const initial = summary(createSportsConversationState(request(), now)).state;
    const result = reply(initial, 'How is the weather?', { kind: 'unrelated_message' });
    expect(result).toMatchObject({ status: 'UNRELATED', changed: false, confirmationInvalidated: false, actions: [] });
    expect(result.state).toEqual(initial);
  });

  it('8. asks before replacing an existing pending request when the intent is ambiguous', () => {
    const initial = summary(createSportsConversationState(request(), now)).state;
    const updates = { selections: [{ index: 0, team: quoted('Liverpool') }], market: quoted('to win') };
    const possible = reply(initial, 'Prepare Liverpool to win', { kind: 'new_request', updates });
    expect(possible.state.request).toEqual(initial.request);
    expect(possible.requirements).toContainEqual(expect.objectContaining({ field: 'request', code: 'ambiguous_replacement' }));
    expect(possible.state.confirmation).toBeNull();
    expect(possible.actions).toEqual([]);
    const explicit = reply(possible.state, 'New request: Liverpool to win', { kind: 'new_request', updates }, 'explicit', now + 2);
    expect(explicit.state.request).toEqual({ selections: [{ team: 'Liverpool', opponent: null }],
      competition: null, market: 'match-winner', stakeCents: null });
  });

  it('9. corrections after a generated summary invalidate the confirmation and require a fresh revision', () => {
    const initial = summary(createSportsConversationState(request(), now)).state;
    initial.fixtureResolutions['0'] = { fixtureId: 'fixture-1', fixture: 'Arsenal vs Chelsea' };
    const corrected = reply(initial, 'Actually, opponent is Brighton', { kind: 'correction', updates: {
      selections: [{ index: 0, opponent: quoted('Brighton') }],
    } });
    expect(corrected).toMatchObject({ status: 'READY_FOR_SUMMARY', confirmationInvalidated: true, actions: [], state: {
      confirmation: null, summaryRequired: true, fixtureResolutions: {}, revision: initial.revision + 1,
    } });
    expect(transitionSportsConversation(corrected.state, { type: 'summary_generated', revision: initial.revision }, now + 2).state.confirmation).toBeNull();
    const fresh = summary(corrected.state, now + 3);
    expect(fresh.status).toBe('SUMMARY_RECORDED');
    expect(fresh.state.confirmation?.revision).toBe(corrected.state.revision);
    expect(fresh.actions).toEqual([]);
  });

  it.each(['team', 'opponent'] as const)('changing a %s invalidates only that leg’s previous fixture resolution', (field) => {
    const initial = createSportsConversationState({ ...request(), selections: [
      { team: 'Arsenal', opponent: 'Chelsea' }, { team: 'Liverpool', opponent: 'Everton' },
    ] }, now);
    initial.fixtureResolutions = {
      '0': { fixtureId: 'a', fixture: 'Arsenal vs Chelsea' }, '1': { fixtureId: 'b', fixture: 'Liverpool vs Everton' },
    };
    const result = reply(initial, 'Actually Brighton', { kind: 'correction', updates: {
      selections: [{ index: 0, [field]: quoted('Brighton') }],
    } });
    expect(result.state.fixtureResolutions).toEqual({ '1': initial.fixtureResolutions['1'] });
    expect(initial.fixtureResolutions['0']).toBeDefined();
  });

  it('does not duplicate summaries or actions for repeated message IDs or repeated text', () => {
    const initial = createSportsConversationState({ ...request(), stakeCents: null }, now);
    const event: SportsInterpretation = { kind: 'answer_to_clarification', updates: { totalStake: quoted('R10') } };
    const filled = reply(initial, 'R10', event, 'receipt');
    const recorded = summary(filled.state, now + 2).state;
    for (const id of ['receipt', 'different-http-request']) {
      const duplicate = reply(recorded, 'R10', event, id, now + 3);
      expect(duplicate).toMatchObject({ status: 'UNCHANGED', changed: false, confirmationInvalidated: false, actions: [] });
      expect(duplicate.state).toEqual(recorded);
    }
    const adapter = reduceSportsConversation(recorded.request, event, 'R10', { state: recorded, now: now + 3, messageId: 'receipt' });
    expect(adapter.status).toBe('UNCHANGED');
    expect(adapter).not.toHaveProperty('plan');
    expect(adapter).toHaveProperty('actions', []);
    expect(summary(recorded, now + 3).status).toBe('UNCHANGED');
  });

  it('reports targeted missing and invalid fields instead of a generic refusal', () => {
    const initial = createSportsConversationState({ ...request(), competition: 'La Liga', market: null, stakeCents: null }, now);
    const result = reply(initial, 'R51', { kind: 'answer_to_clarification', updates: { totalStake: quoted('R51') } });
    expect(result.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'competition', code: 'unsupported' }),
      expect.objectContaining({ field: 'market', code: 'missing' }),
      expect.objectContaining({ field: 'stakeCents', code: 'SPORTS_STAKE_OVER_R50' }),
    ]));
  });

  it('keeps message receipts across replacement and cancellation so delayed retries cannot restore an old draft', () => {
    const start = reply(createSportsConversationState(), 'New request: Arsenal to win', { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quoted('Arsenal') }], market: quoted('to win'),
    } }, 'original');
    const replacement = reply(start.state, 'New request: Liverpool to win', { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quoted('Liverpool') }], market: quoted('to win'),
    } }, 'replacement', now + 2);
    const replay = reply(replacement.state, 'New request: Arsenal to win', { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quoted('Arsenal') }], market: quoted('to win'),
    } }, 'original', now + 3);
    expect(replay.status).toBe('UNCHANGED');
    expect(replay.state.request?.selections[0].team).toBe('Liverpool');
    const cancelled = reply(replay.state, 'cancel', { kind: 'cancellation' }, 'cancel', now + 4);
    const cancelledReplay = reply(cancelled.state, 'New request: Liverpool to win', { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quoted('Liverpool') }], market: quoted('to win'),
    } }, 'replacement', now + 5);
    expect(cancelledReplay.status).toBe('UNCHANGED');
    expect(cancelledReplay.state.request).toBeNull();
    expect(cancelledReplay.actions).toEqual([]);
  });
});
