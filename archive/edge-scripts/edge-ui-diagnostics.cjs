const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);

(async () => {
  const browser = await chromium.connectOverCDP(
    'http://127.0.0.1:9222'
  );

  try {
    const context = browser.contexts()[0];
    const pages = context.pages();

    console.log('Available tabs:');
    for (const p of pages) {
      console.log(`- ${p.url()}`);
    }

    const page = pages.find(p => {
      try {
        return new URL(p.url()).hostname === 'www.hollywoodbets.net';
      } catch {
        return false;
      }
    });

    if (!page) {
      throw new Error('Public homepage tab not found.');
    }

    const result = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? '';
      const lines = bodyText.split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      const links = Array.from(document.querySelectorAll('a'))
        .map(a => ({
          text: (a.innerText || a.getAttribute('aria-label') || '')
            .trim().replace(/\s+/g, ' ').slice(0, 100),
          href: a.href
        }))
        .filter(x =>
          /live|in.play|soccer|football|sport|event/i.test(
            x.text + ' ' + x.href
          )
        )
        .slice(0, 100);

      return {
        url: location.href,
        title: document.title,
        bodyTextLength: bodyText.length,
        relevantLinks: links,
        relevantVisibleLines: lines.filter(x =>
          /live|in.play|soccer|football|event|match/i.test(x)
        ).slice(0, 100)
      };
    });

    console.log('\nHOMEPAGE DIAGNOSTICS:');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
