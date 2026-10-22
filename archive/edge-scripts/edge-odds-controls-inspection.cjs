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

    await page.goto(
      'https://www.hollywoodbets.net/betting/live-in-play/0/all-sports',
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );

    await page.waitForSelector('.match-list-item-container', {
      state: 'attached',
      timeout: 30000
    });

    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const card = document.querySelector('.match-list-item-container');
      if (!card) return { error: 'No event card found' };

      return {
        eventText: (card.innerText || '').trim().replace(/\s+/g, ' '),
        controls: Array.from(
          card.querySelectorAll('button, [role="button"], a, input')
        ).map(el => ({
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 160),
          className: String(el.className || '').slice(0, 180)
        })).slice(0, 40)
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
