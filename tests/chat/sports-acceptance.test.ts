import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('ai', () => ({ generateText: generate }));
import { Planner } from '../../src/agent/planner';
import { interpretSportsTurn } from '../../src/agent/sports-interpreter';
import type { SportsInterpretation, SportsConversationState, PendingSportsRequest } from '../../src/agent/sports-conversation';
import type { FixtureSnapshot } from '../../src/agent/sports-team-clarification';

const { createChatServer } = require('../../chat/server.cjs');
const q = (value: string) => ({ value, evidence: value });
const A = 'Prepare Man City to beat Brighton in the Premier League.';
const C = 'Prepare Man Ctiy to beat Brighton in the Premier League.';
const usage = { inputTokens: 30, outputTokens: 12, totalTokens: 42 };
const prepareInterpretation = (team = 'Man City', includeCompetition = true): SportsInterpretation => ({ kind: 'new_request', updates: {
  selections: [{ index: 0, team: q(team), opponent: q('Brighton') }], market: q('to beat'),
  ...(includeCompetition ? { competition: q('Premier League') } : {}),
} });

describe('sports conversations A–E through real planner validation and HTTP (model/browser mocked)', () => {
  let server: Server;
  let base: string;
  let cookie: string;
  let fixtureSnapshot: FixtureSnapshot | null;
  let previousPlannerMetricsLog: string | undefined;
  const plannerMetricsDirectories: string[] = [];
  const prepareReview = vi.fn();
  const runPlan = vi.fn();
  beforeEach(async () => {
    previousPlannerMetricsLog = process.env.PLANNER_METRICS_LOG;
    generate.mockReset(); prepareReview.mockReset(); runPlan.mockReset();
    prepareReview.mockResolvedValue({ id: 'mock-review' });
    fixtureSnapshot = null;
    const plannerMetricsDirectory = await mkdtemp(join(tmpdir(), 'hwb-sports-planner-metrics-test-'));
    plannerMetricsDirectories.push(plannerMetricsDirectory);
    process.env.PLANNER_METRICS_LOG = join(plannerMetricsDirectory, 'planner-calls.jsonl');
    const planner = new Planner({ baseUrl: 'http://unused.invalid/v1', modelName: 'mock-local-model', customModel: {}, interpretationTimeoutMs: 100 });
    server = createChatServer({
      planMessage: (message: string, pending: PendingSportsRequest | null, state: SportsConversationState | null, messageId: string) =>
        interpretSportsTurn(planner, message, pending, { state: state ?? undefined, messageId, fixtureSnapshot }),
      prepareReview, runPlan, getActiveReview: () => null,
      plannerMetricsSource: 'test',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('NO_TEST_ADDRESS');
    base = `http://127.0.0.1:${address.port}`;
    cookie = await session();
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await Promise.all(plannerMetricsDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    if (previousPlannerMetricsLog === undefined) delete process.env.PLANNER_METRICS_LOG;
    else process.env.PLANNER_METRICS_LOG = previousPlannerMetricsLog;
  });
  async function session() {
    const response = await fetch(base);
    await response.text();
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  async function post(route: string, body: object, owner = cookie) {
    const response = await fetch(base + route, { method: 'POST', headers: {
      cookie: owner, origin: 'http://127.0.0.1:3001', 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    return { ...await response.json(), httpStatus: response.status };
  }
  async function say(message: string, interpretation?: SportsInterpretation, messageId?: string, owner = cookie) {
    if (interpretation) generate.mockResolvedValueOnce({ text: JSON.stringify(interpretation), usage });
    return post('/api/run', { instruction: message, ...(messageId ? { messageId } : {}) }, owner);
  }
  const stake = (value: string): SportsInterpretation => ({ kind: 'answer_to_clarification', updates: { totalStake: q(value) } });
  function noPreparation() {
    expect(prepareReview).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
  }
  async function summaryA() {
    await say(A, prepareInterpretation());
    return say('R10.', stake('R10'));
  }
  const fixtures = (): FixtureSnapshot => ({ source: 'mock-verified-feed', observedAt: Date.now(), fixtures: [
    { id: 'verified-city-brighton', home: 'Manchester City', away: 'Brighton', competition: 'premier-league', kickoff: '2026-10-31T17:00:00Z' },
  ] });

  it('A: asks only for stake, then shows the corrected complete summary and confirmation controls', async () => {
    const first = await say(A, prepareInterpretation());
    expect(first.status).toBe('CLARIFICATION');
    expect(first.requirements.map((item: any) => item.field)).toEqual(['stakeCents']);
    expect(first.reason).toBe('What total stake would you like to use?');
    expect(first).not.toHaveProperty('planId');
    noPreparation();
    const next = await say('R10.', stake('R10'));
    expect(next.status).toBe('CONFIRM');
    for (const detail of ['Team: Man City', 'Opponent: Brighton', 'Competition: Premier League', 'Market: Match winner', 'Bet type: Single', 'Total stake: R10.00', 'cannot submit from messages']) {
      expect(next.summary).toContain(detail);
    }
    expect(next.actions[0]).toMatchObject({ submit: false, stakeCents: 1000 });
    expect(next.usage).toMatchObject({ source: 'reported', ...usage });
    noPreparation();
  });

  it.each([false, true])('B: asks for unresolved details only, with verified fixture context available=%s', async (verified) => {
    if (verified) fixtureSnapshot = fixtures();
    const first = await say('Place a R10 bet on Man City to win.', { kind: 'new_request', updates: {
      selections: [{ index: 0, team: q('Man City') }], market: q('to win'), totalStake: q('R10'),
    } });
    expect(first.status).toBe('CLARIFICATION');
    expect(first.requirements.map((item: any) => item.field)).toEqual(verified ? ['selections.0.opponent'] : ['selections.0.opponent', 'competition']);
    expect(first.reason).toContain('Who is Man City playing?');
    const next = await say('Brighton.', { kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, opponent: q('Brighton') }],
    } });
    if (verified) {
      expect(next.status).toBe('CONFIRM');
      expect(next.summary).toContain('Total stake: R10.00');
    } else {
      expect(next.status).toBe('CLARIFICATION');
      expect(next.requirements.map((item: any) => item.field)).toEqual(['competition']);
      const ready = await say('Premier League.', { kind: 'answer_to_clarification', updates: { competition: q('Premier League') } });
      expect(ready.status).toBe('CONFIRM');
    }
    noPreparation();
  });

  it('C: a combined “Yes, R10.” accepts the one pending typo and supplies the stake without quoting a new team', async () => {
    const first = await say(C, prepareInterpretation('Man Ctiy'));
    expect(first.status).toBe('CLARIFICATION');
    expect(first.requirements.map((item: any) => item.code)).toEqual(expect.arrayContaining(['team_suggestion', 'missing']));
    expect(first.reason).toContain('Did you mean Man City');
    expect(first.reason).toContain('What total stake');
    expect(first).not.toHaveProperty('planId');
    const ready = await say('Yes, R10.', stake('R10'));
    expect(ready.status).toBe('CONFIRM');
    expect(ready.summary).toContain('Team: Man City');
    expect(ready.summary).not.toContain('Man Ctiy');
    expect(ready.actions[0].stakeCents).toBe(1000);
    noPreparation();
  });

  it('D: exact correction wording invalidates the old revision and requires a fresh confirmation', async () => {
    const first = await summaryA();
    const next = await say('Actually, make it R20.', { kind: 'correction', updates: { totalStake: q('R20') } });
    expect(next.status).toBe('CONFIRM');
    expect(next.revision).toBe(first.revision + 1);
    expect(next.summary).toContain('Total stake: R20.00');
    expect(next.conversation.confirmations.map((item: any) => item.planId)).toEqual([next.planId]);
    expect((await post('/api/confirm', { planId: first.planId })).httpStatus).toBe(400);
    noPreparation();
  });

  it('E: “Cancel.” clears the draft and old authorization even when the model is unavailable', async () => {
    const ready = await summaryA();
    generate.mockRejectedValue(new Error('model unavailable'));
    const before = generate.mock.calls.length;
    const cancelled = await say('Cancel.');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', conversation: { phase: 'idle', confirmations: [] } });
    expect(generate).toHaveBeenCalledTimes(before);
    expect((await post('/api/confirm', { planId: ready.planId })).httpStatus).toBe(400);
    expect((await say('R10.')).status).toBe('CLARIFICATION');
    expect(generate).toHaveBeenCalledTimes(before);
    noPreparation();
  });

  it.each(['R0', 'R0.99', 'R50.01', 'R1.001', '-R5'])('retains other details after invalid stake %s and accepts its correction', async (amount) => {
    await say(A, prepareInterpretation());
    const invalid = await say(amount, stake(amount));
    expect(invalid.status).toBe('CLARIFICATION');
    expect(invalid.requirements).toHaveLength(1);
    expect(invalid.requirements[0].field).toBe('stakeCents');
    expect(invalid).not.toHaveProperty('planId');
    const ready = await say('R10.', stake('R10'));
    expect(ready.status).toBe('CONFIRM');
    expect(ready.summary).toContain('Man City vs Brighton');
    noPreparation();
  });

  it('never resolves an ambiguous fixture merely because the stake arrives', async () => {
    fixtureSnapshot = fixtures();
    fixtureSnapshot.fixtures.push({ ...fixtureSnapshot.fixtures[0], id: 'later-city-brighton', kickoff: '2026-11-07T17:00:00Z' });
    await say(A, prepareInterpretation());
    const next = await say('R10.', stake('R10'));
    expect(next.status).toBe('CLARIFICATION');
    expect(next.requirements.map((item: any) => item.code)).toEqual(['fixture_ambiguous']);
    expect(next).not.toHaveProperty('planId');
    noPreparation();
  });

  it('keeps an unrelated reply from changing or completing the pending request', async () => {
    const first = await say(A, prepareInterpretation());
    const unrelated = await say('How is the weather?', { kind: 'unrelated_message' });
    expect(unrelated.status).toBe('UNRELATED');
    expect(unrelated.conversation.revision).toBe(first.conversation.revision);
    const ready = await say('R10.', stake('R10'));
    expect(ready.status).toBe('CONFIRM');
    noPreparation();
  });

  it.each(['malformed', 'unavailable'])('preserves the draft through %s model output and permits a safe retry', async (failure) => {
    const first = await say(A, prepareInterpretation());
    if (failure === 'malformed') generate.mockResolvedValueOnce({ text: 'not JSON' });
    else generate.mockRejectedValueOnce(new Error('connection refused'));
    const failed = await say('R10.');
    expect(failed.status).toBe('CLARIFICATION');
    expect(failed.reason).toContain('Saved details are unchanged');
    expect(failed.conversation.revision).toBe(first.conversation.revision);
    expect(failed).not.toHaveProperty('planId');
    expect((await say('R10.', stake('R10'))).status).toBe('CONFIRM');
    noPreparation();
  });

  it('does not duplicate confirmations or execute repeated messages', async () => {
    await say(A, prepareInterpretation(), 'request-a');
    const ready = await say('R10.', stake('R10'), 'stake-a');
    const repeated = await say('R10.', stake('R10'), 'stake-a');
    expect(repeated.status).toBe('UNCHANGED');
    expect(repeated).not.toHaveProperty('planId');
    expect(repeated.conversation.confirmations.map((item: any) => item.planId)).toEqual([ready.planId]);
    noPreparation();
    expect((await post('/api/confirm', { planId: ready.planId })).status).toBe('REVIEW_STARTING');
    expect((await post('/api/confirm', { planId: ready.planId })).httpStatus).toBe(400);
    expect(prepareReview).toHaveBeenCalledTimes(1);
    expect(prepareReview.mock.calls[0][0].actions[0].submit).toBe(false);
  });

  it('does not share a missing-stake conversation with a second session', async () => {
    await say(A, prepareInterpretation());
    const other = await session();
    const before = generate.mock.calls.length;
    const standalone = await say('R10.', undefined, undefined, other);
    expect(standalone.status).toBe('CLARIFICATION');
    expect(standalone.conversation.confirmations).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(before);
    const ready = await say('R10.', stake('R10'));
    expect((await post('/api/confirm', { planId: ready.planId }, other)).httpStatus).toBe(400);
    noPreparation();
  });
});
