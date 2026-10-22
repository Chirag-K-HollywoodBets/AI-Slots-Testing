// Read-only: needs session 'hb-test', so e2e runs tests/setup/auth.setup.e2e.ts first.
// Looks for something that is only present when signed in, to use as the setup's check.
 
import { test } from '@e2e-dev/web';
 
test('inspect the signed-in page', { session: 'hb-test' }, async ({ app, browser }) => {
  await app.open('/');
  await new Promise((r) => setTimeout(r, 5000));
 
  const result = await browser.evaluate(() => {
    const isVisible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const describe = (el: Element) => ({
      tag: el.tagName,
      id: el.id || null,
      testId: el.getAttribute('data-testid') ?? null,
      cls: (el.getAttribute('class') ?? '').slice(0, 60) || null,
      text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || null,
    });
    const signedInWords = /balance|my account|deposit|withdraw|log ?out|sign ?out|bonus|^R\s?\d/i;
 
    return {
      url: location.origin + location.pathname,
      logInVisible: Array.from(document.querySelectorAll('button, a'))
        .some((el) => /^\s*log\s?in\s*$/i.test(el.textContent ?? '') && isVisible(el)),
      joinVisible: Array.from(document.querySelectorAll('button, a'))
        .some((el) => /^\s*join( now)?\s*$/i.test(el.textContent ?? '') && isVisible(el)),
      headerTextLength: document.querySelector('header')?.textContent?.trim().length ?? null,
      signedInCandidates: Array.from(document.querySelectorAll('button, a, span, div'))
        .filter((el) => el.children.length <= 2 && isVisible(el) && signedInWords.test((el.textContent ?? '').trim()))
        .map(describe)
        .slice(0, 25),
    };
  });
 
  console.log('SIGNED-IN DIAGNOSTIC:', JSON.stringify(result, null, 2));
});