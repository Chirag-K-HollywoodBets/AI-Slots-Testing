import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('logged-out user can add two soccer selections to the betslip', async ({ app, browser }) => {
  await app.open('/betslip');

  await expect(browser.locator('[data-testid="login-status"]'))
    .toContainText('Logged out');

  await browser.locator('[data-testid="select-arsenal"]').click();
  await browser.locator('[data-testid="select-liverpool"]').click();

  const betslip = browser.locator('[data-testid="bet-selections"]');

  await expect(browser.locator('[data-testid="selection-count"]'))
    .toContainText('Selections: 2');

  await expect(betslip).toContainText('Arsenal vs Chelsea: Arsenal 1.80');
  await expect(betslip).toContainText('Manchester City vs Liverpool: Liverpool 3.50');

  await expect(browser.locator('[data-testid="login-status"]'))
    .toContainText('Logged out');
});
