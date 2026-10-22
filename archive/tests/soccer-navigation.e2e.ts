import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('sports betting page loads expected content', async ({ app, browser }) => {
  await app.open('/');

  const allSports = browser.locator('a[href="/sports-betting"]');
  await expect(allSports).toBeVisible();
  await allSports.click();

  const body = browser.locator('body');
  await expect(body).toBeVisible();

  await expect(body).toContainText(/sports|soccer|football/i);
});
