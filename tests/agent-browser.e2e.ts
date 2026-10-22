
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

import { executePlan } from '../src/agent/executor';
import { createE2EBrowserAdapter } from
  '../src/agent/adapters/e2e-browser';

test(
  'validated plan executes against the real browser',
  async ({ app, browser }) => {
    await app.open('/');

    const adapter = createE2EBrowserAdapter(
      browser,
      app,
      'https://www.hollywoodbets.net/'
    );

    const plan = {
      thought: 'Verify HollywoodBets homepage',
      actions: [
        { type: 'get_page_info' },
        {
          type: 'check_visible',
          selector: 'body',
        },
      ],
    };

    const report = await executePlan(plan, adapter);

    console.log(
      'Agent execution report:',
      JSON.stringify(report, null, 2)
    );

    if (!report.success) {
      throw new Error(
        'Agent browser verification failed'
      );
    }

    await expect(
      browser.locator('body')
    ).toBeVisible();
  }
);
