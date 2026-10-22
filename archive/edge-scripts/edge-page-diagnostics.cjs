const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);

(async () => {
  const browser = await chromium.connectOverCDP(
    'http://127.0.0.1:9222'
  );

  try {
    const context = browser.contexts()[0];
    const page = context.pages().find(p => {
      try {
        return new URL(p.url()).hostname === 'www.hollywoodbets.net';
      } catch {
        return false;
      }
    });

    if (!page) throw new Error('Public Hollywoodbets tab not found.');

    await page.waitForTimeout(8000);

    const result = await page.evaluate(() => {
      const selectors = [
        '.match-list-item-container',
        '[class*="MatchListItemContainer"]',
        '[class*="MatchListContainer"]',
        '[class*="match"]',
        '[class*="Match"]'
      ];

      return {
        readyState: document.readyState,
        url: location.href,
        title: document.title,
        bodyTextLength: (document.body?.innerText || '').length,
        bodyStart: (document.body?.innerText || '').slice(0, 1200),
        selectors: Object.fromEntries(
          selectors.map(s => [s, document.querySelectorAll(s).length])
        )
      };
    });

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
