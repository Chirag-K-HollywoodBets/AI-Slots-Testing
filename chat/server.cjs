
const http = require('node:http');
const { spawn } = require('node:child_process');
const { readFile, writeFile, mkdtemp, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { withUsage, pendingPlan } = require('./usage.cjs');
const { describeSlotPlan } = require('./slot-summary.cjs');
const { createReviewState, preparationReviewPayload, busyRejects } = require('./review-state.cjs');
const { extractExplicitStakeCents } = require('./sports-stake.cjs');

const PORT = 3001;
const HOST = '127.0.0.1';
const PROJECT = path.resolve(__dirname, '..');

let busy = false;
const reviews = createReviewState();
let activeReview = null;
const configuredReviewTimeout = Number(process.env.SPORTS_REVIEW_TIMEOUT_MS ?? 300_000);
const REVIEW_TIMEOUT_MS = Number.isFinite(configuredReviewTimeout)
  ? Math.min(600_000, Math.max(30_000, Math.floor(configuredReviewTimeout)))
  : 300_000;

// Wager plans wait here until the user confirms them. Keyed by a random id,
// so the plan itself never round-trips through the browser.
const pendingPlans = new Map();
const CONFIRM_WINDOW_MS = 2 * 60 * 1000;

const READ_ONLY_TEST = 'tests/agent-ai-demo.e2e.ts';
const SLOT_TEST = 'tests/agent-slot.e2e.ts';
const SPORTS_TEST = 'tests/agent-sports.e2e.ts';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HollywoodBets AI Testing Agent</title>
<style>
body {
  font-family: Arial, sans-serif;
  background: #15121f;
  color: white;
  margin: 0;
}
main {
  max-width: 850px;
  margin: 40px auto;
  padding: 24px;
}
h1 { color: #f7c948; }
#messages {
  min-height: 350px;
  background: #211b30;
  padding: 20px;
  border-radius: 12px;
}
.message {
  padding: 14px;
  margin: 12px 0;
  background: #342a48;
  border-radius: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.user { border-left: 4px solid #f7c948; }
.agent { border-left: 4px solid #8b7cf8; }
form { display: flex; gap: 10px; margin-top: 20px; }
input {
  flex: 1;
  padding: 14px;
  border-radius: 8px;
  border: none;
}
button {
  background: #f7c948;
  color: #17121f;
  border: none;
  padding: 14px 20px;
  border-radius: 8px;
  cursor: pointer;
}
button:disabled { opacity: .5; }
</style>
</head>
<body>
<main>
<h1>HollywoodBets AI Testing Agent</h1>
<p>Local Qwen + E2E | Read-only checks, confirmed test-account slots, and fail-closed sportsbook requests</p>
<div id="messages"></div>
<form id="form">
<input id="instruction"
 maxlength="500"
 placeholder="Enter a testing instruction..."
 required>
<button id="send">Run Test</button>
</form>
</main>
<script>
const form = document.getElementById('form');
const input = document.getElementById('instruction');
const messages = document.getElementById('messages');
const send = document.getElementById('send');

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.textContent = content;
  messages.appendChild(div);
  return div;
}

function render(status, response, result) {
  if (!response.ok) {
    status.textContent =
      'ERROR\\n' +
      'Code: ' + (result.code || 'UNKNOWN') + '\\n' +
      'Reason: ' + (result.error || 'Unknown error');
    return;
  }

  const usageText = result.usage && result.usage.source === 'reported'
    ? '\\nToken usage (provider reported): ' +
      [result.usage.inputTokens !== undefined ? 'input ' + result.usage.inputTokens : '',
       result.usage.outputTokens !== undefined ? 'output ' + result.usage.outputTokens : '',
       result.usage.totalTokens !== undefined ? 'total ' + result.usage.totalTokens : '']
        .filter(Boolean).join(', ') +
      (result.usage.model ? '\\nModel: ' + result.usage.model : '')
    : '';

  if (result.status === 'CONFIRM') {
    status.textContent = 'CONFIRMATION NEEDED\\n' + result.summary + usageText + '\\n';
    const yes = document.createElement('button');
    yes.textContent = 'Confirm and run';
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    no.style.marginLeft = '8px';
    status.append(yes, no);

    yes.onclick = async () => {
      yes.remove(); no.remove();
      const running = addMessage('agent', 'Running confirmed plan...');
      send.disabled = true;
      try {
        const r = await fetch('/api/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId: result.planId })
        });
        render(running, r, await r.json());
      } catch {
        running.textContent = 'Unable to reach the test server.';
      } finally {
        send.disabled = false;
      }
    };
    no.onclick = () => {
      yes.remove(); no.remove();
      status.textContent += '\\nCancelled. Nothing was run.';
    };
    return;
  }

  if (result.status === 'REVIEW_READY') {
    const prepared = (result.actions || []).find((action) => action.type === 'prepare_sports_bet');
    const bet = prepared && prepared.betslip;
    const selectionsText = bet && Array.isArray(bet.selections)
      ? bet.selections.map((selection) => selection.fixture + ': ' + selection.selection).join('\\n')
      : '';
    status.textContent = 'BETSLIP READY — AWAITING REVIEW\\n' +
      (bet ? 'Selections:\\n' + selectionsText + '\\nBet type: ' + bet.betType +
        '\\nMarket: ' + (bet.market === 'match-winner' ? 'Match winner' : bet.market) +
        '\\nBase odds (' + (bet.oddsBasis === 'sportsbook-displayed' ? 'sportsbook displayed' : 'combined decimal, before bonus') + '): ' + (Number.isFinite(bet.combinedOdds) ? Number(bet.combinedOdds).toFixed(3) : 'unavailable') +
        '\\nDisplayed payout / stake multiplier: ' + (Number.isFinite(bet.payoutMultiplier) ? Number(bet.payoutMultiplier).toFixed(3) : 'unavailable') +
        '\\nBonus: unverified; displayed payout adjustment from base: R' + (Number(bet.payoutAdjustmentCents) / 100).toFixed(2) +
        '\\nSportsbook displayed Payout: R' + (Number(bet.displayedPayoutCents) / 100).toFixed(2) +
        '\\nTotal stake: R' + (Number(bet.stakeCents) / 100).toFixed(2) +
        '\\nPotential payout (after configured cap): ' + (Number.isSafeInteger(bet.potentialPayoutCents)
          ? 'R' + (Number(bet.potentialPayoutCents) / 100).toFixed(2) : 'unavailable') +
        '\\nPotential profit: ' + (Number.isSafeInteger(bet.potentialProfitCents)
          ? 'R' + (Number(bet.potentialProfitCents) / 100).toFixed(2) : 'unavailable') + '\\n' : '') +
      'Potential winnings are not guaranteed and depend on settlement rules.\\n' +
      'This review is available only while this session remains open. The agent did not submit. If you choose to proceed, click Submit in the sportsbook yourself.\\nExpires: ' +
      new Date(result.expiresAt).toLocaleString() + '\\n' + usageText;
    const finish = document.createElement('button');
    finish.textContent = 'Finish review';
    status.appendChild(finish);
    let reviewPoll;
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
        status.append('\\nReview finished. The agent did not submit the bet.');
      } catch (error) {
        status.append('\\n' + (error && error.message ? error.message : String(error)));
        finish.disabled = false;
      }
    };
    reviewPoll = setInterval(async () => {
      try {
        const response = await fetch('/api/review-status?reviewId=' + encodeURIComponent(result.reviewId));
        const current = await response.json();
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
    status.textContent = result.status === 'REVIEW_EXPIRED'
      ? 'Review expired — no bet submitted'
      : (result.reason || 'Review ended because its browser session closed. No bet was submitted.');
    return;
  }

  if (result.status === 'REVIEW_STARTING') {
    status.textContent = 'Preparing the confirmed betslip...';
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
  const slotResult = slotAction && slotAction.result;
  const slotProgress = slotResult && Number.isInteger(slotResult.completedSpins)
    ? slotResult.stoppedBeforeAnySpin
      ? '\\nSlot run stopped before any spin; 0 spins completed.'
      : '\\nSlot run ' + (slotAction.success ? 'completed ' : 'stopped after ') +
        slotResult.completedSpins + ' verified spin(s); ' + slotResult.attemptedSpins + ' spin(s) were attempted.'
    : '';
  status.textContent =
    (result.status || (result.success ? 'PASS' : 'FAIL')) +
    (result.reason ? '\\nReason: ' + result.reason : '') +
    slotProgress +
    (result.durationMs !== undefined
      ? '\\nExecution time: ' + result.durationMs + ' ms'
      : '') +
    usageText +
    '\\n' + JSON.stringify(result.actions ?? [], null, 2);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const instruction = input.value.trim();
  if (!instruction) return;

  addMessage('user', instruction);
  input.value = '';
  send.disabled = true;
  addMessage('agent', 'Running test...');

  const status = messages.lastElementChild;

  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction })
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
    send.disabled = false;
  }
});

fetch('/api/review-current').then(async (response) => {
  if (!response.ok) return;
  const current = await response.json();
  if (current.status === 'REVIEW_STARTING' || current.status === 'REVIEW_READY') {
    const status = addMessage('agent', '');
    render(status, { ok: true }, current);
  }
}).catch(() => {});
</script>
</body>
</html>`;

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}



function runNode(args, env, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c) => { stdout = (stdout + c.toString()).slice(-20000); });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-20000); });
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Unable to launch process')); });
    child.on('close', (code) => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }); });
  });
}

// Plans without touching the browser. Returns the PLAN_RESULT object.
async function planInstruction(instruction) {
  const tsxCli = path.join(PROJECT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  console.log('[Planner] Starting plan generation');
  const { stdout, stderr } = await runNode(
    [tsxCli, 'scripts/plan.ts'],
    { AGENT_INSTRUCTION: instruction },
    90000
  );
  console.log('[Planner] Plan generation process finished');
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PLAN_RESULT:'));
  if (!line) {
    console.error('Planner stderr:', stderr);
    throw new Error('PLANNING_FAILED');
  }
  return JSON.parse(line.slice('PLAN_RESULT:'.length));
}

function describePlan(plan) {
  const sportsBet = plan.actions.find((a) => a.type === 'prepare_sports_bet');
  if (sportsBet) {
    const picks = sportsBet.selections.map((selection) => selection.team
      + (selection.opponent ? ' vs ' + selection.opponent : '')).join('; ');
    return 'Prepare ' + (sportsBet.selections.length > 1 ? 'one accumulator' : 'one single bet')
      + ' for ' + picks + ' at R' + (sportsBet.stakeCents / 100).toFixed(2)
      + ' total. Final review acceptance would be separate authorization.';
  }
  const spin = plan.actions.find((a) => a.type === 'play_slot');
  if (!spin) return 'Open a casino game on the test account.';
  return describeSlotPlan(spin);
}

// Writes the plan to a temp file, runs one test file, returns the report.
async function executePlanFile(plan, testFile, extraEnv) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hwb-agent-'));
  try {
    const planPath = extraEnv.AGENT_PLAN_PATH || path.join(directory, 'plan.json');
    const reportPath = extraEnv.AGENT_REPORT_PATH || path.join(directory, 'report.json');
    await writeFile(planPath, JSON.stringify(plan), 'utf8');

    let code;
    try {
      code = await runTest(testFile, {
        AGENT_PLAN_PATH: planPath,
        AGENT_REPORT_PATH: reportPath,
        ...extraEnv
      }, testFile === SLOT_TEST ? 600000 : extraEnv.AGENT_REVIEW_ID ? 950000 : testFile === SPORTS_TEST ? 300000 : 120000);
    } catch (error) {
      // A failed run can still have written a useful report.
      code = -1;
      if (!/exited with code/.test(error.message)) throw error;
    }

    let report;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch {
      throw new Error('NO_REPORT');
    }
    return { code, report };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function startReviewRun(plan, usage) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hwb-review-'));
  const planPath = path.join(directory, 'plan.json');
  const reportPath = path.join(directory, 'report.json');
  const reviewReadyPath = path.join(directory, 'review-ready.json');
  const reviewDecisionPath = path.join(directory, 'review-decision.json');
  const reviewStatePath = path.join(directory, 'review-state.json');
  const reviewStopPath = path.join(directory, 'review-stop');
  const runId = randomUUID();
  const review = reviews.begin({ runId, timeoutMs: REVIEW_TIMEOUT_MS });
  await writeFile(planPath, JSON.stringify(plan), 'utf8');
  activeReview = { ...review, directory, reportPath, reviewReadyPath, reviewDecisionPath, reviewStatePath, reviewStopPath, usage, plan };
  busy = true;
  executePlanFile(plan, SPORTS_TEST, {
    ALLOW_SPORTS_PREPARE: '1',
    AGENT_REVIEW_ID: review.id,
    AGENT_REVIEW_RUN_ID: runId,
    AGENT_REVIEW_TIMEOUT_MS: String(REVIEW_TIMEOUT_MS),
    AGENT_REVIEW_READY_PATH: reviewReadyPath,
    AGENT_REVIEW_DECISION_PATH: reviewDecisionPath,
    AGENT_REVIEW_STATE_PATH: reviewStatePath,
    AGENT_REVIEW_STOP_PATH: reviewStopPath,
    AGENT_PLAN_PATH: planPath,
    AGENT_REPORT_PATH: reportPath
  }).then(({ code, report }) => {
    const state = report.status === 'REVIEW_EXPIRED' ? 'expired'
      : report.status === 'REVIEW_CLOSED' ? 'browser_closed'
        : report.status === 'REVIEW_FINISHED' ? 'finished'
          : 'failed';
    reviews.complete(review.id, runId, state);
    activeReview.terminal = { code, report };
    busy = false;
  }).catch((error) => {
    reviews.complete(review.id, runId, 'failed');
    activeReview.terminal = { error: error instanceof Error ? error.message : 'REVIEW_FAILED' };
    busy = false;
  }).finally(async () => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });
  return review;
}

async function readReviewStatus(review) {
  if (!review.terminal) {
    try {
      const state = JSON.parse(await readFile(review.reviewStatePath, 'utf8'));
      if (state.id === review.id && state.runId === review.runId) {
        if (state.outcome === 'expired') return { status: 'REVIEW_EXPIRED', reason: 'Review expired — no bet submitted' };
        if (state.outcome === 'browser_closed') return { status: 'REVIEW_CLOSED', reason: 'The review browser was closed; no bet was submitted.' };
        if (state.outcome === 'server_stopped') return { status: 'REVIEW_CLOSED', reason: 'The chat server stopped and closed the review; no bet was submitted.' };
        if (state.outcome === 'finished') return { status: 'REVIEW_CLOSED', reason: 'Review finished — no bet submitted' };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (review.terminal) {
    if (review.terminal.error) return { status: 'REVIEW_CLOSED', reason: 'The review runner failed and closed its browser context. No bet was submitted.' };
    const report = review.terminal.report;
    if (report.status === 'REVIEW_EXPIRED') return { status: 'REVIEW_EXPIRED', reason: 'Review expired — no bet submitted' };
    if (report.status === 'REVIEW_CLOSED') return { status: 'REVIEW_CLOSED', reason: report.reason };
    if (report.status === 'REVIEW_FINISHED') return { status: 'REVIEW_CLOSED', reason: 'Review finished — no bet submitted' };
    return { status: 'REVIEW_CLOSED', reason: report.reason || 'Review ended; no bet was submitted.' };
  }
  try {
    const ready = JSON.parse(await readFile(review.reviewReadyPath, 'utf8'));
    if (ready.id !== review.id || ready.submitted !== false) return { status: 'REVIEW_CLOSED', reason: 'The review did not match its active run.' };
    if (ready.expiresAt <= Date.now()) {
      reviews.complete(review.id, review.runId, 'expired');
      return { status: 'REVIEW_EXPIRED', reason: 'Review expired — no bet submitted' };
    }
    const payload = preparationReviewPayload({ status: 'BETSLIP_READY', success: true,
      actions: [{ type: 'prepare_sports_bet', betslip: ready.betslip }] }, review.id, ready.expiresAt);
    if (!payload || !reviews.ready(review.id, review.runId, ready.betslip, Date.now(), ready.expiresAt)) {
      return { status: 'REVIEW_CLOSED', reason: 'The prepared slip did not pass review checks.' };
    }
    return payload;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { status: 'REVIEW_STARTING', reviewId: review.id };
  }
}

function runTest(testFile, extraEnv, timeoutMs) {
  return new Promise((resolveRun, reject) => {
    const e2eCli = path.join(
      PROJECT,
      'node_modules',
      'e2e',
      'dist',
      'cli',
      'bin.js'
    );

    const child = spawn(
      process.execPath,
      [
  e2eCli,
  'run',
  '--config',
  'e2e.edge-clean.config.ts',
  testFile
],
      {
        cwd: PROJECT,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          APP_URL: 'https://www.hollywoodbets.net/',
          // Spins stay disabled unless the confirmed path turns them on.
          ALLOW_SPINS: '0',
          ...extraEnv
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-12000);
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timeout);
      console.error('E2E launch error:', error.code);
      reject(new Error('Unable to launch E2E process'));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);

      console.log('E2E exit code:', code);
      console.log('E2E termination signal:', signal);

      if (timedOut) {
        reject(new Error('E2E test timed out'));
        return;
      }

      if (code === 0) {
        resolveRun(code);
      } else {
        // Local diagnostics only. Do not enable unrestricted
        // output logging for authenticated production tests.
        console.error('E2E stdout:', stdout);
        console.error('E2E stderr:', stderr);

        reject(
          new Error('E2E process exited with code ' + code)
        );
      }
    });
  });
}



function errorResponse(res, error) {
  const message = error instanceof Error ? error.message : '';
  console.error('[Agent execution error]', message);

  let code = 'EXECUTION_FAILED';
  let userMessage = 'The test could not be completed.';
  let status = 500;

  if (/LLM_UNAVAILABLE|Bad Gateway|HTTP 502/i.test(message)) {
    code = 'LLM_UNAVAILABLE';
    userMessage = 'The local Qwen service is unavailable.';
  } else if (/PLANNING_FAILED/.test(message)) {
    code = 'PLANNING_FAILED';
    userMessage = 'The planner could not produce a plan.';
  } else if (/NO_REPORT/.test(message)) {
    code = 'NO_REPORT';
    userMessage = 'Test did not produce a report.';
  } else if (/INVALID_SPORTS_PLAN/.test(message)) {
    code = 'INVALID_SPORTS_PLAN';
    userMessage = 'The model returned extra actions for this sports request. Please send it again.';
    status = 422;
  } else if (/timed out/i.test(message)) {
    code = 'EXECUTION_TIMEOUT';
    userMessage = 'The test exceeded its execution time limit.';
  } else if (/launch|ENOENT|EINVAL/i.test(message)) {
    code = 'BROWSER_RUNNER_ERROR';
    userMessage = 'The E2E test runner could not be started.';
  }

  return sendJson(res, status, { success: false, code, error: userMessage });
}

function reportResponse(res, code, report, usage, extra = {}) {
  return sendJson(res, 200, withUsage({
    status: report.status ?? (code === 0 && report.success === true ? 'PASS' : 'FAIL'),
    success: code === 0 && report.success === true,
    reason: report.reason,
    durationMs: report.durationMs,
    actions: report.actions ?? [],
    ...extra
  }, usage));
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error('TOO_LARGE');
  }
  return JSON.parse(body);
}

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1:3001');
  if (req.method === 'POST') {
    console.log('[Chat request] ' + req.method + ' ' + requestUrl.pathname + ' received');
    res.on('finish', () => {
      console.log('[Chat request] ' + requestUrl.pathname + ' completed HTTP ' + res.statusCode + ' in ' + (Date.now() - startedAt) + ' ms');
    });
  }

  if (requestUrl.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"
    });
    return res.end(html);
  }

  const route = requestUrl.pathname;
  if (req.method === 'GET' && (route === '/api/review-status' || route === '/api/review-current')) {
    const requestedId = route === '/api/review-current' ? undefined : requestUrl.searchParams.get('reviewId');
    const review = reviews.get(requestedId);
    if (!review || !activeReview || activeReview.id !== review.id) return sendJson(res, 404, { status: 'REVIEW_CLOSED', error: 'Review is unknown or has ended.' });
    try { return sendJson(res, 200, await readReviewStatus(activeReview)); }
    catch { return sendJson(res, 500, { status: 'REVIEW_CLOSED', error: 'Unable to read review state.' }); }
  }

  if (req.method === 'POST' && route === '/api/finish-review') {
    if (req.headers.origin !== 'http://' + HOST + ':' + PORT) return sendJson(res, 403, { error: 'Invalid request origin' });
    let payload;
    try { payload = await readJsonBody(req); }
    catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
    if (!activeReview || typeof payload.reviewId !== 'string') return sendJson(res, 404, { error: 'Review is unknown or has ended.' });
    const result = reviews.finish(payload.reviewId, activeReview.runId);
    if (!result.ok) return sendJson(res, result.reason === 'expired' ? 410 : 404, { error: result.reason === 'expired' ? 'Review expired — no bet submitted.' : 'Review is unknown, mismatched, or not ready.' });
    if (!result.repeated) {
      try {
        await writeFile(activeReview.reviewDecisionPath, JSON.stringify({ id: activeReview.id, runId: activeReview.runId }), 'utf8');
      } catch {
        reviews.complete(activeReview.id, activeReview.runId, 'ready');
        return sendJson(res, 500, { error: 'Review could not be released. The browser session remains open.' });
      }
    }
    return sendJson(res, 200, { success: true, repeated: result.repeated, message: 'Review finished — no bet submitted.' });
  }

  if (req.method !== 'POST' || !['/api/run', '/api/confirm'].includes(route)) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  // Restrict requests to the local chat interface.
  if (req.headers.origin !== 'http://' + HOST + ':' + PORT) {
    return sendJson(res, 403, { error: 'Invalid request origin' });
  }

  if (busyRejects(route, busy)) {
    return sendJson(res, 409, { error: 'Another test is running' });
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return error.message === 'TOO_LARGE'
      ? sendJson(res, 413, { error: 'Request too large' })
      : sendJson(res, 400, { error: 'Invalid JSON' });
  }

  busy = true;
  try {
    // ---- Step 2: user confirmed a wager plan ----
    if (route === '/api/confirm') {
      const pending = pendingPlans.get(payload.planId);
      pendingPlans.delete(payload.planId);

      if (!pending || pending.expires < Date.now()) {
        return sendJson(res, 400, { code: 'PLAN_EXPIRED', error: 'Plan expired or unknown. Send the request again.' });
      }

      const isSports = pending.plan.actions.some((action) => action.type === 'prepare_sports_bet');
      const sportsAction = isSports && pending.plan.actions.find((action) => action.type === 'prepare_sports_bet');
      if (sportsAction && sportsAction.submit === true) {
        return sendJson(res, 200, {
          status: 'BLOCKED', success: false,
          reason: 'This flow prepares the betslip for your review. If you choose to proceed, you must click Submit yourself in the sportsbook.',
          actions: []
        });
      }
      if (sportsAction && sportsAction.submit === false) {
        const review = await startReviewRun(pending.plan, pending.usage);
        return sendJson(res, 200, { status: 'REVIEW_STARTING', reviewId: review.id });
      }
      const testFile = isSports ? SPORTS_TEST : SLOT_TEST;
      const env = isSports ? { ALLOW_SPORTS_PREPARE: '1' } : { ALLOW_SPINS: '1' };
      const { code, report } = await executePlanFile(pending.plan, testFile, env);
      return reportResponse(res, code, report, pending.usage);
    }

    // ---- Step 1: plan the instruction ----
    const instruction = payload.instruction;
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 500) {
      return sendJson(res, 400, { error: 'Invalid instruction' });
    }

    if (!/^(inspect|verify|check|report|navigate|open|play|spin|prepare|place|bet|choose|select|log\s?in)\b/i.test(instruction.trim())) {
      return sendJson(res, 400, { error: 'Only approved testing requests are supported' });
    }

    const result = await planInstruction(instruction);

    if (result.status === 'BLOCKED') {
      const slotRequest = /\b(slot|slots|spin|spins|casino|games in olympus)\b/i.test(instruction);
      const supported = 'Known slot route: Games in Olympus. Stake controls are unverified; only the legacy remembered R0.20 path (1–100 spins, ante off) can run.';
      const sportsRequest = /\b(soccer|football|premier league|accumulator|sports bet|bet on)\b/i.test(instruction);
      const sportsReason = sportsRequest
        ? /account identity/i.test(result.reason)
          ? 'The request could not be planned safely. The test account comes from the terminal-configured login credentials; no client ID or funding-mode check is required. No browser run was started.'
          : /no browser run was started\.?$/i.test(result.reason)
            ? result.reason
            : `${result.reason} No browser run was started.`
        : result.reason;
      return sendJson(res, 200, {
        status: 'BLOCKED', success: false,
        reason: slotRequest ? result.reason + ' ' + supported : sportsRequest
          ? sportsReason
          : result.reason,
        actions: []
      });
    }
    if (result.status !== 'PLANNED') {
      throw new Error(result.code || 'PLANNING_FAILED');
    }

    const sportsAction = result.plan.actions.find((action) => action.type === 'prepare_sports_bet');
    if (sportsAction) {
      const stake = extractExplicitStakeCents(instruction);
      if (!stake.ok) return sendJson(res, 200, {
        status: 'BLOCKED', success: false,
        reason: stake.reason === 'SPORTS_STAKE_OVER_R50'
          ? 'The requested total stake exceeds R50. No browser run was started.'
          : stake.reason === 'SPORTS_STAKE_BELOW_MINIMUM'
            ? 'The minimum total stake is R1.00. No browser run was started.'
            : 'Provide exactly one valid total stake in ZAR from R1.00 through R50.00, such as R10.01. No browser run was started.',
        actions: []
      });
      if (stake.stakeCents !== sportsAction.stakeCents) return sendJson(res, 200, {
        status: 'BLOCKED', success: false,
        reason: 'The planned stake did not match the exact requested amount. No browser run was started.', actions: []
      });
    }

    // Anything that needs the account waits for an explicit confirmation.
    if (result.auth) {
      const planId = randomUUID();
      pendingPlans.set(planId, pendingPlan(result.plan, result.usage, Date.now() + CONFIRM_WINDOW_MS));
      return sendJson(res, 200, withUsage({
        status: 'CONFIRM',
        planId,
        summary: describePlan(result.plan),
        actions: result.plan.actions
      }, result.usage));
    }

    const { code, report } = await executePlanFile(result.plan, READ_ONLY_TEST, {});
    return reportResponse(res, code, report, result.usage);
  } catch (error) {
    return errorResponse(res, error);
  } finally {
    busy = Boolean(activeReview && !activeReview.terminal);
  }
});

server.listen(PORT, HOST, () => {
  console.log('AI Testing Agent: http://' + HOST + ':' + PORT);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (activeReview && !activeReview.terminal) {
      writeFile(activeReview.reviewStopPath, signal).catch(() => undefined);
    }
    server.close();
  });
}
