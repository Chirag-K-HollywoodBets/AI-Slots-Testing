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

    // Return to the homepage where the Live In-Play navigation was found.
    await page.goto('https://www.hollywoodbets.net/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });
    await page.waitForTimeout(3000);

    const buttons = await page.locator('button').evaluateAll(elements =>
      elements.map(el => ({
        text: (el.innerText || '').trim().replace(/\s+/g, ' '),
        visible: !!(el.offsetWidth || el.offsetHeight ||
          el.getClientRects().length)
      })).filter(el => el.visible &&
        /live in.play|soccer|upcoming soccer/i.test(el.text))
    );

    console.log('Homepage:', page.url());
    console.log('Relevant buttons:', JSON.stringify(buttons, null, 2));

    const liveButton = page.getByRole('button', {
      name: /Live In-Play/i
    }).first();

    const count = await page.getByRole('button', {
      name: /Live In-Play/i
    }).count();

    console.log('Live In-Play button count:', count);

    if (count === 0) {
      console.log('Button not found; stopping without clicking.');
      return;
    }

    await liveButton.click({ timeout: 15000 });
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return {
        url: location.href,
        title: document.title,
        bodyTextLength: text.length,
        relevantLines: text.split('\n')
          .map(s => s.trim())
          .filter(Boolean)
          .filter(s =>
            /live|soccer|football|event|match|in.play|league/i.test(s)
          )
          .slice(0, 100)
      };
    });

    console.log('\nLIVE IN-PLAY RESULT:');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
