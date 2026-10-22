const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);

(async () => {
  const browser = await chromium.connectOverCDP(
    'http://127.0.0.1:9222'
  );

  try {
    const context = browser.contexts()[0];
    const pages = context.pages();

    const page = pages.find(p =>
      p.url().includes('hollywoodbets.net')
    );

    if (!page) {
      throw new Error('No open HollywoodBets tab found in Edge.');
    }

    const requests = [];

    page.on('response', response => {
      const url = response.url();

      if (/hollywoodbets\.net/i.test(url)) {
        requests.push({
          type: 'response',
          status: response.status(),
          url
        });
      }
    });

    page.on('requestfailed', request => {
      const url = request.url();

      if (/hollywoodbets\.net/i.test(url)) {
        requests.push({
          type: 'requestfailed',
          error: request.failure()?.errorText ?? 'Unknown failure',
          url
        });
      }
    });

    console.log('Monitoring:', page.url());
    console.log('Reloading the page to capture initial requests...');

    await page.reload({
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 8000));

    console.log('\nNETWORK DIAGNOSTICS:');
    console.log(JSON.stringify(requests, null, 2));

    console.log('\nTOTAL MATCHING EVENTS:', requests.length);
  } finally {
    // Detach this script without closing the user's Edge session.
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
