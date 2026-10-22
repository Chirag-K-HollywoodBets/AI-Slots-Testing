// Read-only: opens the login form and prints its inputs and buttons.
// Use the output to fill in the selectors in tests/setup/auth.setup.e2e.ts.

import { test } from '@e2e-dev/web';

test('inspect the HollywoodBets login form', async ({ app, screen, browser }) => {
  await app.open('/');
  await screen.getByRole('button', /log in/i).tap();
  await new Promise((r) => setTimeout(r, 2000));

  const result = await browser.evaluate(() => {
    const describe = (el: Element) => ({
      tag: el.tagName,
      type: el.getAttribute('type') ?? null,
      name: el.getAttribute('name') ?? null,
      id: el.id || null,
      placeholder: el.getAttribute('placeholder') ?? null,
      autocomplete: el.getAttribute('autocomplete') ?? null,
      ariaLabel: el.getAttribute('aria-label') ?? null,
      testId: el.getAttribute('data-testid') ?? null,
      text: (el.textContent ?? '').trim().slice(0, 60) || null,
    });

    return {
      url: location.origin + location.pathname,
      inputs: Array.from(document.querySelectorAll('input')).map(describe),
      buttons: Array.from(document.querySelectorAll('button, [role="button"]'))
        .map(describe)
        .filter((b) => b.text || b.ariaLabel || b.testId)
        .slice(0, 40),
      forms: document.querySelectorAll('form').length,
    };
  });

  console.log('LOGIN FORM DIAGNOSTIC:', JSON.stringify(result, null, 2));
});
