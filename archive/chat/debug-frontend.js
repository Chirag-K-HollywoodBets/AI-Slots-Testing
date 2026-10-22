
const form = document.getElementById('form');
const input = document.getElementById('instruction');
const messages = document.getElementById('messages');
const send = document.getElementById('send');

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.textContent = content;
  messages.appendChild(div);
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

if (!response.ok) {
  status.textContent =
    'ERROR\n' +
    'Code: ' + (result.code || 'UNKNOWN') + '\n' +
    'Reason: ' + (result.error || 'Unknown error');
} else {
  status.textContent =
    (result.status || (result.success ? 'PASS' : 'FAIL')) +
    (result.reason ? '\nReason: ' + result.reason : '') +
    (result.durationMs !== undefined
      ? '\nExecution time: ' + result.durationMs + ' ms'
      : '') +
    '\n' + JSON.stringify(result.actions ?? [], null, 2);
}
  } catch {
    status.textContent = 'Unable to reach the test server.';
  } finally {
    send.disabled = false;
  }
});

