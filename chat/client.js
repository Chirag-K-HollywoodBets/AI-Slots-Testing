
const form = document.getElementById('form');
const input = document.getElementById('instruction');
const mode = document.getElementById('mode');
const messages = document.getElementById('messages');
const send = document.getElementById('send');
const stage = document.getElementById('conversation-status');
const confirmationControls = new Map();
let requestInFlight = false;
let reviewActive = false;

function updateControls() {
  send.disabled = requestInFlight || reviewActive;
  input.disabled = requestInFlight || reviewActive;
  for (const control of confirmationControls.values()) {
    control.yes.disabled = requestInFlight || reviewActive;
    control.no.disabled = requestInFlight || reviewActive;
  }
}

function setPhase(phase) {
  stage.dataset.state = phase;
  stage.textContent = ({ idle: 'Ready for your request', clarification: 'Clarification — answer the question below',
    awaiting_confirmation: 'Awaiting confirmation — preparation has not started', running: 'Running — preparing the confirmed request',
    manual_review: 'Manual review — final submission is up to you' })[phase] || 'Ready for your request';
  reviewActive = phase === 'running' || phase === 'manual_review';
  updateControls();
}

function retireConfirmation(planId, note) {
  const control = confirmationControls.get(planId);
  if (!control) return;
  clearTimeout(control.timer);
  control.yes.remove(); control.no.remove();
  if (note) control.status.append('\n' + note);
  confirmationControls.delete(planId);
}

function syncConversation(conversation) {
  if (!conversation) return;
  const active = new Set((conversation.confirmations || []).map((item) => item.planId));
  for (const planId of confirmationControls.keys()) {
    if (!active.has(planId)) retireConfirmation(planId, 'This confirmation is no longer active. Use the latest summary.');
  }
  setPhase(conversation.phase);
}

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.textContent = content;
  messages.appendChild(div);
  return div;
}

function acceptedResultText(result) {
  const stake = Number.isSafeInteger(result.stakeCents) ? '\nStake: R' + (result.stakeCents / 100).toFixed(2) : '';
  const selections = Array.isArray(result.selections) ? result.selections
    .filter((item) => item && typeof item.fixture === 'string' && typeof item.selection === 'string')
    .map((item) => item.fixture + ': ' + item.selection).join('\n') : '';
  return 'Bet accepted\nReference: ' + result.betReference + stake + (selections ? '\nSelections:\n' + selections : '');
}

function render(status, response, result, options = {}) {
  if (result.reviewId) status.dataset.reviewId = result.reviewId;
  if (!options.restoring) syncConversation(result.conversation);
  if (!response.ok) {
    status.dataset.state = 'error';
    if (!options.restoring) setPhase('idle');
    status.textContent =
      'ERROR\n' +
      'Code: ' + (result.code || 'UNKNOWN') + '\n' +
      'Reason: ' + (result.error || 'Unknown error');
    return;
  }

  const usageText = result.usage && result.usage.source === 'reported'
    ? '\nToken usage (provider reported): ' +
      [result.usage.inputTokens !== undefined ? 'input ' + result.usage.inputTokens : '',
       result.usage.outputTokens !== undefined ? 'output ' + result.usage.outputTokens : '',
       result.usage.totalTokens !== undefined ? 'total ' + result.usage.totalTokens : '']
        .filter(Boolean).join(', ') +
      (result.usage.model ? '\nModel: ' + result.usage.model : '')
    : '';

  if (['CLARIFICATION', 'AMBIGUOUS', 'UNRELATED', 'CANCELLED', 'EXPIRED', 'UNCHANGED'].includes(result.status)) {
    status.dataset.state = result.status === 'CLARIFICATION' || result.status === 'AMBIGUOUS' ? 'clarification' : 'idle';
    status.textContent = (result.status === 'CLARIFICATION' ? 'A few details first\n' : '') + result.reason + usageText;
    return;
  }

  if (result.status === 'CONFIRM') {
    status.dataset.state = 'awaiting_confirmation';
    status.textContent = 'AWAITING CONFIRMATION\n' + result.summary + usageText + '\n';
    const live = options.restoring ? options.conversation : result.conversation;
    if (live && !(live.confirmations || []).some((item) => item.planId === result.planId)) {
      status.append('This confirmation is no longer active.');
      return;
    }
    if (result.expiresAt && result.expiresAt <= Date.now()) {
      status.append('This confirmation has expired. Start with “New request: …” for a fresh summary.');
      return;
    }
    const yes = document.createElement('button');
    yes.textContent = 'Confirm and run';
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    no.style.marginLeft = '8px';
    yes.type = 'button'; no.type = 'button';
    status.append(yes, no);
    const timer = result.expiresAt ? setTimeout(() => {
      retireConfirmation(result.planId, 'Confirmation expired. Start with “New request: …” for a fresh summary.');
      if (!confirmationControls.size && !reviewActive) setPhase('clarification');
    }, Math.max(0, result.expiresAt - Date.now())) : undefined;
    confirmationControls.set(result.planId, { yes, no, status, timer });
    updateControls();

    yes.onclick = async () => {
      if (requestInFlight || reviewActive || yes.disabled || !confirmationControls.has(result.planId)) return;
      requestInFlight = true;
      retireConfirmation(result.planId, 'Confirmation sent. The server will check this summary before preparation.');
      const running = addMessage('agent', 'Running confirmed plan...');
      setPhase('running');
      try {
        const r = await fetch('/api/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: result.planId })
        });
        render(running, r, await r.json());
      } catch {
        running.textContent = 'Unable to reach the test server.';
        setPhase('idle');
      } finally {
        requestInFlight = false;
        updateControls();
      }
    };
    no.onclick = async () => {
      if (requestInFlight || reviewActive || no.disabled || !confirmationControls.has(result.planId)) return;
      requestInFlight = true;
      updateControls();
      try {
        const r = await fetch('/api/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: result.planId })
        });
        const ended = await r.json();
        if (!r.ok) throw new Error(ended.error || 'Cancellation failed.');
        retireConfirmation(result.planId);
        render(addMessage('agent', ''), r, ended);
      } catch (error) {
        status.append('\n' + (error && error.message ? error.message : String(error)));
      } finally {
        requestInFlight = false;
        updateControls();
      }
    };
    return;
  }

  if (result.status === 'REVIEW_READY') {
    status.dataset.state = 'manual_review';
    if (!options.restoring) setPhase('manual_review');
    const prepared = (result.actions || []).find((action) => action.type === 'prepare_sports_bet');
    const bet = prepared && prepared.betslip;
    const selectionsText = bet && Array.isArray(bet.selections)
      ? bet.selections.map((selection) => selection.fixture + ': ' + selection.selection +
        ' — displayed odds ' + (Number.isFinite(selection.displayedOdds) ? Number(selection.displayedOdds).toFixed(2) : 'unavailable')).join('\n')
      : '';
    status.textContent = 'BETSLIP READY — AWAITING REVIEW\n' +
      (bet ? 'Selections:\n' + selectionsText + '\nBet type: ' + bet.betType +
        '\nCompetition: ' + (result.competition === 'premier-league' ? 'Premier League' : result.competition || 'unavailable') +
        '\nMarket: ' + (bet.market === 'match-winner' ? 'Match winner' : bet.market) +
        '\nBase odds (' + (bet.oddsBasis === 'sportsbook-displayed' ? 'sportsbook displayed' :
          bet.oddsBasis === 'fractional-accumulator-calculation' ? 'calculated from displayed leg odds; not sportsbook-verified' : 'combined decimal') +
          '): ' + (Number.isFinite(bet.baseOdds ?? bet.combinedOdds) ? Number(bet.baseOdds ?? bet.combinedOdds).toFixed(2) : 'unavailable') +
        '\nBonus: ' + (bet.bonusStatus === 'verified' && Number.isFinite(bet.observedBonusPercent)
          ? Number(bet.observedBonusPercent).toFixed(2) + '% verified' : 'unverified; no bonus assumed') +
        '\nFinal odds: ' + (Number.isFinite(bet.finalOdds) ? Number(bet.finalOdds).toFixed(2) : 'unverified') +
        '\nDisplayed payout / stake multiplier: ' + (bet.displayedPayoutBasis !== 'unverified' && Number.isFinite(bet.payoutMultiplier)
          ? Number(bet.payoutMultiplier).toFixed(3) : 'unverified') +
        '\nSportsbook displayed Payout: R' + (Number(bet.displayedPayoutCents) / 100).toFixed(2) +
        '\nPayout basis: ' + (bet.displayedPayoutBasis === 'unverified' ? 'unverified' : bet.displayedPayoutBasis) +
        (Number.isSafeInteger(bet.payoutAdjustmentCents) ? '\nObserved payout adjustment from base: R' + (Number(bet.payoutAdjustmentCents) / 100).toFixed(2) : '') +
        '\nTotal stake: R' + (Number(bet.stakeCents) / 100).toFixed(2) +
        '\nPotential payout (after configured cap): ' + (Number.isSafeInteger(bet.potentialPayoutCents)
          ? 'R' + (Number(bet.potentialPayoutCents) / 100).toFixed(2) : 'unavailable') +
        (bet.betType === 'single' || bet.displayedPayoutBasis === 'unverified' ? '' :
          '\nPotential profit: ' + (Number.isSafeInteger(bet.potentialProfitCents)
            ? 'R' + (Number(bet.potentialProfitCents) / 100).toFixed(2) : 'unavailable')) + '\n' : '') +
      'Potential winnings are not guaranteed and depend on settlement rules.\n' +
      'When enabled, clicking Submit places this bet. Check every detail before proceeding.\nThis review is available only while this session remains open.\nExpires: ' +
      new Date(result.expiresAt).toLocaleString() + '\n' + usageText;
    if (options.restoring) return;
    const finish = document.createElement('button');
    finish.textContent = 'Finish without submitting';
    const submitBet = document.createElement('button');
    submitBet.textContent = 'Submit R' + (bet ? (Number(bet.stakeCents) / 100).toFixed(2) : '—') + ' bet';
    submitBet.style.marginLeft = '8px';
    const termsVerified = bet && (bet.betType === 'single'
      ? bet.oddsBasis === 'sportsbook-displayed' && bet.displayedPayoutBasis === 'sportsbook-payout'
      : bet.oddsBasis === 'sportsbook-displayed' && bet.bonusStatus === 'verified'
        && Number.isFinite(bet.baseOdds) && Number.isFinite(bet.observedBonusPercent)
        && Number.isFinite(bet.finalOdds) && bet.displayedPayoutBasis === 'stake-inclusive');
    submitBet.disabled = !bet || !termsVerified || !result.idempotencyKey
      || !Number.isSafeInteger(result.revision) || result.submissionEnabled !== true;
    status.append(submitBet, finish);
    if (!termsVerified) status.append('\nSubmission is disabled because odds, bonus, final odds or payout basis are not fully verified for this slip.');
    else if (!result.submissionEnabled) status.append('\n' + (result.submissionBlockReason || 'Submission is currently unavailable.'));
    let reviewPoll;
    submitBet.onclick = async () => {
      if (requestInFlight || submitBet.disabled) return;
      requestInFlight = true;
      submitBet.disabled = true;
      finish.disabled = true;
      submitBet.textContent = 'Checking slip and requesting submission…';
      clearInterval(reviewPoll);
      try {
        const r = await fetch('/api/submit-review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewId: result.reviewId, revision: result.revision,
            idempotencyKey: result.idempotencyKey }) });
        const outcome = await r.json();
        if (!r.ok && !outcome.status) {
          status.append('\n' + (outcome.error || 'The review could not be submitted.'));
          setPhase('idle');
          return;
        }
        if (outcome.status === 'REVIEW_READY' && outcome.refreshed) {
          clearInterval(reviewPoll);
          render(status, { ok: true }, outcome);
          return;
        }
        if (outcome.status === 'SUBMISSION_BLOCKED') {
          submitBet.remove();
          finish.disabled = false;
          status.append('\n' + outcome.reason + ' You can finish this review without submitting.');
          return;
        }
        clearInterval(reviewPoll);
        for (const child of Array.from(status.children)) if (child.tagName === 'BUTTON') child.remove();
        status.append('\n' + (outcome.status === 'BET_ACCEPTED'
          ? acceptedResultText(outcome)
          : outcome.status === 'BET_REJECTED' ? 'The sportsbook explicitly rejected the bet. ' + (outcome.reason || '')
            : outcome.status === 'SUBMISSION_BLOCKED' ? outcome.reason
              : 'Submission attempted—acceptance unverified. Check My Bets before trying again.'));
        setPhase('idle');
      } catch {
        clearInterval(reviewPoll);
        submitBet.remove(); finish.remove();
        status.append('\nSubmission attempted—acceptance unverified. Check My Bets before trying again.');
        setPhase('idle');
      } finally { requestInFlight = false; updateControls(); }
    };
    finish.onclick = async () => {
      finish.disabled = true;
      try {
        const r = await fetch('/api/finish-review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reviewId: result.reviewId })
        });
        const ended = await r.json();
        if (!r.ok) throw new Error(ended.error || 'Review could not be finished.');
        clearInterval(reviewPoll);
        finish.remove();
        status.append('\nReview finished without submitting.');
        setPhase('idle');
      } catch (error) {
        status.append('\n' + (error && error.message ? error.message : String(error)));
        finish.disabled = false;
      }
    };
    reviewPoll = setInterval(async () => {
      try {
        const response = await fetch('/api/review-status?reviewId=' + encodeURIComponent(result.reviewId));
        const current = await response.json();
        if (requestInFlight || finish.disabled) return;
        if (current.status === 'REVIEW_READY') return;
        clearInterval(reviewPoll);
        render(status, { ok: true }, current);
      } catch {
        // Keep the finish control visible while the server may reconnect.
      }
    }, 1000);
    return;
  }

  if (result.status === 'REVIEW_EXPIRED' || result.status === 'REVIEW_CLOSED') {
    const keepSlip = status.dataset.state === 'manual_review';
    status.dataset.state = 'idle';
    if (!options.restoring) setPhase('idle');
    const closed = result.status === 'REVIEW_EXPIRED'
      ? 'Review expired — no bet submitted'
      : (result.reason || 'Review ended because its browser session closed. No bet was submitted.');
    if (keepSlip) {
      for (const child of Array.from(status.children)) if (child.tagName === 'BUTTON') child.remove();
      status.append('\n' + closed);
    } else status.textContent = closed;
    return;
  }

  if (['BET_ACCEPTED', 'BET_REJECTED', 'BET_OUTCOME_UNKNOWN', 'SUBMISSION_BLOCKED'].includes(result.status)) {
    status.dataset.state = 'idle';
    if (!options.restoring) setPhase('idle');
    status.textContent = result.status === 'BET_ACCEPTED'
      ? acceptedResultText(result)
      : result.status === 'BET_REJECTED' ? 'The sportsbook explicitly rejected the bet. ' + (result.reason || '')
        : result.status === 'SUBMISSION_BLOCKED' ? result.reason
          : 'Submission attempted—acceptance unverified. Check My Bets before trying again.';
    return;
  }

  if (result.status === 'REVIEW_STARTING') {
    status.dataset.state = 'running';
    status.textContent = 'RUNNING\nPreparing the confirmed betslip. The agent does not submit the bet.' + usageText;
    if (options.restoring) return;
    setPhase('running');
    const reviewId = result.reviewId;
    const poll = async () => {
      try {
        const response = await fetch('/api/review-status?reviewId=' + encodeURIComponent(reviewId));
        const current = await response.json();
        if (current.status === 'REVIEW_STARTING') { setTimeout(poll, 500); return; }
        render(status, { ok: true }, current);
      } catch {
        status.textContent = 'Unable to reach the test server. Review state is unknown.';
      }
    };
    poll();
    return;
  }

  if (result.status === 'BET_SUBMISSION_SENT') {
    status.textContent = 'Sports submission is disabled until the required sportsbook and account checks are verified.';
    return;
  }

  const slotAction = (result.actions || []).find((action) => action.type === 'play_slot');
  if (!options.restoring) setPhase(result.conversation?.phase || 'idle');
  const slotResult = slotAction && slotAction.result;
  const slotProgress = slotResult && Number.isInteger(slotResult.spinsSettled)
    ? slotResult.stoppedBeforeAnySpin
      ? '\nSlot run stopped before any spin; 0 spins completed.'
      : '\nSlot run ' + (slotAction.success ? 'completed ' : 'stopped after ') +
        slotResult.spinsSettled + ' settled spin(s); ' + slotResult.doSpinRequestsSent + ' doSpin request(s) were sent.'
    : '';
  status.textContent =
    (result.status || (result.success ? 'PASS' : 'FAIL')) +
    (result.reason ? '\nReason: ' + result.reason : '') +
    slotProgress +
    (result.durationMs !== undefined
      ? '\nExecution time: ' + result.durationMs + ' ms'
      : '') +
    usageText +
    '\n' + JSON.stringify(result.actions ?? [], null, 2);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (requestInFlight || reviewActive) return;
  const instruction = input.value.trim();
  if (!instruction) return;

  addMessage('user', instruction);
  input.value = '';
  requestInFlight = true;
  updateControls();
  addMessage('agent', 'Checking your request...');

  const status = messages.lastElementChild;

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, mode: mode.value, messageId: crypto.randomUUID() })
    });

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('The server returned an unreadable response (HTTP ' + response.status + ').');
    }
    render(status, response, result);
  } catch (error) {
    status.textContent = 'Request failed: ' + (error && error.message ? error.message : String(error));
  } finally {
    requestInFlight = false;
    updateControls();
  }
});

async function restoreConversation() {
  requestInFlight = true;
  updateControls();
  try {
    const response = await fetch('/api/conversation-state');
    if (response.ok) {
      const snapshot = await response.json();
      for (const message of snapshot.messages || []) {
        const bubble = addMessage(message.role === 'user' ? 'user' : 'agent', message.text || '');
        if (message.result) render(bubble, { ok: true }, message.result, { restoring: true, conversation: snapshot.conversation });
      }
      syncConversation(snapshot.conversation);
    }
    const responseReview = await fetch('/api/review-current');
    if (!responseReview.ok) return;
    const current = await responseReview.json();
    if (['REVIEW_STARTING', 'REVIEW_READY', 'REVIEW_CLOSED', 'REVIEW_EXPIRED'].includes(current.status)) {
      const status = Array.from(messages.children).reverse().find((bubble) => bubble.dataset.reviewId === current.reviewId)
        || addMessage('agent', '');
      render(status, { ok: true }, current);
    } else if (['BET_ACCEPTED', 'BET_REJECTED', 'BET_OUTCOME_UNKNOWN'].includes(current.status)) {
      const prior = Array.from(messages.children).reverse().find((bubble) =>
        bubble.textContent.includes('Submission attempted—acceptance unverified.')) || addMessage('agent', '');
      render(prior, { ok: true }, current, { restoring: true });
    }
  } catch {
    addMessage('agent', 'Unable to restore the conversation. Saved requests remain on the server.');
  } finally {
    requestInFlight = false;
    updateControls();
  }
}
restoreConversation();
