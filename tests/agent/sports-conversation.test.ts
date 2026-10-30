import { describe, expect, it } from 'vitest';
import {
  emptySportsRequest, missingSportsDetails, PendingSportsRequestSchema,
  reduceSportsConversation, SportsInterpretationSchema, usesSportsConversation,
  type PendingSportsRequest, type SportsInterpretation,
} from '../../src/agent/sports-conversation';

const quote = (value: string) => ({ value, evidence: value });
const draft = (): PendingSportsRequest => ({
  selections: [{ team: 'Arsenal', opponent: 'Chelsea' }], competition: 'premier-league',
  market: 'match-winner', stakeCents: null,
});

describe('sports conversation schemas', () => {
  it('represents unknowns explicitly and rejects defaults, extra execution fields and invalid selections', () => {
    expect(missingSportsDetails(emptySportsRequest())).toEqual([
      'selections.0.team', 'selections.0.opponent', 'competition', 'market', 'stakeCents',
    ]);
    expect(PendingSportsRequestSchema.safeParse({ selections: [{ team: 'Arsenal' }] }).success).toBe(false);
    expect(PendingSportsRequestSchema.safeParse({ ...draft(), submit: true }).success).toBe(false);
    expect(PendingSportsRequestSchema.safeParse({ ...draft(), stakeCents: 101.1 }).success).toBe(false);
    expect(PendingSportsRequestSchema.safeParse({ ...draft(), selections: [] }).success).toBe(false);
    expect(PendingSportsRequestSchema.safeParse({ ...draft(), selections: Array(11).fill({ team: null, opponent: null }) }).success).toBe(false);
  });

  it('defines all six interpretation kinds and prevents executable or malformed interpretation payloads', () => {
    for (const kind of ['new_request', 'answer_to_clarification', 'correction']) {
      expect(SportsInterpretationSchema.safeParse({ kind, updates: {} }).success).toBe(true);
    }
    for (const kind of ['cancellation', 'unrelated_message']) {
      expect(SportsInterpretationSchema.safeParse({ kind }).success).toBe(true);
    }
    expect(SportsInterpretationSchema.safeParse({ kind: 'ambiguous_interpretation', question: 'Which opponent?' }).success).toBe(true);
    for (const value of [
      { kind: 'approve' }, { kind: 'new_request', updates: {}, actions: [] },
      { kind: 'correction', updates: { stakeCents: 1000 } },
      { kind: 'answer_to_clarification', updates: { totalStake: { value: 'R10' } } },
      { kind: 'new_request', updates: { selections: [{ index: 10, team: quote('Arsenal') }] } },
      { kind: 'ambiguous_interpretation', question: '' },
    ]) expect(SportsInterpretationSchema.safeParse(value).success).toBe(false);
  });
});

describe('sports request completeness and conversation transitions', () => {
  it('collects replies without inventing opponent, competition, market or stake', () => {
    const first = reduceSportsConversation(null, { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quote('Arsenal') }],
    } }, 'Prepare Arsenal');
    expect(first).toMatchObject({ status: 'CLARIFICATION', pendingSports: {
      selections: [{ team: 'Arsenal', opponent: null }], competition: null, market: null, stakeCents: null,
    } });
    const second = reduceSportsConversation(first.pendingSports, { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, opponent: quote('Chelsea') }],
    } }, 'Chelsea');
    expect(second).toMatchObject({ status: 'CLARIFICATION', pendingSports: {
      selections: [{ team: 'Arsenal', opponent: 'Chelsea' }], competition: null, market: null, stakeCents: null,
    } });
    const third = reduceSportsConversation(second.pendingSports, { kind: 'answer_to_clarification', updates: {
      competition: quote('Premier League'), market: quote('match winner'),
    } }, 'Premier League, match winner');
    expect(third).toMatchObject({ status: 'CLARIFICATION', pendingSports: { stakeCents: null } });
    const fourth = reduceSportsConversation(third.pendingSports, { kind: 'answer_to_clarification', updates: {
      totalStake: quote('R10.01'),
    } }, 'R10.01');
    expect(fourth).toMatchObject({ status: 'PLANNED', auth: true, plan: { actions: [{
      type: 'prepare_sports_bet', competition: 'premier-league', market: 'match-winner',
      stakeCents: 1001, selections: [{ team: 'Arsenal', opponent: 'Chelsea' }], submit: false,
    }] } });
    expect(first.pendingSports?.selections[0].opponent).toBeNull();
  });

  it.each(['to beat', 'to win'])('accepts the explicit market phrase %s without inferring an opponent or competition', (phrase) => {
    const result = reduceSportsConversation(null, { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quote('Arsenal') }], market: quote(phrase),
    } }, `Prepare Arsenal ${phrase}`);
    expect(result).toMatchObject({ status: 'CLARIFICATION', pendingSports: {
      market: 'match-winner', competition: null, stakeCents: null, selections: [{ team: 'Arsenal', opponent: null }],
    } });
  });

  it('does not infer a market from a fixture or accept invented/defaulted details', () => {
    const result = reduceSportsConversation(null, { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quote('Arsenal'), opponent: quote('Chelsea') }],
    } }, 'Prepare Arsenal vs Chelsea');
    expect(result.pendingSports?.market).toBeNull();
    for (const updates of [{ totalStake: quote('R10') }, { competition: quote('Premier League') },
      { market: quote('match-winner') }, { selections: [{ index: 0, opponent: quote('Chelsea') }] }]) {
      const hallucinated = reduceSportsConversation(result.pendingSports, { kind: 'answer_to_clarification', updates }, 'yes');
      expect(hallucinated).toMatchObject({ status: 'AMBIGUOUS', changed: false, pendingSports: result.pendingSports });
    }
  });

  it('requires correction intent to overwrite supplied values and applies changes atomically', () => {
    const original = { ...draft(), stakeCents: 1000 };
    const updates = { totalStake: quote('R20'), selections: [{ index: 0, opponent: quote('Leeds') }] };
    const conflict = reduceSportsConversation(original, { kind: 'answer_to_clarification', updates }, 'Leeds R20');
    expect(conflict).toMatchObject({ status: 'CLARIFICATION', pendingSports: original });
    expect(conflict.requirements).toContainEqual(expect.objectContaining({ field: 'stakeCents', code: 'conflicting_answer' }));
    const corrected = reduceSportsConversation(original, { kind: 'correction', updates }, 'Change opponent to Leeds and stake to R20');
    expect(corrected).toMatchObject({ status: 'PLANNED', pendingSports: {
      ...original, selections: [{ team: 'Arsenal', opponent: 'Leeds' }], stakeCents: 2000,
    } });
    expect(original.stakeCents).toBe(1000);
  });

  it('preserves drafts for unrelated and ambiguous replies, and clears them on cancellation', () => {
    for (const interpretation of [
      { kind: 'unrelated_message' }, { kind: 'ambiguous_interpretation', question: 'Which selection?' },
    ] as SportsInterpretation[]) {
      expect(reduceSportsConversation(draft(), interpretation, 'hello')).toMatchObject({ pendingSports: draft(), changed: false });
    }
    expect(reduceSportsConversation(draft(), { kind: 'cancellation' }, 'cancel'))
      .toMatchObject({ status: 'CANCELLED', pendingSports: null, actions: [] });
    expect(reduceSportsConversation(null, { kind: 'answer_to_clarification', updates: { totalStake: quote('R10') } }, 'R10').status)
      .toBe('CLARIFICATION');
  });

  it('starts replacement requests with unknowns and never inherits the previous stake', () => {
    const result = reduceSportsConversation({ ...draft(), stakeCents: 1000 }, { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quote('Bournemouth') }],
    } }, 'New request: Bournemouth');
    expect(result).toMatchObject({ status: 'CLARIFICATION', pendingSports: {
      selections: [{ team: 'Bournemouth', opponent: null }], competition: null, market: null, stakeCents: null,
    } });
  });

  it('retains every accumulator selection when clarifying or correcting one leg', () => {
    const pending = { ...draft(), selections: [{ team: 'Arsenal', opponent: 'Chelsea' }, { team: 'Liverpool', opponent: null }] };
    const result = reduceSportsConversation(pending, { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 1, opponent: quote('Everton') }], totalStake: quote('R5'),
    } }, 'Liverpool opponent is Everton. R5 total');
    expect(result).toMatchObject({ status: 'PLANNED', pendingSports: { selections: [
      { team: 'Arsenal', opponent: 'Chelsea' }, { team: 'Liverpool', opponent: 'Everton' },
    ] } });
  });

  it.each(['R1.00', 'R1.01', 'R50.00'])('keeps complete supported requests working at %s', (amount) => {
    const result = reduceSportsConversation(null, { kind: 'new_request', updates: {
      selections: [{ index: 0, team: quote('Arsenal'), opponent: quote('Chelsea') }],
      market: quote('to beat'), competition: quote('Premier League'), totalStake: quote(amount),
    } }, `Prepare ${amount} Premier League Arsenal to beat Chelsea. Do not submit.`);
    expect(result.status).toBe('PLANNED');
    if (result.status === 'PLANNED') expect(result.plan.actions[0]).toMatchObject({ submit: false });
  });

  it('retains unsupported supplied details and blocks execution instead of substituting supported values', () => {
    const pending = { ...draft(), competition: 'La Liga', stakeCents: 1000 };
    expect(reduceSportsConversation(pending, { kind: 'correction', updates: { totalStake: quote('R51') } }, 'stake R51'))
      .toMatchObject({ status: 'CLARIFICATION', pendingSports: { competition: 'La Liga', stakeCents: 1000 }, actions: [] });
  });

  it('accepts a bare amount only as a stake answer or explicit correction, and never confirms from yes', () => {
    expect(reduceSportsConversation(draft(), { kind: 'answer_to_clarification', updates: { totalStake: quote('10.01') } }, '10.01'))
      .toMatchObject({ status: 'PLANNED', pendingSports: { stakeCents: 1001 } });
    expect(reduceSportsConversation(draft(), { kind: 'answer_to_clarification', updates: {} }, 'yes').status).toBe('AMBIGUOUS');
    expect(reduceSportsConversation(draft(), { kind: 'answer_to_clarification', updates: { totalStake: quote('10') } }, 'Add 10 selections total'))
      .toMatchObject({ status: 'CLARIFICATION', pendingSports: { stakeCents: null } });
    expect(reduceSportsConversation(draft(), { kind: 'answer_to_clarification', updates: { totalStake: quote('R1.001') } }, 'R1.001'))
      .toMatchObject({ status: 'CLARIFICATION', pendingSports: { stakeCents: null } });
  });

  it.each(['R0', 'R0.99', 'R50.01'])('rejects invalid stake %s and requests a valid replacement', (amount) => {
    const result = reduceSportsConversation(draft(), { kind: 'answer_to_clarification', updates: { totalStake: quote(amount) } }, amount);
    expect(result.status).toBe('CLARIFICATION');
    expect(result.pendingSports?.stakeCents).toBeNull();
    expect(result.requirements).toContainEqual(expect.objectContaining({ field: 'stakeCents' }));
    expect(result).not.toHaveProperty('plan');
  });

  it('rejects duplicate or skipped selection targets without partially changing the draft', () => {
    const result = reduceSportsConversation(draft(), { kind: 'correction', updates: {
      selections: [{ index: 0, team: quote('Liverpool') }, { index: 0, opponent: quote('Everton') }],
    } }, 'Liverpool vs Everton');
    expect(result).toMatchObject({ status: 'AMBIGUOUS', pendingSports: draft(), changed: false });
    expect(reduceSportsConversation(draft(), { kind: 'correction', updates: {
      selections: [{ index: 3, team: quote('Liverpool') }],
    } }, 'Liverpool')).toMatchObject({ status: 'AMBIGUOUS', pendingSports: draft(), changed: false });
  });

  it('keeps slot and read-only commands on their existing planner path', () => {
    expect(usesSportsConversation('Log in, open Games in Olympus and play 10 spins at R0.20')).toBe(false);
    expect(usesSportsConversation('Inspect the homepage')).toBe(false);
    expect(usesSportsConversation('Check Live Sports')).toBe(false);
    expect(usesSportsConversation('Prepare Arsenal to win')).toBe(true);
    expect(usesSportsConversation('R10.01')).toBe(true);
    expect(usesSportsConversation('Premier League')).toBe(true);
  });
});
