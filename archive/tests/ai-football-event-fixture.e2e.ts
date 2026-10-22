import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('AI can identify the Arsenal vs Chelsea mock event', async ({ app, browser, agent }) => {
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
  await expect(fields.nth(3)).toContainText('25 Oct 2025, 19:30 SAST');
  await expect(fields.nth(4)).toContainText('Scheduled');
  await expect(browser.locator('[data-testid="event-manchester-city-liverpool"]')).toBeVisible();
  await expect(browser.locator('[data-testid="event-real-madrid-sevilla"]')).toBeVisible();
});
