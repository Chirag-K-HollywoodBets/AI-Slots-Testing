import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('homepage displays key public elements', async ({ app, browser }) => {
  await app.open('/');

  // The page body is rendered.
  await expect(browser.locator('body')).toBeVisible();

  // Public sports navigation is present.
  await expect(
    browser.locator('[data-testid="desktop-all-sports"]')
  ).toBeVisible();

  // The search field is present.
  await expect(
    browser.locator('[data-testid="search-input"]')
  ).toBeVisible();
// The search field is enabled.
  await expect(
    browser.locator('[data-testid="search-input"]')
  ).toBeEnabled();

});
test('homepage has the expected title', async ({ app, browser }) => {
  await app.open('/');

  const title = await browser.title();

  expect(title).toBe(
    'Online Sports Betting and Online Casino | Hollywoodbets'
  );
});
test('homepage search field accepts text', async ({ app, browser }) => {
  await app.open('/');

  const search = browser.locator('[data-testid="search-input"]');

  await expect(search).toBeVisible();
  await expect(search).toBeEnabled();
  await search.fill('football');

  await expect(search).toHaveValue('football');
});

test('homepage does not display a bet-types error', async ({ app, browser }) => {
  await app.open('/');

  await expect(
    browser.locator('body')
  ).not.toContainText('ERROR: Error getting bet types');
});
