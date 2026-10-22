import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('AI can identify the Premier League in mock competitions', async ({ app, browser, agent }) => {
  await app.open('/sports');

  await agent.act('Locate the Premier League entry. Do not click it.');

  const premierLeague = browser.locator('[data-testid="competition-premier-league"]');
  await expect(browser.locator('h1')).toContainText('Football competitions');
  await expect(premierLeague).toBeVisible();
  await expect(premierLeague).toContainText('Premier League');
  await expect(premierLeague).toContainText('Country: England');
  await expect(browser.locator('[data-testid="competition-champions-league"]')).toBeVisible();
  await expect(browser.locator('[data-testid="competition-la-liga"]')).toBeVisible();
});
