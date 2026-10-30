import { describe, expect, it } from 'vitest';
import { createChatSessions, clearSportsConfirmations, takeConfirmation, cancelConfirmation,
  sportsRequestFingerprint, rememberMessage } from '../../chat/session-state.cjs';
import { emptySportsRequest, createSportsConversationState, transitionSportsConversation } from '../../src/agent/sports-conversation';
import { PlanSchema } from '../../src/agent/schema';

const sports = PlanSchema.parse({ thought: 'Prepare', actions: [{ type: 'prepare_sports_bet',
  competition: 'premier-league', market: 'match-winner', stakeCents: 1000, submit: false,
  selections: [{ team: 'Arsenal', opponent: 'Chelsea' }] }] });
const slot = PlanSchema.parse({ thought: 'Open slot', actions: [{ type: 'open_game', game: 'games-in-olympus' }] });

describe('chat session ownership', () => {
  it('isolates drafts and confirmations and restores only the cookie-owning browser session', () => {
    const store = createChatSessions();
    const a = store.resolve('', 100);
    const b = store.resolve('', 100);
    a.session.pendingSports = emptySportsRequest();
    a.session.confirmations.set('plan-a', { plan: sports, expires: 1000 });
    expect(b.session.pendingSports).toBeNull();
    expect(takeConfirmation(b.session, 'plan-a', 101)).toBeNull();
    expect(a.session.confirmations.has('plan-a')).toBe(true);
    expect(store.resolve(a.cookie, 102).session.pendingSports).toEqual(emptySportsRequest());
    expect(a.cookie).toContain('HttpOnly; SameSite=Strict');
    expect(store.resolve('hb_chat_session=caller-chosen', 102).session.id).not.toBe('caller-chosen');
    expect(store.resolve(a.cookie, 102).created).toBe(false);
  });

  it('expires idle sessions and old plans without leaking them into a new session', () => {
    const store = createChatSessions({ ttlMs: 100 });
    const a = store.resolve('', 100);
    a.session.pendingSports = emptySportsRequest();
    a.session.confirmations.set('expired', { plan: sports, expires: 120 });
    expect(store.resolve(a.cookie, 130).session.confirmations.size).toBe(0);
    const expired = store.resolve(a.cookie, 230);
    expect(expired.created).toBe(true);
    expect(expired.session.pendingSports).toBeNull();
    expect(expired.session.id).not.toBe(a.session.id);
  });

  it('consumes confirmation once and rejects expiry at the deadline', () => {
    const session = createChatSessions().resolve().session;
    session.confirmations.set('one', { plan: sports, expires: 100 });
    expect(takeConfirmation(session, 'one', 99)?.plan).toEqual(sports);
    expect(takeConfirmation(session, 'one', 99)).toBeNull();
    session.confirmations.set('expired', { plan: sports, expires: 100 });
    expect(takeConfirmation(session, 'expired', 100)).toBeNull();
  });

  it('invalidates sports confirmations on edits and cancels server-side without changing slot plans', () => {
    const session = createChatSessions().resolve().session;
    const expires = Date.now() + 10000;
    session.pendingSports = emptySportsRequest();
    session.confirmations.set('sports', { plan: sports, expires });
    session.confirmations.set('slot', { plan: slot, expires });
    clearSportsConfirmations(session);
    expect(session.confirmations.has('sports')).toBe(false);
    expect(cancelConfirmation(session, 'slot')).toBe(true);
    expect(session.pendingSports).not.toBeNull();
    session.confirmations.set('sports', { plan: sports, expires });
    expect(cancelConfirmation(session, 'sports')).toBe(true);
    expect(session.pendingSports).toBeNull();
    expect(cancelConfirmation(session, 'sports')).toBe(false);
  });

  it('rejects a confirmation bound to an older conversation revision even if its map entry remains', () => {
    const session = createChatSessions().resolve().session;
    const now = Date.now();
    const state = createSportsConversationState({ selections: [{ team: 'Arsenal', opponent: 'Chelsea' }],
      competition: 'premier-league', market: 'match-winner', stakeCents: 1000 }, now);
    const recorded = transitionSportsConversation(state, { type: 'summary_generated', revision: state.revision }, now).state;
    session.confirmations.set('old', { plan: sports, expires: now + 10000, sportsRevision: recorded.revision });
    session.conversationState = transitionSportsConversation(recorded, { type: 'message', messageId: 'correct', message: 'Actually R20',
      interpretation: { kind: 'correction', updates: { totalStake: { value: 'R20', evidence: 'R20' } } } }, now + 1).state;
    expect(takeConfirmation(session, 'old', now + 2)).toBeNull();
  });

  it('binds a sports confirmation to the exact request as well as its revision', () => {
    const session = createChatSessions().resolve().session;
    const now = Date.now();
    session.pendingSports = { selections: [{ team: 'Arsenal', opponent: 'Chelsea' }], competition: 'premier-league', market: 'match-winner', stakeCents: 1000 };
    const state = createSportsConversationState(session.pendingSports, now);
    session.conversationState = transitionSportsConversation(state, { type: 'summary_generated', revision: 0 }, now).state;
    const pending = { plan: sports, expires: now + 10000, sportsRevision: 0, sportsRequestFingerprint: sportsRequestFingerprint(session.pendingSports) };
    session.confirmations.set('valid', pending);
    expect(takeConfirmation(session, 'valid', now + 1)?.plan).toEqual(sports);
    session.confirmations.set('changed', pending);
    session.conversationState.request!.stakeCents = 2000;
    expect(takeConfirmation(session, 'changed', now + 1)).toBeNull();
  });

  it('bounds transcript history, deduplicates message IDs and never shares history across sessions', () => {
    const store = createChatSessions();
    const a = store.resolve().session;
    const b = store.resolve().session;
    for (let i = 0; i < 101; i++) rememberMessage(a, { id: String(i), role: 'user', text: 'Message ' + i });
    expect(a.messages).toHaveLength(100);
    expect(a.messages[0].id).toBe('1');
    rememberMessage(a, { id: '100', role: 'user', text: 'Duplicate' });
    expect(a.messages.at(-1)?.text).toBe('Message 100');
    expect(b.messages).toEqual([]);
  });
});
