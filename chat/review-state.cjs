const { randomUUID } = require('node:crypto');

function createReviewState() {
  let active = null;
  return {
    begin({ runId, timeoutMs, now = Date.now() }) {
      if (active && !['finished', 'expired', 'browser_closed', 'server_stopped', 'failed'].includes(active.state)) throw new Error('REVIEW_ALREADY_ACTIVE');
      active = { id: randomUUID(), runId, timeoutMs, expiresAt: null, state: 'preparing' };
      return { ...active };
    },
    ready(id, runId, betslip, now = Date.now(), expiresAt = now + (active?.timeoutMs ?? 0)) {
      if (!active || active.id !== id || active.runId !== runId || expiresAt <= now
        || expiresAt > now + active.timeoutMs) return false;
      if (active.state === 'ready') return JSON.stringify(active.betslip) === JSON.stringify(betslip);
      if (active.state !== 'preparing') return false;
      active = { ...active, expiresAt, state: 'ready', betslip };
      return true;
    },
    finish(id, runId, now = Date.now()) {
      if (!active || active.id !== id || active.runId !== runId) return { ok: false, reason: 'unknown' };
      if (active.state === 'finished') return { ok: true, repeated: true };
      if (active.state === 'expired') return { ok: false, reason: 'expired' };
      if (active.expiresAt !== null && active.expiresAt <= now) {
        active = { ...active, state: 'expired' };
        return { ok: false, reason: 'expired' };
      }
      if (active.state !== 'ready') return { ok: false, reason: 'not_ready' };
      active = { ...active, state: 'finished' };
      return { ok: true, repeated: false };
    },
    expire(id, runId, now = Date.now()) {
      if (!active || active.id !== id || active.runId !== runId || active.expiresAt === null
        || active.expiresAt > now || active.state !== 'ready') return false;
      active = { ...active, state: 'expired' };
      return true;
    },
    complete(id, runId, state) {
      if (!active || active.id !== id || active.runId !== runId) return false;
      active = { ...active, state };
      return true;
    },
    get(id) { return active && (!id || active.id === id) ? { ...active } : null; },
    clear(id, runId) {
      if (!active || active.id !== id || active.runId !== runId) return false;
      active = null;
      return true;
    }
  };
}

function busyRejects(route, busy) {
  return busy && route !== '/api/finish-review';
}

function preparationReviewPayload(report, reviewId, expiresAt) {
  if (!report || report.status !== 'BETSLIP_READY' || report.success !== true) return null;
  const action = (report.actions || []).find((item) => item.type === 'prepare_sports_bet');
  const betslip = action && action.betslip;
  if (!betslip || betslip.status !== 'BETSLIP_READY' || betslip.submitted !== false
    || !Number.isSafeInteger(betslip.stakeCents) || betslip.stakeCents <= 0 || betslip.stakeCents > 5000
    || !Number.isSafeInteger(betslip.displayedPayoutCents) || betslip.displayedPayoutCents < 0
    || !['sportsbook-payout', 'stake-inclusive', 'unverified'].includes(betslip.displayedPayoutBasis)
    || (betslip.betType === 'single'
      ? betslip.displayedPayoutBasis !== 'sportsbook-payout'
        || !Number.isSafeInteger(betslip.potentialPayoutCents) || betslip.potentialPayoutCents < 0
        || betslip.potentialPayoutCents > betslip.displayedPayoutCents || betslip.potentialProfitCents !== null
      : betslip.displayedPayoutBasis === 'unverified'
        ? betslip.potentialPayoutCents !== null || betslip.potentialProfitCents !== null
        : betslip.displayedPayoutBasis !== 'stake-inclusive'
          || !Number.isSafeInteger(betslip.potentialPayoutCents) || betslip.potentialPayoutCents < 0
          || betslip.potentialPayoutCents > betslip.displayedPayoutCents
          || !Number.isSafeInteger(betslip.potentialProfitCents)
          || betslip.potentialProfitCents < 0
          || betslip.potentialProfitCents !== betslip.potentialPayoutCents - betslip.stakeCents)
    || betslip.market !== 'match-winner' || !['single', 'accumulator'].includes(betslip.betType)
    || !Array.isArray(betslip.selections) || betslip.selections.length === 0
    || (betslip.betType === 'single' ? betslip.selections.length !== 1 : betslip.selections.length < 2)
    || betslip.selections.some((selection) => !selection || typeof selection.fixture !== 'string'
      || !selection.fixture.trim() || typeof selection.selection !== 'string' || !selection.selection.trim()
      || selection.market !== 'match-winner' || !Number.isFinite(selection.displayedOdds)
      || selection.displayedOdds < 0)) return null;
  return { status: 'REVIEW_READY', reviewId, expiresAt, actions: [{ type: 'prepare_sports_bet', betslip }] };
}

module.exports = { createReviewState, busyRejects, preparationReviewPayload };
