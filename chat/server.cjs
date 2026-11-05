
const http = require('node:http');
const { spawn } = require('node:child_process');
const { readFile, writeFile, mkdtemp, rm, mkdir, appendFile, readdir } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { withUsage, pendingPlan } = require('./usage.cjs');
const { describeSlotPlan } = require('./slot-summary.cjs');
const { createReviewState, preparationReviewPayload, busyRejects } = require('./review-state.cjs');
const { createChatSessions, clearSportsConfirmations, takeConfirmation, cancelConfirmation,
  sportsRequestFingerprint, sportsPlanMatchesRequest, rememberMessage, replaceMessageResult } = require('./session-state.cjs');
const { CONFIRM_WINDOW_MS } = require('./timeouts.cjs');
const { createSubmissionState, fingerprint } = require('./submission-state.cjs');
// Covers runner revalidation, one control click, bounded result observation,
// and file transport. Authorization expiry is enforced before dispatch only.
const SUBMISSION_RESULT_TIMEOUT_MS = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function submitThroughRunner({ review, betslip, authorization, sessionId, revision, expiresAt, reviewedDetails }) {
  if (!review.reviewDecisionPath || !review.submissionResultPath || !authorization) {
    return { outcome: 'blocked', reason: 'The browser runner is unavailable for this review.' };
  }
  const command = { id: review.id, runId: review.runId, decision: 'submit', authorization,
    sessionId, revision, expiresAt, fingerprint: fingerprint(reviewedDetails), reviewedDetails };
  try { await writeFile(review.reviewDecisionPath, JSON.stringify(command), 'utf8'); }
  catch { return { outcome: 'blocked', reason: 'The browser runner is unavailable for this review.' }; }
  if (expiresAt <= Date.now()) return { outcome: 'blocked', reason: 'Submission authorization expired before dispatch.' };
  const deadline = Date.now() + SUBMISSION_RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(review.submissionResultPath, 'utf8'));
      if (result.id === review.id && result.runId === review.runId && result.authorization === authorization
        && ['accepted', 'rejected', 'unknown', 'changed', 'blocked'].includes(result.outcome)) {
        if (result.outcome === 'accepted' && !(typeof result.betReference === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(result.betReference))) continue;
        return { outcome: result.outcome,
          ...(typeof result.reason === 'string' ? { reason: result.reason.slice(0, 240) } : {}),
          ...(typeof result.betReference === 'string' ? { betReference: result.betReference } : {}) };
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) return { outcome: 'unknown' }; }
    await sleep(100);
  }
  return { outcome: 'unknown' };
}

const PORT = 3001;
const HOST = '127.0.0.1';
const PROJECT = path.resolve(__dirname, '..');

const reviews = createReviewState();
let activeReview = null;
const configuredReviewTimeout = Number(process.env.SPORTS_REVIEW_TIMEOUT_MS ?? 300_000);
const REVIEW_TIMEOUT_MS = Number.isFinite(configuredReviewTimeout)
  ? Math.min(600_000, Math.max(30_000, Math.floor(configuredReviewTimeout)))
  : 300_000;

// Drafts and confirmation plans belong to the opaque browser chat session.

const READ_ONLY_TEST = 'tests/agent-ai-demo.e2e.ts';
const SLOT_TEST = 'tests/agent-slot.e2e.ts';
const SPORTS_TEST = 'tests/agent-sports.e2e.ts';
const EXECUTION_MODES = ['SPORTS', 'SLOTS_INSPECT', 'SLOTS_PLAY'];
const slotsPlayEnabled = () => process.env.ENABLE_SLOTS_PLAY === '1';

// Plan mode comes from the validated action discriminator fields, never from
// the free-text request. A mixed slot/sports plan is invalid in either mode.
function planModeMismatch(mode, plan) {
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const hasSlotAction = actions.some((action) => action?.type === 'open_game' || action?.type === 'play_slot');
  const hasSportsAction = actions.some((action) => action?.type === 'prepare_sports_bet');
  return (hasSlotAction && hasSportsAction)
    || (hasSlotAction && mode !== 'SLOTS_PLAY')
    || (hasSportsAction && mode !== 'SPORTS');
}

let inspectionBusy = false;
async function runMidsceneInspection(instruction) {
  const startedAt = Date.now();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hwb-midscene-'));
  const screenshotPath = path.join(directory, 'inspection.png');
  try {
    const tsxCli = path.join(PROJECT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const { code, stdout, stderr } = await runNode([tsxCli, 'scripts/midscene/inspect-olympus.ts'],
      { MIDSCENE_SCREENSHOT_PATH: screenshotPath, MIDSCENE_INSTRUCTION: instruction }, 180000);
    const line = stdout.split(/\r?\n/).find((item) => item.startsWith('MIDSCENE_RESULT:'));
    let result = line ? JSON.parse(line.slice('MIDSCENE_RESULT:'.length)) : null;
    if (!result) {
      const unavailable = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|MODEL_UNAVAILABLE|fetch failed/i.test(stderr + stdout);
      result = { status: unavailable ? 'MODEL_UNAVAILABLE' : 'MIDSCENE_INSPECTION_FAILED', success: false,
        error: unavailable ? 'MODEL_UNAVAILABLE' : 'MIDSCENE_INSPECTION_FAILED', logs: (stderr + stdout).slice(-4000) };
    }
    if (code !== 0 && result.success) result = { ...result, success: false, status: 'MIDSCENE_INSPECTION_FAILED' };
    return { ...result, mode: 'SLOTS_INSPECT', durationMs: Date.now() - startedAt,
      logs: (result.logs || (stdout + stderr)).slice(-4000),
      screenshot: result.screenshot || (await readFile(screenshotPath).then((b) => b.toString('base64')).catch(() => null)) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function redactEvidenceText(text) {
  const secretNames = [
    'MIDSCENE_MODEL_API_KEY', 'LLM_API_KEY',
    'E2E_USER_HB_TEST_USERNAME', 'E2E_USER_HB_TEST_PASSWORD',
  ];
  return secretNames.reduce((safe, name) => {
    const secret = process.env[name];
    return secret ? safe.replaceAll(secret, '[REDACTED]') : safe;
  }, text);
}

async function createSlotRunEvidence(plan) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const timestamp = startedAt.replace(/[:.]/g, '-');
  const directory = path.join(PROJECT, 'reports', 'slots', `${timestamp}-${runId}`);
  await mkdir(directory, { recursive: true });
  const evidence = {
    runId,
    startedAt,
    directory,
    planPath: path.join(directory, 'plan.json'),
    reportPath: path.join(directory, 'report.json'),
    logPath: path.join(directory, 'run.log'),
    plan,
  };
  await writeFile(evidence.planPath, redactEvidenceText(JSON.stringify(plan, null, 2)), 'utf8');
  await writeFile(evidence.logPath,
    `[SLOT RUN] runId=${runId} startedAt=${startedAt}\n=== PLAN ===\n${redactEvidenceText(JSON.stringify(plan, null, 2))}\n`,
    'utf8');
  return evidence;
}

async function appendSlotEvidenceLog(evidence, section, stdout = '', stderr = '') {
  const output = `\n=== ${section} stdout ===\n${stdout}\n=== ${section} stderr ===\n${stderr}\n`;
  await appendFile(evidence.logPath, redactEvidenceText(output), 'utf8');
}

async function finalizeSlotEvidence(evidence, report, code, runnerError) {
  const success = code === 0 && report.success === true;
  const logText = await readFile(evidence.logPath, 'utf8').catch(() => '');
  const logLines = logText.split(/\r?\n/);
  const logEvidence = {
    balanceBeforeLine: logLines.find((line) => line.startsWith('Balance before (header):')) ?? null,
    gameStateLine: logLines.find((line) => line.startsWith('GAME STATE:')) ?? null,
    spinLines: logLines.filter((line) => /doSpin response|SPIN \d+ SETTLED|SLOT RUN STOP/.test(line)),
    balanceSettlementLine: logLines.find((line) => line.startsWith('Balance settlement:')) ?? null,
    overlayEvents: logLines.filter((line) => /SPIN \d+ OVERLAY|OVERLAY DISMISS|SPIN \d+ DISMISS/.test(line)),
  };
  const screenshots = (await readdir(evidence.directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => path.join(evidence.directory, entry.name));
  const finalReport = {
    ...report,
    status: success ? 'PASS' : report.status === 'MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE' : 'FAIL',
    success,
    runId: evidence.runId,
    startedAt: evidence.startedAt,
    completedAt: new Date().toISOString(),
    plan: evidence.plan,
    ...(evidence.readiness ? { readiness: evidence.readiness } : {}),
    logEvidence,
    ...(runnerError ? { runnerError: redactEvidenceText(runnerError) } : {}),
    evidence: {
      directory: evidence.directory,
      planPath: evidence.planPath,
      reportPath: evidence.reportPath,
      logPath: evidence.logPath,
      screenshots,
    },
  };
  const safeReport = JSON.parse(redactEvidenceText(JSON.stringify(finalReport)));
  await writeFile(evidence.reportPath, JSON.stringify(safeReport, null, 2), 'utf8');
  console.log(`[SLOT_RUN_EVIDENCE] status=${safeReport.status} report=${evidence.reportPath} log=${evidence.logPath}`);
  return safeReport;
}

async function runSlotsModelReadiness() {
  const tsxCli = path.join(PROJECT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  let stdout = '';
  let stderr = '';
  try {
    const result = await runNode([tsxCli, 'scripts/midscene/check-readiness.ts'], {}, 150000);
    stdout = result.stdout;
    stderr = result.stderr;
    const jsonLine = stdout.split(/\r?\n/).find((line) => line.trim().startsWith('{'));
    const parsed = jsonLine ? JSON.parse(jsonLine) : null;
    if (result.code === 0 && parsed?.ready === true) return { ready: true, result: parsed, stdout, stderr };
    return {
      ready: false,
      result: parsed ?? { code: 'MODEL_UNAVAILABLE', reason: 'Readiness process returned no JSON result.' },
      stdout,
      stderr,
    };
  } catch (error) {
    return {
      ready: false,
      result: { code: 'MODEL_UNAVAILABLE', reason: error instanceof Error ? error.message : String(error) },
      stdout,
      stderr,
    };
  }
}

function renderHtml() {
return `<!DOCTYPE html>
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
#conversation-status { color: #f7c948; min-height: 1.5em; }
.message[data-state="clarification"] { border-left-color: #6dd6bc; }
.message[data-state="awaiting_confirmation"] { border-left-color: #f7c948; }
.message[data-state="manual_review"] { border-left-color: #6dd6bc; }
</style>
</head>
<body>
<main>
<h1>HollywoodBets AI Testing Agent</h1>
<p>Review every prepared sports bet carefully. Submission is available only through the explicit chat control.</p>
<p id="conversation-status" role="status" aria-live="polite">Ready for your request</p>
<div id="messages" role="log" aria-label="Conversation" aria-live="polite"></div>
<form id="form">
<select id="mode" aria-label="Execution mode"><option value="SLOTS_INSPECT">Slots inspection</option><option value="SPORTS">Sportsbook</option><option value="SLOTS_PLAY">Slots play${slotsPlayEnabled() ? '' : ' (disabled)'}</option></select>
<input id="instruction"
 maxlength="500"
 placeholder="Describe a request or answer a question..."
 required>
<button id="send">Send</button>
</form>
</main>
<script src="/client.js" defer></script>
</body>
</html>`;
}

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
async function planInstruction(instruction, pendingSports, conversationState, messageId) {
  const tsxCli = path.join(PROJECT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  console.log('[Planner] Starting plan generation');
  const { stdout, stderr } = await runNode(
    [tsxCli, 'scripts/plan.ts'],
    { AGENT_INSTRUCTION: instruction,
      AGENT_PENDING_SPORTS_REQUEST: pendingSports ? JSON.stringify(pendingSports) : '',
      AGENT_SPORTS_CONVERSATION_STATE: conversationState ? JSON.stringify(conversationState) : '',
      AGENT_CONVERSATION_MESSAGE_ID: messageId },
    90000
  );
  console.log('[Planner] Plan generation process finished');
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PLAN_RESULT:'));
  if (!line) {
    console.error('Planner stderr:', stderr);
    throw new Error('PLANNING_FAILED');
  }
  const result = JSON.parse(line.slice('PLAN_RESULT:'.length));
  if (['MODEL_TIMEOUT', 'MODEL_UNAVAILABLE', 'INVALID_INTERPRETATION'].includes(result.code)) {
    // Log only the classification and draft presence, not user messages or model output.
    console.error('[Planner]', result.code, result.pendingSports ? '(draft preserved)' : '(no saved draft)');
  }
  return result;
}

function describePlan(plan) {
  const sportsBet = plan.actions.find((a) => a.type === 'prepare_sports_bet');
  if (sportsBet) {
    const picks = sportsBet.selections.map((selection) => selection.team
      + (selection.opponent ? ' vs ' + selection.opponent : '')).join('; ');
    return 'Selections: ' + picks + '\n'
      + sportsBet.selections.map((selection, index) => 'Selection ' + (index + 1) + ': Team: ' + selection.team + '; Opponent: ' + selection.opponent).join('\n')
      + '\nCompetition: ' + (sportsBet.competition === 'premier-league' ? 'Premier League' : sportsBet.competition)
      + '\nMarket: ' + (sportsBet.market === 'match-winner' ? 'Match winner' : sportsBet.market)
      + '\nBet type: ' + (sportsBet.selections.length > 1 ? 'Accumulator' : 'Single')
      + '\nTotal stake: R' + (sportsBet.stakeCents / 100).toFixed(2)
      + '\nConfirm and run authorizes preparation only. The agent cannot submit from messages or model output. After review, use the separate explicit Submit bet button in chat.';
  }
  const spin = plan.actions.find((a) => a.type === 'play_slot');
  if (!spin) return 'Open a casino game on the test account.';
  return describeSlotPlan(spin);
}

// Writes the plan to a temp file, runs one test file, returns the report.
async function executePlanFile(plan, testFile, extraEnv, slotEvidence) {
  if (testFile === SLOT_TEST && !slotEvidence) slotEvidence = await createSlotRunEvidence(plan);
  const directory = slotEvidence ? null : await mkdtemp(path.join(os.tmpdir(), 'hwb-agent-'));
  try {
    const planPath = slotEvidence?.planPath || extraEnv.AGENT_PLAN_PATH || path.join(directory, 'plan.json');
    const reportPath = slotEvidence?.reportPath || extraEnv.AGENT_REPORT_PATH || path.join(directory, 'report.json');
    const logPath = slotEvidence?.logPath;
    if (!slotEvidence) await writeFile(planPath, JSON.stringify(plan), 'utf8');

    let code;
    let runnerError;
    try {
      code = await runTest(testFile, {
        AGENT_PLAN_PATH: planPath,
        AGENT_REPORT_PATH: reportPath,
        ...(slotEvidence ? { AGENT_RUN_ID: slotEvidence.runId, AGENT_EVIDENCE_DIR: slotEvidence.directory } : {}),
        ...extraEnv
      }, testFile === SLOT_TEST ? 600000 : extraEnv.AGENT_REVIEW_ID ? 950000 : testFile === SPORTS_TEST ? 300000 : 120000, logPath);
    } catch (error) {
      // A failed run can still have written a useful report.
      code = -1;
      runnerError = error instanceof Error ? error.message : String(error);
      if (!/exited with code/.test(runnerError) && !slotEvidence) throw error;
      if (slotEvidence) await appendSlotEvidenceLog(slotEvidence, 'E2E runner failure', '', runnerError);
    }

    let report;
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch {
      report = { status: 'FAIL', success: false, reason: runnerError || 'NO_REPORT', actions: [] };
    }
    if (slotEvidence) report = await finalizeSlotEvidence(slotEvidence, report, code, runnerError);
    return { code, report };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function startReviewRun(plan, usage, sessionId, revision = 0) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hwb-review-'));
  const planPath = path.join(directory, 'plan.json');
  const reportPath = path.join(directory, 'report.json');
  const reviewReadyPath = path.join(directory, 'review-ready.json');
  const reviewDecisionPath = path.join(directory, 'review-decision.json');
  const reviewStatePath = path.join(directory, 'review-state.json');
  const submissionResultPath = path.join(directory, 'submission-result.json');
  const reviewStopPath = path.join(directory, 'review-stop');
  const runId = randomUUID();
  // Bind the revision before cloning the active review or launching the runner.
  const review = { ...reviews.begin({ runId, timeoutMs: REVIEW_TIMEOUT_MS }), revision };
  await writeFile(planPath, JSON.stringify(plan), 'utf8');
  activeReview = { ...review, directory, reportPath, reviewReadyPath, reviewDecisionPath, reviewStatePath, reviewStopPath, submissionResultPath, usage, plan, sessionId };
  executePlanFile(plan, SPORTS_TEST, {
    ALLOW_SPORTS_PREPARE: '1',
    AGENT_REVIEW_ID: review.id,
    AGENT_REVIEW_RUN_ID: runId,
    AGENT_CHAT_SESSION_ID: sessionId,
    AGENT_REVIEW_REVISION: String(review.revision ?? 0),
    AGENT_REVIEW_TIMEOUT_MS: String(REVIEW_TIMEOUT_MS),
    AGENT_REVIEW_READY_PATH: reviewReadyPath,
    AGENT_REVIEW_DECISION_PATH: reviewDecisionPath,
    AGENT_REVIEW_STATE_PATH: reviewStatePath,
    AGENT_SUBMISSION_RESULT_PATH: submissionResultPath,
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
  }).catch((error) => {
    reviews.complete(review.id, runId, 'failed');
    activeReview.terminal = { error: error instanceof Error ? error.message : 'REVIEW_FAILED' };
  }).finally(async () => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  });
  return activeReview;
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

function runTest(testFile, extraEnv, timeoutMs, logPath) {
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
      const next = stdout + chunk.toString();
      stdout = logPath ? next : next.slice(-12000);
    });

    child.stderr.on('data', (chunk) => {
      const next = stderr + chunk.toString();
      stderr = logPath ? next : next.slice(-12000);
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

    child.on('close', async (code, signal) => {
      clearTimeout(timeout);

      if (logPath) {
        await appendFile(logPath, redactEvidenceText(`\n=== E2E stdout ===\n${stdout}\n=== E2E stderr ===\n${stderr}\n`), 'utf8');
      }

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
        console.error('E2E stdout:', redactEvidenceText(stdout));
        console.error('E2E stderr:', redactEvidenceText(stderr));

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

function reportResponse(res, code, report, usage, extra = {}, respond = (data) => sendJson(res, 200, data)) {
  return respond(withUsage({
    status: report.status ?? (code === 0 && report.success === true ? 'PASS' : 'FAIL'),
    success: code === 0 && report.success === true,
    reason: report.reason,
    durationMs: report.durationMs,
    actions: report.actions ?? [],
    ...(report.evidence ? { evidence: report.evidence } : {}),
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

function createChatServer({ planMessage = planInstruction, prepareReview = startReviewRun, runPlan = executePlanFile,
  inspectSlots = runMidsceneInspection,
  checkSlotsReadiness = runSlotsModelReadiness,
  createSlotsEvidence = createSlotRunEvidence,
  getActiveReview = () => activeReview, reviewStatus = readReviewStatus,
  reviewIsReady = (review) => reviews.get(review.id)?.state === 'ready',
  reviewRunnerAvailable = (review) => Boolean(review.reviewDecisionPath && review.submissionResultPath && !review.terminal),
  getSubmissionEnabled = () => process.env.ENABLE_SPORTS_SUBMISSION === '1',
  // A real provider evidence adapter must be deliberately installed after its
  // receipt/rejection markup and correlation rules have been verified.
  verifySubmissionEvidence = () => false,
  submitReview = submitThroughRunner } = {}) {
const chatSessions = createChatSessions();
const submissions = createSubmissionState();
let busy = false;
const isBusy = () => busy || Boolean(getActiveReview() && !getActiveReview().terminal);
return http.createServer(async (req, res) => {
  const { session, created, cookie } = chatSessions.resolve(req.headers.cookie || '');
  if (created) res.setHeader('Set-Cookie', cookie);
  const startedAt = Date.now();
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1:3001');
  let confirmationInvalidated = false;
  const conversationView = () => {
    const confirmations = [...session.confirmations].filter(([, item]) => item.expires > Date.now()
      && (item.sportsRevision === undefined || (item.sportsRevision === session.conversationState?.revision
        && sportsPlanMatchesRequest(item.plan, session.conversationState))))
      .map(([planId, item]) => ({ planId, kind: item.sportsRevision === undefined ? 'slot' : 'sports',
        revision: item.sportsRevision, expiresAt: item.expires }));
    const review = getActiveReview();
    return { phase: review && !review.terminal && review.sessionId === session.id ? review.phase || 'running'
      : confirmations.length ? 'awaiting_confirmation' : session.pendingSports ? 'clarification' : 'idle',
      revision: session.conversationState?.revision ?? null, confirmations, confirmationInvalidated };
  };
  const reply = (data) => {
    rememberMessage(session, { id: randomUUID(), role: 'agent', result: data });
    return sendJson(res, 200, { ...data, conversation: conversationView() });
  };
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
        "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'"
    });
    return res.end(renderHtml());
  }

  const route = requestUrl.pathname;
  if (req.method === 'GET' && route === '/client.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(await readFile(path.join(__dirname, 'client.js'), 'utf8'));
  }
  if (req.method === 'GET' && route === '/api/conversation-state') {
    return sendJson(res, 200, { conversation: conversationView(), messages: session.messages });
  }
  if (req.method === 'GET' && (route === '/api/review-status' || route === '/api/review-current')) {
    const requestedId = route === '/api/review-current' ? undefined : requestUrl.searchParams.get('reviewId');
    const review = getActiveReview();
    if (!review || (requestedId && review.id !== requestedId) || review.sessionId !== session.id) return sendJson(res, 404, { status: 'REVIEW_CLOSED', error: 'Review is unknown or has ended.' });
    const pendingAttempt = submissions.get();
    if (pendingAttempt?.reviewId === review.id && pendingAttempt.state === 'unknown' && review.submissionResultPath) {
      try {
        const late = JSON.parse(await readFile(review.submissionResultPath, 'utf8'));
        if (late.id === review.id && late.runId === review.runId && late.authorization === pendingAttempt.authorization
          && ['accepted', 'rejected'].includes(late.outcome) && verifySubmissionEvidence(late, review)
          && (late.outcome !== 'accepted' || (typeof late.betReference === 'string'
            && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(late.betReference)))) {
          const reconciled = submissions.reconcile({ reviewId: review.id, runId: review.runId,
            authorization: pendingAttempt.authorization, outcome: late.outcome, betReference: late.betReference,
            reason: typeof late.reason === 'string' ? late.reason : undefined });
          if (reconciled) {
            const response = late.outcome === 'accepted'
              ? { status: 'BET_ACCEPTED', success: true, betReference: late.betReference,
                stakeCents: review.submissionDetails?.stakeCents,
                selections: (review.submissionDetails?.selections || []).map(({ fixture, selection }) => ({ fixture, selection })) }
              : { status: 'BET_REJECTED', success: false, reason: reconciled.result.reason || 'The sportsbook explicitly rejected the bet.' };
            const messageId = 'submission-' + review.id;
            if (!replaceMessageResult(session, messageId, response)) rememberMessage(session, { id: messageId, role: 'agent', result: response });
            return sendJson(res, 200, { ...response, reviewId: review.id, conversation: conversationView() });
          }
        }
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        return sendJson(res, 503, { status: 'BET_OUTCOME_UNKNOWN', reason: 'Submission attempted—acceptance unverified. Check My Bets before trying again.' });
      } }
    }
    try {
      const result = { ...withUsage(await reviewStatus(review), review.usage), reviewId: review.id,
        revision: review.revision ?? 0, competition: review.plan?.actions?.[0]?.competition ?? null,
        submissionEnabled: getSubmissionEnabled() && reviewIsReady(review) && reviewRunnerAvailable(review) };
      result.submissionBlockReason = !reviewRunnerAvailable(review) ? 'The browser runner for this review is unavailable.'
        : !getSubmissionEnabled() ? 'Submission transport is disabled. Configure ENABLE_SPORTS_SUBMISSION=1 for the isolated test account.'
          : !reviewIsReady(review) ? 'This review is not in a valid ready state.' : null;
      if (result.status === 'REVIEW_READY') {
        review.phase = 'manual_review';
        const betslip = result.actions?.[0]?.betslip;
        const existing = submissions.get();
        if (betslip && (!existing || existing.reviewId !== review.id)) {
          const authorization = submissions.begin({ reviewId: review.id, runId: review.runId,
            sessionId: review.sessionId, revision: review.revision ?? 0, betslip,
            reviewedDetails: { competition: result.competition, betslip },
            expiresAt: result.expiresAt ?? review.expiresAt });
          if (authorization) result.idempotencyKey = authorization.idempotencyKey;
        } else if (existing?.reviewId === review.id) result.idempotencyKey = existing.idempotencyKey;
      }
      if (result.status !== 'REVIEW_STARTING') rememberMessage(session, {
        id: 'review-' + review.id + '-' + result.status, role: 'agent', result,
      });
      return sendJson(res, 200, { ...result, conversation: conversationView() });
    }
    catch { return sendJson(res, 500, { status: 'REVIEW_CLOSED', error: 'Unable to read review state.' }); }
  }

  if (req.method === 'POST' && route === '/api/finish-review') {
    if (req.headers.origin !== 'http://' + HOST + ':' + PORT) return sendJson(res, 403, { error: 'Invalid request origin' });
    let payload;
    try { payload = await readJsonBody(req); }
    catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
    if (!activeReview || activeReview.sessionId !== session.id || typeof payload.reviewId !== 'string') return sendJson(res, 404, { error: 'Review is unknown or has ended.' });
    if (activeReview.submissionInProgress) return sendJson(res, 409, { error: 'Submission is being processed; review cannot be finished yet.' });
    const result = reviews.finish(payload.reviewId, activeReview.runId);
    if (!result.ok) return sendJson(res, result.reason === 'expired' ? 410 : 404, { error: result.reason === 'expired' ? 'Review expired — no bet submitted.' : 'Review is unknown, mismatched, or not ready.' });
    if (!result.repeated) {
      try {
        await writeFile(activeReview.reviewDecisionPath, JSON.stringify({ id: activeReview.id, runId: activeReview.runId, decision: 'finish' }), 'utf8');
      } catch {
        reviews.complete(activeReview.id, activeReview.runId, 'ready');
        return sendJson(res, 500, { error: 'Review could not be released. The browser session remains open.' });
      }
    }
    const ended = withUsage({ status: 'REVIEW_CLOSED', reviewId: activeReview.id,
      success: true, repeated: result.repeated, message: 'Review finished — no bet submitted.',
      reason: 'Review finished. The agent did not submit the bet.' }, activeReview.usage);
    rememberMessage(session, { id: 'review-' + activeReview.id + '-finished', role: 'agent', result: ended });
    return sendJson(res, 200, { ...ended, conversation: conversationView() });
  }

  if (req.method === 'POST' && route === '/api/submit-review') {
    if (req.headers.origin !== 'http://' + HOST + ':' + PORT) return sendJson(res, 403, { error: 'Invalid request origin' });
    let payload;
    try { payload = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON' }); }
    const review = getActiveReview();
    if (!review || review.sessionId !== session.id || payload.reviewId !== review.id
      || !Number.isSafeInteger(payload.revision) || !/^[a-zA-Z0-9-]{1,100}$/.test(payload.idempotencyKey || '')) {
      return sendJson(res, 404, { error: 'Review is unknown, mismatched, or not ready.' });
    }
    if (!reviewRunnerAvailable(review)) return sendJson(res, 503, { status: 'SUBMISSION_BLOCKED', success: false,
      reason: 'The browser runner for this review is unavailable.' });
    if (!getSubmissionEnabled()) return sendJson(res, 503, { status: 'SUBMISSION_BLOCKED', success: false,
      reason: 'Submission transport is disabled. Configure ENABLE_SPORTS_SUBMISSION=1 for the isolated test account.' });
    let snapshot;
    try { snapshot = await reviewStatus(review); } catch { return sendJson(res, 503, { status: 'SUBMISSION_UNKNOWN', error: 'Review details could not be verified. Check the sportsbook before trying again.' }); }
    if (snapshot.status !== 'REVIEW_READY' || !reviewIsReady(review)
      || payload.revision !== review.revision) return sendJson(res, 409, { error: 'Review is stale, closed, or expired.' });
    const expiresAt = snapshot.expiresAt ?? review.expiresAt;
    if (expiresAt <= Date.now()) return sendJson(res, 410, { error: 'Review expired. No new attempt was started.' });
    if (!preparationReviewPayload({ status: 'BETSLIP_READY', success: true, actions: snapshot.actions }, review.id, expiresAt)) {
      return sendJson(res, 409, { status: 'REVIEW_UNVERIFIED', error: 'The reviewed slip contains unreadable or invalid material fields. No submission was started.' });
    }
    const betslip = snapshot.actions?.[0]?.betslip;
    if (betslip.betType === 'accumulator' && (betslip.oddsBasis !== 'sportsbook-displayed'
      || !Number.isFinite(betslip.baseOdds) || betslip.bonusStatus !== 'verified'
      || !Number.isFinite(betslip.observedBonusPercent) || !Number.isFinite(betslip.finalOdds)
      || betslip.displayedPayoutBasis !== 'stake-inclusive')) {
      return sendJson(res, 409, { status: 'REVIEW_UNVERIFIED', error: 'Accumulator base odds, applied bonus, final odds and payout basis are not all sportsbook-verified. No submission was started.' });
    }
    const reviewedDetails = { competition: snapshot.competition ?? review.plan?.actions?.[0]?.competition ?? null, betslip };
    const prior = submissions.get();
    if (prior?.reviewId === review.id && prior.state === 'ready'
      && prior.fingerprint !== fingerprint(reviewedDetails)) {
      const refreshed = submissions.refresh({ reviewId: review.id, runId: review.runId, sessionId: session.id,
        revision: review.revision, betslip, reviewedDetails, expiresAt: snapshot.expiresAt ?? review.expiresAt });
      if (refreshed) return sendJson(res, 200, { ...snapshot, status: 'REVIEW_READY', reviewId: review.id,
        revision: review.revision, competition: review.plan?.actions?.[0]?.competition ?? null,
        idempotencyKey: refreshed.idempotencyKey, refreshed: true });
    }
    const claim = submissions.claim({ reviewId: review.id, runId: review.runId, sessionId: session.id,
      revision: review.revision, fingerprint: fingerprint(reviewedDetails), idempotencyKey: payload.idempotencyKey });
    if (!claim.ok) return sendJson(res, claim.reason === 'expired' ? 410 : 409, { error: claim.reason === 'expired' ? 'Review expired.' : 'Submission was already attempted or authorization is invalid.' });
    review.submissionInProgress = true;
    review.submissionDetails = betslip;
    if (submissions.transition('submitting')) {
      // The production browser boundary remains disabled until verified final controls and
      // an acceptance receipt are established. Tests inject a fully mocked boundary.
      let result;
      try { result = await submitReview({ review, betslip, authorization: claim.authorization,
        idempotencyKey: claim.idempotencyKey, requestedIdempotencyKey: payload.idempotencyKey,
        sessionId: review.sessionId, revision: review.revision, expiresAt, reviewedDetails }); }
      catch { result = { outcome: 'unknown' }; }
      if (['accepted', 'rejected'].includes(result?.outcome) && !verifySubmissionEvidence(result, review)) {
        result = { outcome: 'unknown', reason: 'Submission attempted—acceptance unverified. Check My Bets before trying again.' };
      }
      if (result?.outcome === 'accepted' && !(typeof result.betReference === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(result.betReference))) {
        result = { outcome: 'unknown', reason: 'Submission attempted—acceptance unverified. Check My Bets before trying again.' };
      }
      const state = ['blocked', 'changed'].includes(result?.outcome) ? 'closed'
        : ['accepted', 'rejected', 'unknown', 'closed'].includes(result?.outcome) ? result.outcome : 'unknown';
      submissions.transition(state);
      review.submissionInProgress = false;
      if (result?.outcome !== 'blocked' && review.reviewDecisionPath) {
        await writeFile(review.reviewDecisionPath, JSON.stringify({ id: review.id, runId: review.runId,
          decision: 'submission_complete', authorization: claim.authorization }), 'utf8').catch(() => undefined);
      }
      const response = state === 'accepted' ? { status: 'BET_ACCEPTED', success: true, betReference: result.betReference,
        stakeCents: betslip.stakeCents,
        selections: betslip.selections.map(({ fixture, selection }) => ({ fixture, selection })) }
        : state === 'rejected' ? { status: 'BET_REJECTED', success: false, reason: result.reason || 'The sportsbook explicitly rejected the bet.' }
        : ['blocked', 'changed'].includes(result?.outcome) ? { status: 'SUBMISSION_BLOCKED', success: false, reason: result.reason || 'Submission is unavailable.' }
        : state === 'unknown' ? { status: 'BET_OUTCOME_UNKNOWN', success: false, reason: result?.reason || 'Submission attempted—acceptance unverified. Check My Bets before trying again.' }
            : { status: 'SUBMISSION_BLOCKED', success: false, reason: result?.reason || 'Submission is unavailable.' };
      rememberMessage(session, { id: 'submission-' + review.id, role: 'agent', result: response });
      return sendJson(res, state === 'accepted' || state === 'rejected' ? 200 : 503, response);
    }
    return sendJson(res, 409, { error: 'Submission authorization was already consumed.' });
  }

  if (req.method !== 'POST' || !['/api/run', '/api/confirm', '/api/cancel'].includes(route)) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  // Restrict requests to the local chat interface.
  if (req.headers.origin !== 'http://' + HOST + ':' + PORT) {
    return sendJson(res, 403, { error: 'Invalid request origin' });
  }

  if (busyRejects(route, isBusy())) {
    return sendJson(res, 409, { code: 'BUSY', error: 'Another test is running' });
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    return error.message === 'TOO_LARGE'
      ? sendJson(res, 413, { error: 'Request too large' })
      : sendJson(res, 400, { error: 'Invalid JSON' });
  }

  let selectedMode;
  if (route === '/api/run') {
    // Legacy API clients without a mode retain the historical SPORTS flow.
    // Slot work always requires an explicit mode; there is no implicit play permission.
    const mode = payload.mode === undefined ? 'SPORTS' : payload.mode;
    selectedMode = mode;
    if (!EXECUTION_MODES.includes(mode)) return sendJson(res, 400, { status: 'INVALID_MODE', code: 'INVALID_MODE', error: 'Select SPORTS or SLOTS_INSPECT.' });
    if (mode === 'SLOTS_PLAY' && !slotsPlayEnabled()) return sendJson(res, 403, { status: 'MODE_DISABLED', code: 'MODE_DISABLED', success: false,
      error: 'SLOTS_PLAY is disabled. Set ENABLE_SLOTS_PLAY=1 when starting the chat server to enable it.' });
    if (typeof payload.instruction !== 'string' || !payload.instruction.trim() || payload.instruction.length > 500)
      return sendJson(res, 400, { status: 'INVALID_REQUEST', code: 'INVALID_REQUEST', error: 'Invalid instruction' });
    if (mode === 'SLOTS_INSPECT') {
      if (/\b(spin|spins|wager|bet|place|play)\b/i.test(payload.instruction))
        return sendJson(res, 403, { status: 'ACTION_NOT_PERMITTED', code: 'ACTION_NOT_PERMITTED', success: false, error: 'SLOTS_INSPECT allows read-only inspection only.' });
      if (inspectionBusy) return sendJson(res, 409, { status: 'BUSY', code: 'BUSY', error: 'Another browser inspection is running.' });
      inspectionBusy = true;
      try { return reply(await inspectSlots(payload.instruction)); }
      catch (error) { return reply({ status: 'MIDSCENE_INSPECTION_FAILED', success: false, mode, error: 'MIDSCENE_INSPECTION_FAILED', logs: String(error).slice(0, 2000) }); }
      finally { inspectionBusy = false; }
    }
  }

  // Body reads yield to other requests. Recheck before taking the execution lock.
  if (busyRejects(route, isBusy())) return sendJson(res, 409, { code: 'BUSY', error: 'Another test is running' });
  busy = true;
  try {
    if (route === '/api/cancel') {
      if (!cancelConfirmation(session, payload.planId)) return sendJson(res, 400, { code: 'PLAN_EXPIRED', error: 'Plan expired or unknown.' });
      confirmationInvalidated = true;
      return reply({ status: 'CANCELLED', reason: 'Cancelled. Nothing was run.', actions: [] });
    }
    // ---- Step 2: user confirmed a wager plan ----
    if (route === '/api/confirm') {
      const pending = takeConfirmation(session, payload.planId);
      if (!pending) {
        return sendJson(res, 400, { code: 'PLAN_EXPIRED', error: 'Plan expired, already used, or unknown. Start with “New request: …” for a fresh summary.' });
      }

      if (pending.mode === 'SLOTS_PLAY' && !slotsPlayEnabled()) {
        return sendJson(res, 403, { status: 'MODE_DISABLED', code: 'MODE_DISABLED', success: false,
          error: 'SLOTS_PLAY is disabled. Set ENABLE_SLOTS_PLAY=1 when starting the chat server to enable it.' });
      }
      if (planModeMismatch(pending.mode, pending.plan)) {
        return sendJson(res, 403, { status: 'MODE_PLAN_MISMATCH', code: 'MODE_PLAN_MISMATCH', success: false,
          error: 'The stored execution mode does not match the validated plan type.' });
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
        const review = await prepareReview(pending.plan, pending.usage, session.id, pending.sportsRevision ?? 0);
        review.revision = pending.sportsRevision ?? 0;
        session.pendingSports = null;
        session.conversationState = null;
        clearSportsConfirmations(session);
        confirmationInvalidated = true;
        return reply(withUsage({ status: 'REVIEW_STARTING', reviewId: review.id }, pending.usage));
      }
      let slotEvidence;
      if (pending.mode === 'SLOTS_PLAY') {
        slotEvidence = await createSlotsEvidence(pending.plan);
        const readiness = await checkSlotsReadiness();
        slotEvidence.readiness = readiness.result ?? null;
        await appendSlotEvidenceLog(slotEvidence, 'Midscene readiness', readiness.stdout, readiness.stderr);
        if (!readiness.ready) {
          const reason = readiness.result?.reason || 'Midscene model or image-input check failed.';
          const report = await finalizeSlotEvidence(slotEvidence, {
            status: 'MODEL_UNAVAILABLE', success: false, reason, actions: [],
          }, -1, reason);
          return reply({ status: 'MODEL_UNAVAILABLE', success: false, reason,
            evidence: report.evidence, actions: [] });
        }
      }
      const testFile = isSports ? SPORTS_TEST : SLOT_TEST;
      const env = isSports ? { ALLOW_SPORTS_PREPARE: '1' } : { ALLOW_SPINS: '1' };
      const { code, report } = await runPlan(pending.plan, testFile, env, slotEvidence);
      return reportResponse(res, code, report, pending.usage, {}, reply);
    }

    // ---- Step 1: plan the instruction ----
    const instruction = payload.instruction;
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 500) {
      return sendJson(res, 400, { error: 'Invalid instruction' });
    }

    if (payload.messageId !== undefined && (typeof payload.messageId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(payload.messageId))) {
      return sendJson(res, 400, { error: 'Invalid message ID' });
    }
    const messageId = payload.messageId || randomUUID();
    rememberMessage(session, { id: 'user-' + messageId, role: 'user', text: instruction });
    const result = await planMessage(instruction, session.pendingSports, session.conversationState, messageId);
    if (Object.hasOwn(result, 'pendingSports')) {
      confirmationInvalidated = Boolean(result.confirmationInvalidated ?? result.changed);
      if (confirmationInvalidated) clearSportsConfirmations(session);
      session.pendingSports = result.pendingSports;
      if (result.conversationState) session.conversationState = result.conversationState;
    }
    if (['CLARIFICATION', 'AMBIGUOUS', 'UNRELATED', 'CANCELLED', 'EXPIRED', 'UNCHANGED'].includes(result.status)) {
      return reply(withUsage({ status: result.status, reason: result.reason, requirements: result.requirements || [], actions: [] }, result.usage));
    }

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
      return reply(withUsage({
        status: 'BLOCKED', success: false,
        reason: slotRequest ? result.reason + ' ' + supported : sportsRequest
          ? sportsReason
          : result.reason,
        actions: []
      }, result.usage));
    }
    if (result.status !== 'PLANNED') {
      throw new Error(result.code || 'PLANNING_FAILED');
    }

    if (planModeMismatch(selectedMode, result.plan)) {
      return sendJson(res, 403, { status: 'MODE_PLAN_MISMATCH', code: 'MODE_PLAN_MISMATCH', success: false,
        error: 'The selected execution mode does not match the validated plan type.' });
    }

    const sportsAction = result.plan.actions.find((action) => action.type === 'prepare_sports_bet');
    if (sportsAction && (result.auth !== true || !result.pendingSports || !sportsPlanMatchesRequest(result.plan, result.conversationState)
      || sportsRequestFingerprint(result.pendingSports) !== sportsRequestFingerprint(result.conversationState.request)
      || result.conversationState.confirmation.expiresAt <= Date.now())) {
      return reply(withUsage({
        status: 'BLOCKED', success: false,
        reason: 'The sports plan did not come from a complete conversation request. Please describe the preparation request again. No browser run was started.',
        actions: []
      }, result.usage));
    }

    // Anything that needs the account waits for an explicit confirmation.
    if (result.auth) {
      const planId = randomUUID();
      session.confirmations.set(planId, {
        ...pendingPlan(result.plan, result.usage, result.conversationState?.confirmation?.expiresAt ?? Date.now() + CONFIRM_WINDOW_MS),
        mode: selectedMode,
        ...(sportsAction && result.conversationState ? { sportsRevision: result.conversationState.revision,
          sportsRequestFingerprint: sportsRequestFingerprint(result.pendingSports) } : {}),
      });
      return reply(withUsage({
        status: 'CONFIRM',
        planId,
        summary: describePlan(result.plan),
        actions: result.plan.actions,
        revision: sportsAction ? result.conversationState.revision : undefined,
        expiresAt: session.confirmations.get(planId).expires,
      }, result.usage));
    }

    const { code, report } = await runPlan(result.plan, READ_ONLY_TEST, {});
    return reportResponse(res, code, report, result.usage, {}, reply);
  } catch (error) {
    return errorResponse(res, error);
  } finally {
    busy = false;
  }
});
}

if (require.main === module) {
const server = createChatServer();
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
}

module.exports = { createChatServer };
