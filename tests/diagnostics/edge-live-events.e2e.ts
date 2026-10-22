
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('Live In-Play renders an event card in Edge', async ({
  app,
  browser,
}) => {
  await app.open('/betting/live-in-play/0/all-sports');

  await expect(browser).toHaveTitle(
    'Live Sports Betting | Live Betting Odds'
  );

  const event = browser
    .locator('.match-list-item-container')
    .first();

  await expect(event).toBeVisible();

  console.log('Live In-Play title assertion passed.');
  console.log('At least one event card is visible.');

  // Do not call innerText() on this framework's locator wrapper.
});
