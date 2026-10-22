import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('negative control rejects an incorrect mock kickoff expectation', async ({ app, browser, agent }) => {
  await app.open('/events');

  await agent.act('Locate Arsenal vs Chelsea and identify its competition and kickoff time. Do not click it.');

  const targetSelector = '[data-testid="event-arsenal-chelsea"]';
  const targetEvent = browser.locator(targetSelector);
  await expect(browser.locator('h1')).toContainText('Football events');
  await expect(targetEvent).toBeVisible();
  await expect(browser.locator(`${targetSelector} h2`)).toContainText('Arsenal vs Chelsea');
  const fields = browser.locator(`${targetSelector} dd`);
  await expect(fields.nth(0)).toContainText('Premier League');
  await expect(fields.nth(1)).toContainText('Arsenal');
  await expect(fields.nth(2)).toContainText('Chelsea');

  // Deliberate negative control: fixture data is 19:30; this test-only expectation says 18:30.
  await expect(fields.nth(3)).toContainText('25 Oct 2025, 18:30 SAST');
});
