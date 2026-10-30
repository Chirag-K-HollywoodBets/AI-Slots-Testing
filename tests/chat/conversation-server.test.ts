import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceSportsConversation, type PendingSportsRequest, type SportsInterpretation, type SportsConversationState } from '../../src/agent/sports-conversation';
import { interpretSportsTurn } from '../../src/agent/sports-interpreter';

const { createChatServer } = require('../../chat/server.cjs') as { createChatServer: (dependencies: {
  planMessage: (message: string, pending: PendingSportsRequest | null) => Promise<unknown>;
  prepareReview: (...args: unknown[]) => Promise<unknown>;
  runPlan: (...args: unknown[]) => Promise<unknown>;
  inspectSlots?: (instruction: string) => Promise<unknown>;
  getActiveReview?: () => unknown;
  reviewStatus?: (...args: unknown[]) => Promise<unknown>;
  submitReview?: (...args: unknown[]) => Promise<unknown>;
  reviewIsReady?: (...args: unknown[]) => boolean;
  getSubmissionEnabled?: () => boolean;
  reviewRunnerAvailable?: (...args: unknown[]) => boolean;
  verifySubmissionEvidence?: (...args: unknown[]) => boolean;
}) => Server };
const quote = (value: string) => ({ value, evidence: value });
const complete: SportsInterpretation = { kind: 'new_request', updates: {
  selections: [{ index: 0, team: quote('Arsenal'), opponent: quote('Chelsea') }],
  competition: quote('Premier League'), market: quote('to beat'), totalStake: quote('R10'),
} };
const completeMessage = 'Prepare R10 Premier League Arsenal to beat Chelsea. Do not submit.';

describe('chat conversation HTTP contract (stubbed planner and runner)', () => {
  let server: Server;
  let base: string;
  const planMessage = vi.fn();
  const prepareReview = vi.fn();
  const runPlan = vi.fn();
  const inspectSlots = vi.fn();
  const reviewStatus = vi.fn();
  const submitReview = vi.fn();
  const reviewIsReady = vi.fn(() => true);
  const reviewRunnerAvailable = vi.fn(() => true);
  const verifySubmissionEvidence = vi.fn(() => true);
  let submissionEnabled = false;
  let activeReview: any;

  beforeEach(async () => {
    vi.resetAllMocks();
    submissionEnabled = false;
    activeReview = null;
    prepareReview.mockResolvedValue({ id: 'review-1' });
    runPlan.mockResolvedValue({ code: 0, report: { status: 'PASS', success: true, actions: [] } });
    inspectSlots.mockResolvedValue({ mode: 'SLOTS_INSPECT', status: 'READ_ONLY_INSPECTION_COMPLETE', success: true, logs: '', screenshot: null });
    verifySubmissionEvidence.mockReturnValue(true);
    server = createChatServer({ planMessage, prepareReview, runPlan, inspectSlots, getActiveReview: () => activeReview,
      reviewStatus, submitReview, reviewIsReady, reviewRunnerAvailable, verifySubmissionEvidence,
      getSubmissionEnabled: () => submissionEnabled });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('NO_TEST_ADDRESS');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  async function session(): Promise<string> {
    const response = await fetch(base);
    await response.text();
    return response.headers.get('set-cookie')!.split(';')[0];
  }
  async function post(cookie: string, route: string, body: object) {
    const response = await fetch(base + route, { method: 'POST', headers: {
      cookie, origin: 'http://127.0.0.1:3001', 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) });
    return { code: response.status, result: await response.json() as Record<string, any> };
  }
  it('routes read-only slot inspection to Midscene without planning or E2E execution', async () => {
    const cookie = await session();
    const result = await post(cookie, '/api/run', { mode: 'SLOTS_INSPECT', instruction: 'Inspect the visible slot title' });
    expect(result.result.status).toBe('READ_ONLY_INSPECTION_COMPLETE');
    expect(inspectSlots).toHaveBeenCalledOnce();
    expect(planMessage).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
  });
  it('rejects spin intent in inspection mode and never invokes either runner', async () => {
    const cookie = await session();
    const result = await post(cookie, '/api/run', { mode: 'SLOTS_INSPECT', instruction: 'Initiate 3 spins' });
    expect(result.code).toBe(403);
    expect(result.result.code).toBe('ACTION_NOT_PERMITTED');
    expect(inspectSlots).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
  });
  it('rejects disabled and malformed execution modes before planning', async () => {
    const cookie = await session();
    expect((await post(cookie, '/api/run', { mode: 'SLOTS_PLAY', instruction: 'Inspect' })).result.code).toBe('MODE_DISABLED');
    expect((await post(cookie, '/api/run', { mode: 'SLOTS_INSPECT' })).code).toBe(400);
    expect((await post(cookie, '/api/run', { mode: 'BYPASS', instruction: 'Inspect' })).result.code).toBe('INVALID_MODE');
    expect(planMessage).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
  });
  function interpretOnce(interpretation: SportsInterpretation) {
    planMessage.mockImplementationOnce(async (message: string, pending: PendingSportsRequest | null, state: SportsConversationState | null, messageId: string) =>
      reduceSportsConversation(pending, interpretation, message, { state: state ?? undefined, messageId }));
  }
  async function readyReview() {
    submissionEnabled = true;
    const cookie = await session();
    const plan = reduceSportsConversation(null, complete, completeMessage);
    if (plan.status !== 'PLANNED') throw new Error('EXPECTED_TEST_PLAN');
    planMessage.mockResolvedValueOnce(plan);
    const summary = (await post(cookie, '/api/run', { instruction: completeMessage })).result;
    prepareReview.mockImplementation(async (_p, _u, sessionId) => {
      activeReview = { id: 'outcome-review', runId: 'outcome-run', sessionId, expiresAt: Date.now() + 60_000 };
      return activeReview;
    });
    await post(cookie, '/api/confirm', { planId: summary.planId });
    const betslip = { status: 'BETSLIP_READY', submitted: false, betType: 'single', market: 'match-winner',
      stakeCents: 1000, selections: [{ fixture: 'Arsenal vs Chelsea', selection: 'Arsenal', market: 'match-winner', displayedOdds: 0.65 }],
      displayedPayoutCents: 650, displayedPayoutBasis: 'sportsbook-payout', potentialPayoutCents: 650, potentialProfitCents: null,
      oddsBasis: 'sportsbook-displayed' };
    reviewStatus.mockResolvedValue({ status: 'REVIEW_READY', reviewId: 'outcome-review', expiresAt: activeReview.expiresAt,
      actions: [{ type: 'prepare_sports_bet', betslip }] });
    const review = await fetch(base + '/api/review-current', { headers: { cookie } }).then((r) => r.json());
    return { cookie, betslip, auth: { reviewId: review.reviewId, revision: review.revision, idempotencyKey: review.idempotencyKey } };
  }

  it('retains details across clarification replies, summarizes all fields, and waits for the confirmation button', async () => {
    const cookie = await session();
    interpretOnce({ kind: 'new_request', updates: {
      selections: [{ index: 0, team: quote('Arsenal') }], market: quote('to win'),
    } });
    expect((await post(cookie, '/api/run', { instruction: 'Prepare Arsenal to win' })).result.status).toBe('CLARIFICATION');
    interpretOnce({ kind: 'answer_to_clarification', updates: {
      selections: [{ index: 0, opponent: quote('Chelsea') }], competition: quote('Premier League'), totalStake: quote('R10'),
    } });
    const confirmed = await post(cookie, '/api/run', { instruction: 'Chelsea, Premier League, R10 total' });
    expect(planMessage.mock.calls[1][1]).toMatchObject({ selections: [{ team: 'Arsenal', opponent: null }], stakeCents: null });
    expect(confirmed.result.status).toBe('CONFIRM');
    for (const detail of ['Arsenal vs Chelsea', 'Premier League', 'Match winner', 'R10.00', 'preparation only', 'explicit Submit bet button']) {
      expect(confirmed.result.summary).toContain(detail);
    }
    expect(prepareReview).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
    expect((await post(cookie, '/api/confirm', { planId: confirmed.result.planId })).result.status).toBe('REVIEW_STARTING');
    expect(prepareReview).toHaveBeenCalledOnce();
    expect(prepareReview.mock.calls[0][0].actions[0].submit).toBe(false);
    expect(submitReview).not.toHaveBeenCalled();
    expect((await post(cookie, '/api/confirm', { planId: confirmed.result.planId })).code).toBe(400);
  });

  it('does not share drafts or permit another session to confirm or cancel a plan', async () => {
    const a = await session();
    const b = await session();
    interpretOnce(complete);
    const confirmed = (await post(a, '/api/run', { instruction: completeMessage })).result;
    interpretOnce({ kind: 'unrelated_message' });
    await post(b, '/api/run', { instruction: 'hello' });
    expect(planMessage.mock.calls[1][1]).toBeNull();
    expect((await post(b, '/api/confirm', { planId: confirmed.planId })).code).toBe(400);
    expect((await post(b, '/api/cancel', { planId: confirmed.planId })).code).toBe(400);
    expect((await post(a, '/api/confirm', { planId: confirmed.planId })).result.status).toBe('REVIEW_STARTING');
    expect(prepareReview).toHaveBeenCalledOnce();
  });

  it('invalidates the old summary after a correction and Cancel clears the draft and plan on the server', async () => {
    const cookie = await session();
    interpretOnce(complete);
    const old = (await post(cookie, '/api/run', { instruction: completeMessage })).result;
    interpretOnce({ kind: 'correction', updates: { totalStake: quote('R20') } });
    const revised = (await post(cookie, '/api/run', { instruction: 'Change the stake to R20' })).result;
    expect(revised.summary).toContain('R20.00');
    expect((await post(cookie, '/api/confirm', { planId: old.planId })).code).toBe(400);
    expect((await post(cookie, '/api/cancel', { planId: revised.planId })).result.status).toBe('CANCELLED');
    expect((await post(cookie, '/api/confirm', { planId: revised.planId })).code).toBe(400);
    interpretOnce({ kind: 'unrelated_message' });
    await post(cookie, '/api/run', { instruction: 'hello' });
    expect(planMessage.mock.calls[2][1]).toBeNull();
    expect(prepareReview).not.toHaveBeenCalled();
  });

  it('preserves a draft and its confirmation after unrelated or ambiguous messages and cancels from text', async () => {
    const cookie = await session();
    interpretOnce(complete);
    const ready = (await post(cookie, '/api/run', { instruction: completeMessage })).result;
    interpretOnce({ kind: 'ambiguous_interpretation', question: 'Please use Confirm and run.' });
    expect((await post(cookie, '/api/run', { instruction: 'yes' })).result.status).toBe('AMBIGUOUS');
    interpretOnce({ kind: 'unrelated_message' });
    await post(cookie, '/api/run', { instruction: 'hello' });
    expect(planMessage.mock.calls[2][1]).toMatchObject({ stakeCents: 1000 });
    interpretOnce({ kind: 'cancellation' });
    expect((await post(cookie, '/api/run', { instruction: 'cancel' })).result.status).toBe('CANCELLED');
    expect((await post(cookie, '/api/confirm', { planId: ready.planId })).code).toBe(400);
    expect(prepareReview).not.toHaveBeenCalled();
  });

  it('disables slot play without disturbing the separate sports draft', async () => {
    const cookie = await session();
    interpretOnce({ kind: 'new_request', updates: {} });
    await post(cookie, '/api/run', { instruction: 'Prepare a soccer bet' });
    const callsBeforeDisabledPlay = {
      planMessage: planMessage.mock.calls.length,
      inspectSlots: inspectSlots.mock.calls.length,
      prepareReview: prepareReview.mock.calls.length,
      runPlan: runPlan.mock.calls.length,
    };
    const slot = await post(cookie, '/api/run', { mode: 'SLOTS_PLAY', instruction: 'Log in, open Games in Olympus and play 10 spins at R0.20' });
    expect(slot.code).toBe(403);
    expect(slot.result.status).toBe('MODE_DISABLED');
    expect(planMessage).toHaveBeenCalledTimes(callsBeforeDisabledPlay.planMessage);
    expect(inspectSlots).toHaveBeenCalledTimes(callsBeforeDisabledPlay.inspectSlots);
    expect(prepareReview).toHaveBeenCalledTimes(callsBeforeDisabledPlay.prepareReview);
    expect(runPlan).toHaveBeenCalledTimes(callsBeforeDisabledPlay.runPlan);
    const plannerCallsBeforeSportsFollowUp = planMessage.mock.calls.length;
    interpretOnce({ kind: 'unrelated_message' });
    await post(cookie, '/api/run', { instruction: 'hello' });
    expect(planMessage).toHaveBeenCalledTimes(plannerCallsBeforeSportsFollowUp + 1);
    expect(planMessage.mock.calls.at(-1)?.[1]).not.toBeNull();
  });

  it('blocks an unexpected legacy sports plan that has not passed the conversation contract', async () => {
    const cookie = await session();
    const result = reduceSportsConversation(null, complete, completeMessage);
    if (result.status !== 'PLANNED') throw new Error('EXPECTED_TEST_PLAN');
    const { pendingSports: _pending, changed: _changed, ...legacyResult } = result;
    planMessage.mockResolvedValueOnce(legacyResult);
    expect((await post(cookie, '/api/run', { instruction: completeMessage })).result.status).toBe('BLOCKED');
    expect(prepareReview).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('does not generate another confirmation or start a runner when a message is repeated', async () => {
    const cookie = await session();
    interpretOnce(complete);
    const first = (await post(cookie, '/api/run', { instruction: completeMessage, messageId: 'original-message' })).result;
    expect(first.status).toBe('CONFIRM');
    for (const messageId of ['original-message', 'another-http-request']) {
      interpretOnce(complete);
      const repeated = (await post(cookie, '/api/run', { instruction: completeMessage, messageId })).result;
      expect(repeated.status).toBe('UNCHANGED');
      expect(repeated).not.toHaveProperty('planId');
      expect(repeated.actions).toEqual([]);
    }
    expect(prepareReview).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
    expect((await post(cookie, '/api/confirm', { planId: first.planId })).result.status).toBe('REVIEW_STARTING');
    expect(prepareReview).toHaveBeenCalledOnce();
  });

  it('asks before replacing a saved request and rejects the old confirmation during that clarification', async () => {
    const cookie = await session();
    interpretOnce(complete);
    const first = (await post(cookie, '/api/run', { instruction: completeMessage })).result;
    interpretOnce({ kind: 'new_request', updates: { selections: [{ index: 0, team: quote('Liverpool') }], market: quote('to win') } });
    const possible = (await post(cookie, '/api/run', { instruction: 'Prepare Liverpool to win' })).result;
    expect(possible.status).toBe('CLARIFICATION');
    expect(possible.requirements).toContainEqual(expect.objectContaining({ field: 'request', code: 'ambiguous_replacement' }));
    expect((await post(cookie, '/api/confirm', { planId: first.planId })).code).toBe(400);
    interpretOnce({ kind: 'unrelated_message' });
    await post(cookie, '/api/run', { instruction: 'hello' });
    expect(planMessage.mock.calls[2][1]).toMatchObject({ selections: [{ team: 'Arsenal', opponent: 'Chelsea' }], stakeCents: 1000 });
    expect(prepareReview).not.toHaveBeenCalled();
  });

  it('connects mocked interpretation through clarification, a complete summary and confirmation without preparing early', async () => {
    const cookie = await session();
    const usage = { source: 'reported', model: 'mock-local-model', inputTokens: 30, outputTokens: 12, totalTokens: 42 };
    const model = { interpretSportsMessage: vi.fn()
      .mockResolvedValueOnce({ interpretation: { kind: 'new_request', updates: { selections: [{ index: 0, team: quote('Man City') }], market: quote('to win') } }, usage })
      .mockResolvedValueOnce({ interpretation: { kind: 'answer_to_clarification', updates: { selections: [{ index: 0, opponent: quote('Brighton') }], competition: quote('Premier League') } }, usage })
      .mockResolvedValueOnce({ interpretation: { kind: 'answer_to_clarification', updates: { totalStake: quote('R10') } }, usage }) };
    planMessage.mockImplementation((message, pending, state, messageId) => interpretSportsTurn(model, message, pending, { state: state ?? undefined, messageId }));
    const first = await post(cookie, '/api/run', { instruction: 'Prepare Man City to win' });
    expect(first.result).toMatchObject({ status: 'CLARIFICATION', reason: expect.stringContaining('Who is Man City playing?'), usage,
      conversation: { phase: 'clarification', confirmations: [] } });
    const second = await post(cookie, '/api/run', { instruction: 'Brighton, Premier League' });
    expect(second.result).toMatchObject({ status: 'CLARIFICATION', reason: 'What total stake would you like to use?' });
    const third = await post(cookie, '/api/run', { instruction: 'R10' });
    expect(third.result).toMatchObject({ status: 'CONFIRM', revision: 3, usage, conversation: { phase: 'awaiting_confirmation', revision: 3 } });
    for (const text of ['Team: Man City', 'Opponent: Brighton', 'Competition: Premier League', 'Market: Match winner', 'Bet type: Single', 'Total stake: R10.00', 'cannot submit from messages']) {
      expect(third.result.summary).toContain(text);
    }
    expect(prepareReview).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
    const restored = await fetch(base + '/api/conversation-state', { headers: { cookie } }).then((r) => r.json());
    expect(restored.messages.filter((item: any) => item.role === 'user').map((item: any) => item.text)).toEqual([
      'Prepare Man City to win', 'Brighton, Premier League', 'R10',
    ]);
    expect(restored.messages.filter((item: any) => item.result).map((item: any) => item.result.usage)).toEqual([usage, usage, usage]);
    expect(restored.conversation.confirmations[0]).toMatchObject({ planId: third.result.planId, revision: 3, kind: 'sports' });
  });

  it('keeps transcript and confirmation controls within their originating session', async () => {
    const a = await session();
    const b = await session();
    interpretOnce(complete);
    const summary = (await post(a, '/api/run', { instruction: completeMessage })).result;
    const snapshot = (cookie: string) => fetch(base + '/api/conversation-state', { headers: { cookie } }).then((r) => r.json());
    expect((await snapshot(a)).messages).toHaveLength(2);
    expect(await snapshot(b)).toMatchObject({ messages: [], conversation: { phase: 'idle', revision: null, confirmations: [] } });
    expect((await post(b, '/api/confirm', { planId: summary.planId })).code).toBe(400);
    expect(prepareReview).not.toHaveBeenCalled();
  });

  it('retires the old confirmation in the public view when a correction generates a fresh summary', async () => {
    const cookie = await session();
    interpretOnce(complete);
    const first = (await post(cookie, '/api/run', { instruction: completeMessage })).result;
    interpretOnce({ kind: 'correction', updates: { totalStake: quote('R20') } });
    const next = (await post(cookie, '/api/run', { instruction: 'Actually make it R20' })).result;
    expect(next.revision).toBe(first.revision + 1);
    expect(next.conversation.confirmationInvalidated).toBe(true);
    expect(next.conversation.confirmations.map((item: any) => item.planId)).toEqual([next.planId]);
    expect((await post(cookie, '/api/confirm', { planId: first.planId })).code).toBe(400);
    expect(prepareReview).not.toHaveBeenCalled();
  });

  it('rejects expired confirmation attempts without preparing a slip', async () => {
    const cookie = await session();
    interpretOnce(complete);
    const ready = (await post(cookie, '/api/run', { instruction: completeMessage })).result;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(ready.expiresAt);
    try {
      expect((await post(cookie, '/api/confirm', { planId: ready.planId })).code).toBe(400);
      expect(prepareReview).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('exposes running and manual-review states while blocking new work and keeping review access session-bound', async () => {
    const a = await session();
    const b = await session();
    const usage = { source: 'reported', model: 'mock', totalTokens: 12 };
    planMessage.mockResolvedValueOnce({ ...reduceSportsConversation(null, complete, completeMessage), usage });
    const ready = (await post(a, '/api/run', { instruction: completeMessage })).result;
    prepareReview.mockImplementation(async (_plan, actualUsage, sessionId) => {
      activeReview = { id: 'owned-review', sessionId, usage: actualUsage };
      return activeReview;
    });
    const confirmed = (await post(a, '/api/confirm', { planId: ready.planId })).result;
    expect(confirmed).toMatchObject({ status: 'REVIEW_STARTING', reviewId: 'owned-review', usage, conversation: { phase: 'running' } });
    reviewStatus.mockResolvedValue({ status: 'REVIEW_READY', reviewId: 'owned-review', expiresAt: Date.now() + 10_000, actions: [] });
    const review = await fetch(base + '/api/review-current', { headers: { cookie: a } }).then((r) => r.json());
    expect(review).toMatchObject({ status: 'REVIEW_READY', usage });
    expect((await fetch(base + '/api/review-current', { headers: { cookie: b } })).status).toBe(404);
    expect((await post(a, '/api/run', { instruction: 'Prepare another request' })).code).toBe(409);
    expect((await post(b, '/api/run', { instruction: 'R10' })).code).toBe(409);
    expect(prepareReview).toHaveBeenCalledOnce();
    activeReview.terminal = { status: 'REVIEW_CLOSED' };
    expect((await post(a, '/api/confirm', { planId: ready.planId })).code).toBe(400);
  });

  it('passes the revision into review creation before the runner starts, even when it returns a copy', async () => {
    submissionEnabled = true;
    const cookie = await session();
    const plan = reduceSportsConversation(null, complete, completeMessage);
    if (plan.status !== 'PLANNED') throw new Error('EXPECTED_TEST_PLAN');
    planMessage.mockResolvedValueOnce(plan);
    const summary = (await post(cookie, '/api/run', { instruction: completeMessage })).result;
    prepareReview.mockImplementation(async (_plan, _usage, sessionId, revision) => {
      activeReview = { id: 'copied-review', runId: 'copied-run', sessionId, revision, expiresAt: Date.now() + 60_000 };
      return { ...activeReview };
    });
    await post(cookie, '/api/confirm', { planId: summary.planId });
    expect(prepareReview.mock.calls[0][3]).toBe(summary.revision);
    expect(activeReview.revision).toBe(summary.revision);
    const betslip = { status: 'BETSLIP_READY', submitted: false, betType: 'single', market: 'match-winner',
      stakeCents: 1000, selections: [{ fixture: 'Arsenal vs Chelsea', selection: 'Arsenal', market: 'match-winner', displayedOdds: 0.65 }],
      displayedPayoutCents: 650, displayedPayoutBasis: 'sportsbook-payout', potentialPayoutCents: 650, potentialProfitCents: null };
    reviewStatus.mockResolvedValue({ status: 'REVIEW_READY', expiresAt: activeReview.expiresAt,
      actions: [{ type: 'prepare_sports_bet', betslip }] });
    const review = await fetch(base + '/api/review-current', { headers: { cookie } }).then((r) => r.json());
    submitReview.mockResolvedValue({ outcome: 'blocked', reason: 'Mock boundary: no browser interaction.' });
    const response = await post(cookie, '/api/submit-review', {
      reviewId: review.reviewId, revision: review.revision, idempotencyKey: review.idempotencyKey,
    });
    expect(response.result.status).toBe('SUBMISSION_BLOCKED');
    expect(submitReview).toHaveBeenCalledTimes(1);
    expect(submitReview.mock.calls[0][0].revision).toBe(summary.revision);
  });

  it('binds explicit submission to one review, revision, session and stored slip, and consumes it once', async () => {
    submissionEnabled = true;
    const a = await session();
    const b = await session();
    const plan = reduceSportsConversation(null, complete, completeMessage);
    if (plan.status !== 'PLANNED') throw new Error('EXPECTED_TEST_PLAN');
    planMessage.mockResolvedValueOnce(plan);
    const ready = (await post(a, '/api/run', { instruction: completeMessage })).result;
    prepareReview.mockImplementation(async (_p, _u, sessionId) => {
      activeReview = { id: 'submit-review', runId: 'run-1', sessionId, expiresAt: Date.now() + 60_000 };
      return activeReview;
    });
    await post(a, '/api/confirm', { planId: ready.planId });
    const betslip = { status: 'BETSLIP_READY', submitted: false, betType: 'single', market: 'match-winner',
      stakeCents: 1000, selections: [{ fixture: 'Arsenal vs Chelsea', selection: 'Arsenal', market: 'match-winner', displayedOdds: 0.65 }],
      displayedPayoutCents: 650, displayedPayoutBasis: 'sportsbook-payout', potentialPayoutCents: 650, potentialProfitCents: null };
    reviewStatus.mockResolvedValue({ status: 'REVIEW_READY', reviewId: 'submit-review', expiresAt: activeReview.expiresAt,
      actions: [{ type: 'prepare_sports_bet', betslip }] });
    const review = await fetch(base + '/api/review-current', { headers: { cookie: a } }).then((r) => r.json());
    expect(review.idempotencyKey).toBeTruthy();
    let auth = { reviewId: 'submit-review', revision: review.revision, idempotencyKey: review.idempotencyKey };
    const unreadable = structuredClone(betslip);
    unreadable.selections[0].displayedOdds = Number.NaN;
    reviewStatus.mockResolvedValueOnce({ status: 'REVIEW_READY', reviewId: 'submit-review', expiresAt: activeReview.expiresAt,
      actions: [{ type: 'prepare_sports_bet', betslip: unreadable }] });
    expect((await post(a, '/api/submit-review', auth)).result.status).toBe('REVIEW_UNVERIFIED');
    expect(submitReview).not.toHaveBeenCalled();
    expect((await post(b, '/api/submit-review', auth)).code).toBe(404);
    expect((await post(a, '/api/submit-review', { ...auth, revision: review.revision + 1 })).code).toBe(409);
    const changedSlip = structuredClone(betslip);
    changedSlip.selections[0].displayedOdds = 0.7;
    changedSlip.displayedPayoutCents = 700;
    reviewStatus.mockResolvedValue({ status: 'REVIEW_READY', reviewId: 'submit-review', expiresAt: activeReview.expiresAt,
      actions: [{ type: 'prepare_sports_bet', betslip: changedSlip }] });
    const refreshed = await post(a, '/api/submit-review', { ...auth, selections: [{ team: 'CLIENT DATA' }], stakeCents: 1 });
    expect(refreshed.result).toMatchObject({ status: 'REVIEW_READY', refreshed: true });
    auth = { reviewId: 'submit-review', revision: refreshed.result.revision, idempotencyKey: refreshed.result.idempotencyKey };
    submitReview.mockImplementation(async (input: any) => {
      expect(input.betslip).toEqual(changedSlip);
      return { outcome: 'accepted', betReference: 'MOCK-123' };
    });
    const accepted = await post(a, '/api/submit-review', auth);
    expect(accepted.result).toMatchObject({ status: 'BET_ACCEPTED', betReference: 'MOCK-123', stakeCents: 1000,
      selections: [{ fixture: 'Arsenal vs Chelsea', selection: 'Arsenal' }] });
    expect((await post(a, '/api/submit-review', auth)).code).toBe(409);
    expect(submitReview).toHaveBeenCalledOnce();
    expect((await post(a, '/api/run', { instruction: 'submit now' })).code).toBe(409);
  });

  it('reports explicit rejection without retrying', async () => {
    const rejected = await readyReview();
    submitReview.mockResolvedValueOnce({ outcome: 'rejected', reason: 'Mock sportsbook rejection' });
    expect((await post(rejected.cookie, '/api/submit-review', rejected.auth)).result)
      .toMatchObject({ status: 'BET_REJECTED', reason: 'Mock sportsbook rejection' });
    expect((await post(rejected.cookie, '/api/submit-review', rejected.auth)).code).toBe(409);
    expect(submitReview).toHaveBeenCalledOnce();

  });

  it('downgrades acceptance without a valid reference to unknown', async () => {
    const ready = await readyReview();
    submitReview.mockResolvedValueOnce({ outcome: 'accepted', betReference: '' });
    expect((await post(ready.cookie, '/api/submit-review', ready.auth)).result.status).toBe('BET_OUTCOME_UNKNOWN');
    expect((await post(ready.cookie, '/api/submit-review', ready.auth)).code).toBe(409);
  });

  it('keeps acceptance unknown when no verified provider evidence adapter is enabled', async () => {
    const ready = await readyReview();
    verifySubmissionEvidence.mockReturnValueOnce(false);
    submitReview.mockResolvedValueOnce({ outcome: 'accepted', betReference: 'MOCK-REF' });
    expect((await post(ready.cookie, '/api/submit-review', ready.auth)).result.status).toBe('BET_OUTCOME_UNKNOWN');
  });

  it('maps a disconnect after a possible attempt to unknown and never retries', async () => {
    const unknown = await readyReview();
    submitReview.mockRejectedValueOnce(new Error('simulated disconnect after possible click'));
    expect((await post(unknown.cookie, '/api/submit-review', unknown.auth)).result.status).toBe('BET_OUTCOME_UNKNOWN');
    expect((await post(unknown.cookie, '/api/submit-review', unknown.auth)).code).toBe(409);
    expect(submitReview).toHaveBeenCalledOnce();
  });

  it('reconciles a late result for the same authorization and replaces the saved unknown outcome', async () => {
    const ready = await readyReview();
    const directory = await mkdtemp(join(tmpdir(), 'hb-late-submission-'));
    activeReview.submissionResultPath = join(directory, 'result.json');
    submitReview.mockResolvedValueOnce({ outcome: 'unknown', reason: 'temporarily unobserved' });
    expect((await post(ready.cookie, '/api/submit-review', ready.auth)).result.status).toBe('BET_OUTCOME_UNKNOWN');
    const claim = submitReview.mock.calls[0][0];
    await writeFile(activeReview.submissionResultPath, JSON.stringify({ id: activeReview.id, runId: activeReview.runId,
      authorization: claim.authorization, outcome: 'accepted', betReference: 'LATE-123' }));
    const reconciled = await fetch(base + '/api/review-current', { headers: { cookie: ready.cookie } }).then((r) => r.json());
    expect(reconciled).toMatchObject({ status: 'BET_ACCEPTED', betReference: 'LATE-123', stakeCents: 1000 });
    const history = await fetch(base + '/api/conversation-state', { headers: { cookie: ready.cookie } }).then((r) => r.json());
    expect(history.messages.some((message: any) => message.result?.status === 'BET_ACCEPTED'
      && message.result?.betReference === 'LATE-123')).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });

  it('serializes concurrent explicit submissions and leaves the second request unable to start work', async () => {
    const ready = await readyReview();
    let release!: (value: unknown) => void;
    submitReview.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = post(ready.cookie, '/api/submit-review', ready.auth);
    await vi.waitFor(() => expect(submitReview).toHaveBeenCalledOnce());
    expect((await post(ready.cookie, '/api/submit-review', ready.auth)).code).toBe(409);
    release({ outcome: 'accepted', betReference: 'MOCK-REF' });
    expect((await first).result).toMatchObject({ status: 'BET_ACCEPTED', betReference: 'MOCK-REF' });
    expect(submitReview).toHaveBeenCalledOnce();
  });

  it('blocks when the submission runner is unavailable and rejects an expired review before callback', async () => {
    const ready = await readyReview();
    reviewRunnerAvailable.mockReturnValue(false);
    const unavailable = await fetch(base + '/api/review-current', { headers: { cookie: ready.cookie } }).then((r) => r.json());
    expect(unavailable.submissionEnabled).toBe(false);
    expect((await post(ready.cookie, '/api/submit-review', ready.auth)).result.status).toBe('SUBMISSION_BLOCKED');
    expect(submitReview).not.toHaveBeenCalled();

    reviewRunnerAvailable.mockReturnValue(true);
    const expiry = vi.spyOn(Date, 'now').mockReturnValue(activeReview.expiresAt);
    reviewStatus.mockResolvedValue({ status: 'REVIEW_READY', expiresAt: activeReview.expiresAt,
      actions: [{ type: 'prepare_sports_bet', betslip: ready.betslip }] });
    try {
      expect((await post(ready.cookie, '/api/submit-review', ready.auth)).code).toBe(410);
      expect(submitReview).not.toHaveBeenCalled();
    } finally { expiry.mockRestore(); }
  });

  it('accepts at most one simultaneous confirmation request and respects the running lock', async () => {
    const cookie = await session();
    interpretOnce(complete);
    const ready = (await post(cookie, '/api/run', { instruction: completeMessage })).result;
    let release!: (value: unknown) => void;
    prepareReview.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const first = post(cookie, '/api/confirm', { planId: ready.planId });
    await vi.waitFor(() => expect(prepareReview).toHaveBeenCalledOnce());
    expect((await post(cookie, '/api/confirm', { planId: ready.planId })).code).toBe(409);
    expect((await post(cookie, '/api/run', { instruction: 'R20' })).code).toBe(409);
    release({ id: 'review-1' });
    expect((await first).result.status).toBe('REVIEW_STARTING');
    expect(prepareReview).toHaveBeenCalledOnce();
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('blocks a preparation plan that differs from its supposedly complete request', async () => {
    const cookie = await session();
    const result = reduceSportsConversation(null, complete, completeMessage);
    if (result.status !== 'PLANNED') throw new Error('EXPECTED_PLAN');
    const modified = structuredClone(result);
    (modified.plan.actions[0] as any).stakeCents = 2000;
    planMessage.mockResolvedValueOnce(modified);
    expect((await post(cookie, '/api/run', { instruction: completeMessage })).result.status).toBe('BLOCKED');
    expect(prepareReview).not.toHaveBeenCalled();
    expect(runPlan).not.toHaveBeenCalled();
  });

  it('rechecks the busy lock after an overlapping request finishes reading its body', async () => {
    const cookie = await session();
    const arrived = new Promise<void>((resolve) => server.once('request', () => resolve()));
    let finishBody!: () => void;
    const slow = new Promise<number>((resolve, reject) => {
      const request = httpRequest(base + '/api/run', { method: 'POST', headers: {
        cookie, origin: 'http://127.0.0.1:3001', 'Content-Type': 'application/json',
      } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      request.on('error', reject);
      request.write('{"instruction":');
      finishBody = () => request.end('"R20"}');
    });
    await arrived;
    let release!: (value: unknown) => void;
    planMessage.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const running = post(cookie, '/api/run', { instruction: completeMessage });
    await vi.waitFor(() => expect(planMessage).toHaveBeenCalledOnce());
    finishBody();
    try {
      expect(await slow).toBe(409);
      expect(planMessage).toHaveBeenCalledOnce();
      expect(prepareReview).not.toHaveBeenCalled();
    } finally {
      release(reduceSportsConversation(null, complete, completeMessage));
      await running;
    }
  });

  it('serves the client script under the same-origin policy and preserves literal message text in history', async () => {
    const response = await fetch(base);
    const page = await response.text();
    expect(page).toContain('<script src="/client.js" defer></script>');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    const client = await fetch(base + '/client.js');
    expect(client.headers.get('content-type')).toContain('text/javascript');
    const script = await client.text();
    expect(script).toContain('textContent');
    expect(script).not.toContain('innerHTML');
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    interpretOnce({ kind: 'unrelated_message' });
    const text = '<img src=x onerror=alert(1)>';
    await post(cookie, '/api/run', { instruction: text });
    const restored = await fetch(base + '/api/conversation-state', { headers: { cookie } }).then((r) => r.json());
    expect(restored.messages[0].text).toBe(text);
  });
});
