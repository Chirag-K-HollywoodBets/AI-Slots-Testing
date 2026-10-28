// My Bets verification is disabled until the runner can retain run-specific
// submission evidence and reliably correlate a unique provider bet reference.
import { test } from '@e2e-dev/web';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

test('sports My Bets verification requires run-specific submission evidence', {
  session: 'hb-test',
  timeout: 30_000,
  tags: ['wager', 'read-only'],
}, async () => {
  const reportPath = process.env.AGENT_REPORT_PATH;
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({
      status: 'BLOCKED',
      success: false,
      reason: 'My Bets verification is unavailable without run-specific submission evidence and a unique bet reference.',
      actions: [],
    }, null, 2), 'utf8');
  }
});
