import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('AI can locate a visible link on the controlled fixture', async ({ app, browser, agent }) => {
  await app.open('/');

  await agent.act('Locate the visible link labelled "Fixture link". Do not click it.');

  await expect(browser.locator('h1')).toContainText('AI browser test fixture');
  await expect(browser.locator('a[href="#fixture-destination"]')).toContainText('Fixture link');
  await expect(browser.locator('a[href="#fixture-destination"]')).toBeVisible();
});
