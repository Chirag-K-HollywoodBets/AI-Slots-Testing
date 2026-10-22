
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('diagnose sports network requests in Edge', async ({ app, browser }) => {
  await app.open('/');
  await expect(browser.locator('body')).toBeVisible();

  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Browser has no request/response events, so read the page's resource
  // timings instead. A status of 0 means the request failed or was blocked.
  const requests = await browser.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((entry) => /hollywoodbets\.net/i.test(entry.name))
      .map((entry) => ({
        url: entry.name,
        status: entry.responseStatus ?? null,
        failure: entry.responseStatus === 0 ? 'Failed or blocked' : null,
      }))
  );

  console.log(
    'HOLLYWOODBETS NETWORK REQUESTS:',
    JSON.stringify(requests, null, 2),
  );
});
