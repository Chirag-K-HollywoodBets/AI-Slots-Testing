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
      const cards = Array.from(
        document.querySelectorAll('.match-list-item-container')
      );

      return {
        url: location.href,
        title: document.title,
        cardCount: cards.length,
        cards: cards.slice(0, 5).map((card, index) => {
          const text = (card.innerText || '')
            .trim()
            .replace(/\s+/g, ' ');

          const oddsCandidates =
            text.match(/\b\d+\.\d+\b/g) || [];

          return {
            index: index + 1,
            text: text.slice(0, 1000),
            decimalOddsCandidates: [...new Set(oddsCandidates)]
          };
        })
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
