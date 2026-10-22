
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('AI observes live soccer events without selecting odds', async ({ app, browser, agent }) => {
  await app.open('/');

  // Navigate deterministically to the public sports page.
  const soccerLink = browser.locator('a[href="/sports-betting"]');
  await expect(soccerLink).toBeVisible();
  await soccerLink.click();

  // Let the AI inspect the visible page, but prohibit interactions.
 await agent.act(
  'Look only at the currently visible page. Identify the first visible soccer or football match, if any. Do not click, select odds, or interact with the betslip.'
);
  await expect(browser.locator('body')).toBeVisible();
});
