const { randomBytes } = require('node:crypto');
const { CHAT_SESSION_TIMEOUT_MS } = require('./timeouts.cjs');

const COOKIE_NAME = 'hb_chat_session';

/** Browser-session boundary; never accept a caller-chosen unknown session ID. */
function createChatSessions({ ttlMs = CHAT_SESSION_TIMEOUT_MS, maxSessions = 1000 } = {}) {
  const sessions = new Map();
  return {
    resolve(cookieHeader = '', now = Date.now()) {
      for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
      }
      const id = cookieHeader.split(';').map((part) => part.trim())
        .find((part) => part.startsWith(COOKIE_NAME + '='))?.slice(COOKIE_NAME.length + 1);
      let session = id && sessions.get(id);
      const created = !session;
      if (!session) {
        if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
        session = { id: randomBytes(32).toString('hex'), expiresAt: now + ttlMs,
          pendingSports: null, conversationState: null, confirmations: new Map(), messages: [] };
      }
      session.expiresAt = now + ttlMs;
      for (const [planId, pending] of session.confirmations) {
        if (pending.expires <= now) session.confirmations.delete(planId);
      }
      sessions.delete(session.id);
      sessions.set(session.id, session);
      return { session, created, cookie: COOKIE_NAME + '=' + session.id + '; Path=/; HttpOnly; SameSite=Strict' };
    },
  };
}

function clearSportsConfirmations(session) {
  for (const [id, pending] of session.confirmations) {
    if (pending.plan.actions.some((action) => action.type === 'prepare_sports_bet')) session.confirmations.delete(id);
  }
}

function takeConfirmation(session, planId, now = Date.now()) {
  const pending = session.confirmations.get(planId);
  session.confirmations.delete(planId);
  if (!pending || pending.expires <= now) return null;
  const confirmation = session.conversationState?.confirmation;
  if (pending.sportsRevision !== undefined
    && (session.conversationState?.revision !== pending.sportsRevision
      || confirmation?.revision !== pending.sportsRevision
      || confirmation.expiresAt <= now
      || session.conversationState?.expiresAt <= now
      || pending.sportsRequestFingerprint !== sportsRequestFingerprint(session.conversationState?.request)
      || pending.sportsRequestFingerprint !== sportsRequestFingerprint(session.pendingSports)
      || !sportsPlanMatchesRequest(pending.plan, session.conversationState))) return null;
  return pending;
}

function sportsRequestFingerprint(request) {
  return request ? JSON.stringify({ selections: request.selections, competition: request.competition,
    market: request.market, stakeCents: request.stakeCents }) : null;
}

function sportsPlanMatchesRequest(plan, state) {
  const action = plan?.actions?.[0];
  const request = state?.request;
  return Boolean(request && plan.actions.length === 1 && action.type === 'prepare_sports_bet' && action.submit === false
    && state.phase === 'ready' && state.rejectedUpdates.length === 0 && !(state.teamSuggestions?.length)
    && state.confirmation?.revision === state.revision && state.summaryRequired === false
    && request.selections.every((selection) => selection.team && selection.opponent)
    && sportsRequestFingerprint(action) === sportsRequestFingerprint(request));
}

function rememberMessage(session, message) {
  if (session.messages.some((item) => item.id === message.id)) return;
  session.messages.push(message);
  session.messages = session.messages.slice(-100);
}

function replaceMessageResult(session, id, result) {
  const message = session.messages.find((item) => item.id === id);
  if (!message) return false;
  message.result = result;
  return true;
}

function cancelConfirmation(session, planId) {
  const pending = takeConfirmation(session, planId);
  if (!pending) return false;
  if (pending.plan.actions.some((action) => action.type === 'prepare_sports_bet')) {
    session.pendingSports = null;
    session.conversationState = null;
    clearSportsConfirmations(session);
  }
  return true;
}

module.exports = { createChatSessions, clearSportsConfirmations, takeConfirmation, cancelConfirmation,
  sportsRequestFingerprint, sportsPlanMatchesRequest, rememberMessage, replaceMessageResult };
