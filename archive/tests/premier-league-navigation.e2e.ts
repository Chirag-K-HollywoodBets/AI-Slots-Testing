import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('sports betting entry is available without AI inspection', async ({ app, browser }) => {
  await app.open('/');

  const allSports = browser.locator('a[href="/sports-betting"]');
  await expect(allSports).toBeVisible();
});
