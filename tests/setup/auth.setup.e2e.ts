// Signs in once and saves the session as 'hb-test'.
// Clicking "Log in" redirects to id.hollywoodbets.net, a separate sign-in site,
// which sends the browser back to www.hollywoodbets.net after a successful login.
 
import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
 
test.setup('sign in to the HollywoodBets test account', { sessions: ['hb-test'] }, async ({ app, browser, screen, session }) => {
  const user = credentials.user('hb-test');
 
  await app.open('/');
  await screen.getByRole('button', /log in/i).tap();
 
  // Sign-in site (id.hollywoodbets.net). Selectors from tests/diagnostics/login-form.e2e.ts.
  await expect(browser.locator('#Username')).toBeVisible({ timeout: 20000 });
  await browser.locator('#Username').fill(user.username);
  await browser.locator('#password').fill(user.password); // Secret handle, never the raw value
  await browser.locator('#btnLogin').click();
 
  // Signed in = sent back to the main site, and the Log in button is gone.
  await browser.waitForURL(/^https:\/\/www\.hollywoodbets\.net\//, { timeout: 30000 });
  await expect(screen.getByRole('button', /log in/i)).not.toBeVisible({ timeout: 20000 });
  // Only signed-in users have a balance in the header.
  await expect(browser.locator('.account .balance-value').first()).toBeVisible({ timeout: 20000 });
  await expect(browser.locator('.account .balance-value').first()).toContainText(/R\s?[\d\s]+,\d{2}/);
 
  await session.save('hb-test');
});
