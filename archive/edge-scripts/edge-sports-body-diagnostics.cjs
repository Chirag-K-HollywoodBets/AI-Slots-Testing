const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);

(async () => {
  const browser = await chromium.connectOverCDP(
    'http://127.0.0.1:9222'
  );

  try {
    const context = browser.contexts()[0];
    const page = context.pages().find(p =>
      p.url().includes('hollywoodbets.net')
    );

    if (!page) throw new Error('HollywoodBets tab not found');

    const targets = [
      /comet-settings-api\.hollywoodbets\.net\/api\/popular\/inplay\/sports/i,
      /betepsweb\.hollywoodbets\.net\/live-or-upcoming\/sports/i,
      /sport-events-api\.hollywoodbets\.net\/api\/events\/eps\/sports/i,
    ];

    const summaries = [];
    const pending = [];

    page.on('response', response => {
      if (!targets.some(pattern => pattern.test(response.url()))) return;

      pending.push((async () => {
        const result = {
          status: response.status(),
          url: response.url(),
        };

        try {
          const data = await response.json();

          result.bodyType = Array.isArray(data) ? 'array' : typeof data;
          result.topLevelKeys =
            data && typeof data === 'object' && !Array.isArray(data)
              ? Object.keys(data).slice(0, 30)
              : [];

          if (Array.isArray(data)) {
            result.itemCount = data.length;
            result.sample = data.slice(0, 2);
          } else if (data && typeof data === 'object') {
            result.arrayFields = Object.entries(data)
              .filter(([, value]) => Array.isArray(value))
              .map(([key, value]) => ({
                key,
                count: value.length,
                sample: value.slice(0, 1),
              }));
          }

          summaries.push(result);
        } catch (error) {
          summaries.push({
            ...result,
            bodyReadError: String(error),
          });
        }
      })());
    });

    console.log('Reloading homepage to capture API response bodies...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 7000));
    await Promise.allSettled(pending);

    const pageSummary = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      return {
        title: document.title,
        bodyTextLength: text.length,
        liveRelatedLines: text.split('\n')
          .map(line => line.trim())
          .filter(line => /live|in.play|soccer|football|events/i.test(line))
          .slice(0, 40),
      };
    });

    console.log('\nAPI BODY SUMMARIES:');
    console.log(JSON.stringify(summaries, null, 2));
    console.log('\nPAGE SUMMARY:');
    console.log(JSON.stringify(pageSummary, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
