import { describe, expect, it, vi } from 'vitest';
import { createSportsConversationState, reduceSportsConversation, type SportsConversationState, type SportsInterpretation } from '../../src/agent/sports-conversation';
import { canonicalTeamName, establishedTeamName } from '../../src/agent/sports-fixtures';
import { teamCandidates, usableFixtureSnapshot, type FixtureSnapshot } from '../../src/agent/sports-team-clarification';
import { interpretSportsTurn } from '../../src/agent/sports-interpreter';

const now = 1000;
const q = (value: string) => ({ value, evidence: value });
const snapshot = (fixtures?: FixtureSnapshot['fixtures']): FixtureSnapshot => ({ source: 'verified-read-only-cache', observedAt: now,
  fixtures: fixtures ?? [{ id: 'city-brighton', home: 'Manchester City', away: 'Brighton', competition: 'premier-league', kickoff: '2026-10-31T17:00:00Z' }] });
const start = (team = 'Man Ctiy', fixtureSnapshot?: FixtureSnapshot | null, extra = {}) => {
  const message = `Prepare ${team} to beat Brighton in Premier League for R10`;
  return reduceSportsConversation(null, { kind: 'new_request', updates: {
    selections: [{ index: 0, team: q(team), opponent: q('Brighton') }], competition: q('Premier League'), market: q('to beat'), totalStake: q('R10'),
    ...extra,
  } }, message, { now, fixtureSnapshot });
};
const reply = (state: SportsConversationState, message: string, interpretation: SportsInterpretation, fixtureSnapshot?: FixtureSnapshot | null) =>
  reduceSportsConversation(state.request, interpretation, message, { state, now: now + 1, fixtureSnapshot });

describe('team names and verified fixture clarification', () => {
  it.each(['Man City', 'Manchester City', 'manchester city'])('resolves established alias %s without asking for typo acceptance', (team) => {
    expect(canonicalTeamName(team)).toBe('man city');
    expect(establishedTeamName(team)).toBe('Man City');
    const result = start(team);
    expect(result.status).toBe('PLANNED');
    expect(result.pendingSports?.selections[0].team).toBe('Man City');
    expect(result.conversationState.teamSuggestions ?? []).toEqual([]);
  });

  it('offers one typo suggestion but keeps the original unconfirmed and blocks a summary', () => {
    const result = start();
    expect(result.status).toBe('CLARIFICATION');
    expect(result.pendingSports?.selections[0].team).toBe('Man Ctiy');
    expect(result.conversationState.teamSuggestions).toEqual([{ index: 0, field: 'team', original: 'Man Ctiy', candidates: ['Man City'] }]);
    expect(result.requirements).toContainEqual(expect.objectContaining({ code: 'team_suggestion', question: expect.stringContaining('Did you mean Man City') }));
    expect(result.conversationState.confirmation).toBeNull();
    expect(result).not.toHaveProperty('plan');
  });

  it('does not confirm a typo just because an unrelated field is supplied', () => {
    const state = start().conversationState;
    const result = reply(state, 'Actually, R20', { kind: 'correction', updates: { totalStake: q('R20') } });
    expect(result.pendingSports?.stakeCents).toBe(2000);
    expect(result.pendingSports?.selections[0].team).toBe('Man Ctiy');
    expect(result.status).toBe('CLARIFICATION');
    expect(result).not.toHaveProperty('plan');
  });

  it('accepts a single suggestion on yes without authorizing preparation', async () => {
    const state = start().conversationState;
    const model = { interpretSportsMessage: vi.fn() };
    const result = await interpretSportsTurn(model, 'Yes', state.request, { state, now: now + 1 });
    expect(model.interpretSportsMessage).not.toHaveBeenCalled();
    expect(result.pendingSports?.selections[0].team).toBe('Man City');
    expect(result.status).toBe('PLANNED');
    expect(result.conversationState.teamSuggestions).toEqual([]);
    if ('plan' in result) expect(result.plan?.actions[0]).toMatchObject({ submit: false });
  });

  it('rejects suggestions and asks for a replacement without losing other fields', async () => {
    const state = start().conversationState;
    const result = await interpretSportsTurn({ interpretSportsMessage: vi.fn() }, 'No', state.request, { state, now: now + 1 });
    expect(result.pendingSports?.selections[0].team).toBeNull();
    expect(result.pendingSports?.stakeCents).toBe(1000);
    expect(result.conversationState.teamSuggestions).toEqual([]);
    expect(result.status).toBe('CLARIFICATION');
    expect(result.requirements).toContainEqual(expect.objectContaining({ field: 'selections.0.team', code: 'missing' }));
  });

  it('asks which team when several aliases plausibly match; yes cannot choose one', async () => {
    const initial = start('Manchester');
    expect(initial.conversationState.teamSuggestions?.[0].candidates).toEqual(expect.arrayContaining(['Man City', 'Man Utd']));
    const result = await interpretSportsTurn({ interpretSportsMessage: vi.fn() }, 'Yes', initial.pendingSports,
      { state: initial.conversationState, now: now + 1 });
    expect(result.pendingSports?.selections[0].team).toBe('Manchester');
    expect(result).not.toHaveProperty('plan');
  });

  it('accepts a named option from several candidates', () => {
    const initial = start('Manchester');
    const result = reply(initial.conversationState, 'Man City', { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, team: q('Man City') }],
    } });
    expect(result.pendingSports?.selections[0].team).toBe('Man City');
    expect(result.status).toBe('PLANNED');
  });

  it('accepts a suggestion and a stake from the same modeled reply', async () => {
    const state = start('Man Ctiy', null, { totalStake: undefined }).conversationState;
    const model = { interpretSportsMessage: vi.fn().mockResolvedValue({ interpretation: { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, team: q('Man City') }], totalStake: q('R10'),
    } } }) };
    const result = await interpretSportsTurn(model, 'Yes, Man City, and R10', state.request, { state, now: now + 1 });
    expect(model.interpretSportsMessage.mock.calls[0][2].outstandingClarification.question).toContain('Did you mean Man City');
    expect(result.pendingSports?.selections[0].team).toBe('Man City');
    expect(result.pendingSports?.stakeCents).toBe(1000);
    expect(result.status).toBe('PLANNED');
  });

  it('resolves competition only from observed fixtures and records provenance', () => {
    const result = start('Man City', snapshot(), { competition: undefined });
    expect(result.status).toBe('PLANNED');
    expect(result.pendingSports?.competition).toBe('premier-league');
    expect(result.conversationState.competitionResolution).toEqual({ competition: 'premier-league', source: 'verified-read-only-cache',
      observedAt: now, fixtureIds: ['city-brighton'] });
    expect(result.conversationState.fixtureResolutions['0']).toMatchObject({ fixtureId: 'city-brighton', source: 'verified-read-only-cache', observedAt: now });
  });

  it('does not invent competition or opponents when a fixture source is unavailable', () => {
    const result = start('Man City', null, { competition: undefined, selections: [{ index: 0, team: q('Man City') }] });
    expect(result.pendingSports?.competition).toBeNull();
    expect(result.pendingSports?.selections[0].opponent).toBeNull();
    expect(result.conversationState.competitionResolution).toBeUndefined();
    expect(result.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'competition' }), expect.objectContaining({ field: 'selections.0.opponent' }),
    ]));
  });

  it('never selects an opponent even when exactly one verified fixture exists', () => {
    const result = start('Man City', snapshot(), { competition: undefined, selections: [{ index: 0, team: q('Man City') }] });
    expect(result.pendingSports?.competition).toBe('premier-league');
    expect(result.pendingSports?.selections[0].opponent).toBeNull();
    expect(result.requirements[0].question).toBe('Who is Man City playing?');
    expect(result.conversationState.fixtureResolutions).toEqual({});
  });

  it('asks for the opponent when multiple fixtures match, even with a unique competition', () => {
    const data = snapshot([...snapshot().fixtures, { id: 'city-arsenal', home: 'Man City', away: 'Arsenal', competition: 'premier-league', kickoff: '2026-11-07T17:00:00Z' }]);
    const result = start('Man City', data, { competition: undefined, selections: [{ index: 0, team: q('Man City') }] });
    expect(result.pendingSports?.selections[0].opponent).toBeNull();
    expect(result.pendingSports?.competition).toBe('premier-league');
    expect(result.requirements).toContainEqual(expect.objectContaining({ code: 'fixture_ambiguous', question: expect.stringContaining('Arsenal') }));
    expect(result).not.toHaveProperty('plan');
  });

  it('does not choose a fixture or competition when several competitions match', () => {
    const data = snapshot([...snapshot().fixtures, { ...snapshot().fixtures[0], id: 'cup-city-brighton', competition: 'fa-cup', kickoff: '2026-11-07T17:00:00Z' }]);
    const result = start('Man City', data, { competition: undefined });
    expect(result.pendingSports?.competition).toBeNull();
    expect(result.conversationState.competitionResolution).toBeUndefined();
    expect(result.requirements).toContainEqual(expect.objectContaining({ code: 'fixture_ambiguous' }));
    expect(result).not.toHaveProperty('plan');
  });

  it('accepts an explicit date to resolve fixture ambiguity', () => {
    const data = snapshot([...snapshot().fixtures, { ...snapshot().fixtures[0], id: 'later-city-brighton', kickoff: '2026-11-07T17:00:00Z' }]);
    const first = start('Man City', data);
    const result = reply(first.conversationState, '2026-11-07T17:00:00Z', { kind: 'answer_to_clarification', updates: {} }, data);
    expect(result.status).toBe('PLANNED');
    expect(result.conversationState.fixtureResolutions['0'].fixtureId).toBe('later-city-brighton');
  });

  it('uses a literal fixture answer without asking the model to resolve it', async () => {
    const data = snapshot([...snapshot().fixtures, { ...snapshot().fixtures[0], id: 'later-city-brighton', kickoff: '2026-11-07T17:00:00Z' }]);
    const first = start('Man City', data);
    const model = { interpretSportsMessage: vi.fn() };
    const result = await interpretSportsTurn(model, '2026-11-07T17:00:00Z', first.pendingSports,
      { state: first.conversationState, now: now + 1, fixtureSnapshot: data });
    expect(model.interpretSportsMessage).not.toHaveBeenCalled();
    expect(result.status).toBe('PLANNED');
    expect(result.conversationState.fixtureResolutions['0'].fixtureId).toBe('later-city-brighton');
  });

  it('does not use absent, stale, future-dated or malformed snapshots', () => {
    for (const data of [undefined, null, { ...snapshot(), observedAt: now + 1 }, { ...snapshot(), observedAt: 0 }, { fixtures: [] }]) {
      expect(usableFixtureSnapshot(data, now + 301_000)).toBeNull();
    }
    const result = start('Man City', { ...snapshot(), observedAt: now + 1 }, { competition: undefined });
    expect(result.pendingSports?.competition).toBeNull();
  });

  it('clears inferred competition and provenance when a team is corrected without a source', () => {
    const first = start('Man City', snapshot(), { competition: undefined });
    const result = reply(first.conversationState, 'Actually change Man City to Arsenal', { kind: 'correction', updates: {
      selections: [{ index: 0, team: q('Arsenal') }],
    } });
    expect(result.pendingSports?.competition).toBeNull();
    expect(result.conversationState.competitionResolution).toBeUndefined();
    expect(result.conversationState.fixtureResolutions).toEqual({});
    expect(result.conversationState.confirmation).toBeNull();
    expect(result.status).toBe('CLARIFICATION');
  });

  it('preserves explicitly supplied competition when correcting teams', () => {
    const first = start('Man City', snapshot());
    expect(first.conversationState.competitionResolution).toBeUndefined();
    const result = reply(first.conversationState, 'Actually change Man City to Arsenal', { kind: 'correction', updates: {
      selections: [{ index: 0, team: q('Arsenal') }],
    } });
    expect(result.pendingSports?.competition).toBe('premier-league');
    expect(result.conversationState.fixtureResolutions).toEqual({});
    expect(result.confirmationInvalidated).toBe(true);
  });

  it('gets fuzzy candidates from verified team names without treating the suggestion as accepted', () => {
    expect(teamCandidates('Brigthon', snapshot())).toContain('Brighton');
    const data = snapshot();
    const initial = createSportsConversationState({ selections: [{ team: 'Man City', opponent: null }], competition: 'premier-league', market: 'match-winner', stakeCents: 1000 }, now);
    const result = reply(initial, 'Brigthon', { kind: 'answer_to_clarification', updates: { selections: [{ index: 0, opponent: q('Brigthon') }] } }, data);
    expect(result.pendingSports?.selections[0].opponent).toBe('Brigthon');
    expect(result.status).toBe('CLARIFICATION');
    expect(result.conversationState.teamSuggestions?.[0].candidates).toEqual(['Brighton']);
  });

  it('retains a fixture-derived suggestion when the source becomes unavailable', () => {
    const state = createSportsConversationState({ selections: [{ team: 'Man City', opponent: null }], competition: 'premier-league', market: 'match-winner', stakeCents: null }, now);
    const first = reply(state, 'Brigthon', { kind: 'answer_to_clarification', updates: { selections: [{ index: 0, opponent: q('Brigthon') }] } }, snapshot());
    const next = reply(first.conversationState, 'R10', { kind: 'answer_to_clarification', updates: { totalStake: q('R10') } }, null);
    expect(next.pendingSports?.selections[0].opponent).toBe('Brigthon');
    expect(next.conversationState.teamSuggestions?.[0].candidates).toEqual(['Brighton']);
    expect(next.status).toBe('CLARIFICATION');
    expect(next).not.toHaveProperty('plan');
    const accepted = reply(next.conversationState, 'Yes', { kind: 'answer_to_clarification', updates: {} }, null);
    expect(accepted.pendingSports?.selections[0].opponent).toBe('Brighton');
    expect(accepted.status).toBe('PLANNED');
  });

  it('does not accept a mere uncertain mention of a suggested team', () => {
    const first = start();
    const result = reply(first.conversationState, 'Maybe Man City', { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, team: q('Man City') }],
    } });
    expect(result.pendingSports?.selections[0].team).toBe('Man Ctiy');
    expect(result.status).toBe('CLARIFICATION');
    expect(result).not.toHaveProperty('plan');
  });

  it('does not accept more than one pending typo with an untargeted yes', async () => {
    const state = createSportsConversationState({ selections: [{ team: null, opponent: null }], competition: 'premier-league', market: 'match-winner', stakeCents: 1000 }, now);
    const first = reply(state, 'Man Ctiy vs Brigthon', { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, team: q('Man Ctiy'), opponent: q('Brigthon') }],
    } }, snapshot());
    const next = await interpretSportsTurn({ interpretSportsMessage: vi.fn() }, 'Yes', first.pendingSports,
      { state: first.conversationState, now: now + 2, fixtureSnapshot: snapshot() });
    expect(next.pendingSports?.selections[0]).toEqual({ team: 'Man Ctiy', opponent: 'Brigthon' });
    expect(next.conversationState.teamSuggestions).toHaveLength(2);
    expect(next).not.toHaveProperty('plan');
  });

  it('supports cancellation, expiration and session-local pending suggestions', async () => {
    const first = start();
    const second = start('Manchester');
    const cancel = reply(first.conversationState, 'Cancel', { kind: 'cancellation' });
    expect(cancel.conversationState.teamSuggestions).toBeUndefined();
    expect(second.conversationState.teamSuggestions?.[0].original).toBe('Manchester');
    const expired = await interpretSportsTurn({ interpretSportsMessage: vi.fn() }, 'Yes', first.pendingSports,
      { state: first.conversationState, now: first.conversationState.expiresAt! });
    expect(expired.status).toBe('EXPIRED');
    expect(expired.pendingSports).toBeNull();
    expect(expired.conversationState.teamSuggestions).toBeUndefined();
  });
});
