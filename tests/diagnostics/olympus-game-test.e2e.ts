
import { test } from '@e2e-dev/web';

test('Diagnose Games in Olympus lobby', async ({ browser }) => {
  await browser.goto(
    'https://www.hollywoodbets.net/lobby/top-games/#/g/games-in-olympus'
  );

  const result = await browser.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll(
        'button, a, [role="button"], iframe, input'
      )
    ).slice(0, 80).map((element) => ({
      tag: element.tagName,
      text: (element.textContent || '').trim().slice(0, 120),
      ariaLabel: element.getAttribute('aria-label') ?? null,
      title: element.getAttribute('title') ?? null,
      href: element.getAttribute('href') ?? null,
      role: element.getAttribute('role') ?? null,
      src: element.tagName === 'IFRAME'
        ? element.getAttribute('src') ?? null
        : null,
    }));

    const resources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) =>
        /bet.?type|game|casino|comet|content-cms/i.test(url)
      )
      .slice(-50);

    return {
      title: document.title,
      url: location.href,
      bodyText: document.body.innerText.slice(0, 4000),
      controls,
      resources,
    };
  });

  console.log(
    'OLYMPUS DIAGNOSTIC:',
    JSON.stringify(result, null, 2)
  );
});
