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

    const apiResponses = [];
    page.on('response', response => {
      if (/live-or-upcoming\/sports|api\/events\/eps\/sports|popular\/inplay\/sports/i.test(response.url())) {
        apiResponses.push({
          status: response.status(),
          url: response.url()
        });
      }
    });

    await page.waitForTimeout(5000);

    const result = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const lines = bodyText.split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      const candidates = Array.from(document.querySelectorAll(
        '[class*="event"], [class*="Event"], [class*="match"], [class*="Match"], [class*="fixture"], [class*="Fixture"]'
      )).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      return {
        url: location.href,
        title: document.title,
        bodyTextLength: bodyText.length,
        relevantLines: lines.filter(s =>
          /live|soccer|football|event|match|league|odds|minute|vs\.?/i.test(s)
        ).slice(0, 120),
        eventCandidateCount: candidates.length,
        eventCandidateSamples: candidates.slice(0, 12).map(el => ({
          tag: el.tagName,
          className: String(el.className || '').slice(0, 160),
          text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 300)
        }))
      };
    });

    console.log('PAGE DIAGNOSTICS:');
    console.log(JSON.stringify(result, null, 2));
    console.log('\nMATCHING API RESPONSES:');
    console.log(JSON.stringify(apiResponses, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
