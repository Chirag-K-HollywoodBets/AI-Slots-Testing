
const http = require('node:http');
const { spawn } = require('node:child_process');
const { readFile, writeFile, mkdtemp, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');

const PORT = 3001;
const HOST = '127.0.0.1';
const PROJECT = path.resolve(__dirname, '..');

let busy = false;

// Wager plans wait here until the user confirms them. Keyed by a random id,
// so the plan itself never round-trips through the browser.
const pendingPlans = new Map();
const CONFIRM_WINDOW_MS = 2 * 60 * 1000;

const READ_ONLY_TEST = 'tests/agent-ai-demo.e2e.ts';
const SLOT_TEST = 'tests/agent-slot.e2e.ts';

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
<p>Local Qwen + E2E | Read-only checks, plus confirmed slot spins on the test account</p>
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

  if (result.status === 'CONFIRM') {
    status.textContent = 'CONFIRMATION NEEDED\\n' + result.summary + '\\n';
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

  status.textContent =
    (result.status || (result.success ? 'PASS' : 'FAIL')) +
    (result.reason ? '\\nReason: ' + result.reason : '') +
    (result.durationMs !== undefined
      ? '\\nExecution time: ' + result.durationMs + ' ms'
      : '') +
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

    const result = await response.json();
    render(status, response, result);
  } catch {
    status.textContent = 'Unable to reach the test server.';
  } finally {
    send.disabled = false;
  }
});
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
  const { stdout, stderr } = await runNode(
    [tsxCli, 'scripts/plan.ts'],
    { AGENT_INSTRUCTION: instruction },
    90000
  );
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PLAN_RESULT:'));
  if (!line) {
    console.error('Planner stderr:', stderr);
    throw new Error('PLANNING_FAILED');
  }
  return JSON.parse(line.slice('PLAN_RESULT:'.length));
}

function describePlan(plan) {
  const spin = plan.actions.find((a) => a.type === 'play_slot');
  if (!spin) return 'Open a casino game on the test account.';
  const total = (spin.spins * spin.stake).toFixed(2);
  return 'Sign in with the test account, open ' + spin.game + ', and play ' +
    spin.spins + ' spin(s) at R' + spin.stake.toFixed(2) +
    ' (up to R' + total + ' staked).\nOnly confirm if this account uses test credits.';
}

// Writes the plan to a temp file, runs one test file, returns the report.
async function executePlanFile(plan, testFile, extraEnv) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hwb-agent-'));
  try {
    const planPath = path.join(directory, 'plan.json');
    const reportPath = path.join(directory, 'report.json');
    await writeFile(planPath, JSON.stringify(plan), 'utf8');

    let code;
    try {
      code = await runTest(testFile, {
        AGENT_PLAN_PATH: planPath,
        AGENT_REPORT_PATH: reportPath,
        ...extraEnv
      }, testFile === SLOT_TEST ? 600000 : 120000);
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

  if (/LLM_UNAVAILABLE|Bad Gateway|HTTP 502/i.test(message)) {
    code = 'LLM_UNAVAILABLE';
    userMessage = 'The local Qwen service is unavailable.';
  } else if (/PLANNING_FAILED/.test(message)) {
    code = 'PLANNING_FAILED';
    userMessage = 'The planner could not produce a plan.';
  } else if (/NO_REPORT/.test(message)) {
    code = 'NO_REPORT';
    userMessage = 'Test did not produce a report.';
  } else if (/timed out/i.test(message)) {
    code = 'EXECUTION_TIMEOUT';
    userMessage = 'The test exceeded its execution time limit.';
  } else if (/launch|ENOENT|EINVAL/i.test(message)) {
    code = 'BROWSER_RUNNER_ERROR';
    userMessage = 'The E2E test runner could not be started.';
  }

  return sendJson(res, 500, { success: false, code, error: userMessage });
}

function reportResponse(res, code, report) {
  return sendJson(res, 200, {
    status: report.status ?? (code === 0 && report.success === true ? 'PASS' : 'FAIL'),
    success: code === 0 && report.success === true,
    reason: report.reason,
    durationMs: report.durationMs,
    actions: report.actions ?? []
  });
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) throw new Error('TOO_LARGE');
  }
  return JSON.parse(body);
}

http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1:3001');

  if (requestUrl.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'"
    });
    return res.end(html);
  }

  const route = requestUrl.pathname;
  if (req.method !== 'POST' || (route !== '/api/run' && route !== '/api/confirm')) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  // Restrict requests to the local chat interface.
  if (req.headers.origin !== 'http://' + HOST + ':' + PORT) {
    return sendJson(res, 403, { error: 'Invalid request origin' });
  }

  if (busy) {
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

      const { code, report } = await executePlanFile(pending.plan, SLOT_TEST, { ALLOW_SPINS: '1' });
      return reportResponse(res, code, report);
    }

    // ---- Step 1: plan the instruction ----
    const instruction = payload.instruction;
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 500) {
      return sendJson(res, 400, { error: 'Invalid instruction' });
    }

    if (!/^(inspect|verify|check|report|navigate|open|play|spin|log\s?in)\b/i.test(instruction.trim())) {
      return sendJson(res, 400, { error: 'Only approved testing requests are supported' });
    }

    const result = await planInstruction(instruction);

    if (result.status === 'BLOCKED') {
      return sendJson(res, 200, { status: 'BLOCKED', success: false, reason: result.reason, actions: [] });
    }
    if (result.status !== 'PLANNED') {
      throw new Error(result.code || 'PLANNING_FAILED');
    }

    // Anything that needs the account waits for an explicit confirmation.
    if (result.auth) {
      const planId = randomUUID();
      pendingPlans.set(planId, { plan: result.plan, expires: Date.now() + CONFIRM_WINDOW_MS });
      return sendJson(res, 200, {
        status: 'CONFIRM',
        planId,
        summary: describePlan(result.plan),
        actions: result.plan.actions
      });
    }

    const { code, report } = await executePlanFile(result.plan, READ_ONLY_TEST, {});
    return reportResponse(res, code, report);
  } catch (error) {
    return errorResponse(res, error);
  } finally {
    busy = false;
  }
}).listen(PORT, HOST, () => {
  console.log('AI Testing Agent: http://' + HOST + ':' + PORT);
});
