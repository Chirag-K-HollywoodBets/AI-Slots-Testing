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

    if (!page) throw new Error('Public homepage tab not found.');

    await page.goto('https://www.hollywoodbets.net/sports-betting', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return {
        url: location.href,
        title: document.title,
        bodyTextLength: text.length,
        relevantLines: text.split('\n')
          .map(s => s.trim())
          .filter(s => /live|soccer|football|sport|event|match|in.play/i.test(s))
          .slice(0, 80)
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
