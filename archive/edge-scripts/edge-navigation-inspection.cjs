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

    const result = await page.evaluate(() => {
      const terms = /all sports|live in.play|upcoming soccer|e?soccer|^soccer$/i;
      const visible = el => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 && rect.height > 0;
      };

      return Array.from(document.querySelectorAll(
        'a, button, [role="button"], [role="link"], [role="tab"]'
      ))
        .filter(el => visible(el))
        .map(el => ({
          tag: el.tagName,
          text: (el.innerText || el.getAttribute('aria-label') || '')
            .trim().replace(/\s+/g, ' ').slice(0, 100),
          role: el.getAttribute('role'),
          href: el.getAttribute('href'),
          ariaLabel: el.getAttribute('aria-label'),
          className: String(el.className || '').slice(0, 160)
        }))
        .filter(el => terms.test(el.text))
        .slice(0, 60);
    });

    console.log('Homepage navigation controls:');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
