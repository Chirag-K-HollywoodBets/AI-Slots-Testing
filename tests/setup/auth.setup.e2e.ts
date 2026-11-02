// Signs in once and saves the session as 'hb-test'.
// Clicking "Log in" redirects to id.hollywoodbets.net, a separate sign-in site,
// which sends the browser back to www.hollywoodbets.net after a successful login.
 
import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import { loginTestAccount } from '../../src/agent/test-account-login';
 
test.setup('sign in to the HollywoodBets test account', { sessions: ['hb-test'] }, async ({ app, browser, screen, session }) => {
  const user = credentials.user('hb-test');
 
  await loginTestAccount({
    openHome: () => app.open('/'),
    clickLogin: () => screen.getByRole('button', /log in/i).tap(),
    waitForUsername: () => expect(browser.locator('#Username')).toBeVisible({ timeout: 20000 }),
    fillUsername: (username) => browser.locator('#Username').fill(username),
    fillPassword: (password) => browser.locator('#password').fill(password), // Secret handle, never the raw value
    submit: () => browser.locator('#btnLogin').click(),
    waitForSignedInUrl: () => browser.waitForURL(/^https:\/\/www\.hollywoodbets\.net\//, { timeout: 30000 }),
    verifySignedIn: async () => {
      await expect(screen.getByRole('button', /log in/i)).not.toBeVisible({ timeout: 20000 });
      await expect(browser.locator('.account .balance-value').first()).toBeVisible({ timeout: 20000 });
      await expect(browser.locator('.account .balance-value').first()).toContainText(/R\s?[\d\s]+,\d{2}/);
    },
  }, user);
 
  await session.save('hb-test');
});
