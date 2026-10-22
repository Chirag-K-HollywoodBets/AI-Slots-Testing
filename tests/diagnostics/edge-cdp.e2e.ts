import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('Edge CDP can open and inspect HollywoodBets', async ({ app, browser }) => {
  await app.open('/');

  await expect(browser.locator('body')).toBeVisible();

  await expect(browser).toHaveTitle(
    'Online Sports Betting and Online Casino | Hollywoodbets'
  );

  console.log('HollywoodBets title assertion passed.');
  console.log('HollywoodBets body visibility assertion passed.');
});
