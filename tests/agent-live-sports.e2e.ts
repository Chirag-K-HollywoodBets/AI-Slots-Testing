
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

import { executePlan } from '../src/agent/executor';
import { createE2EBrowserAdapter } from
  '../src/agent/adapters/e2e-browser';

test(
  'agent verifies Live Sports event cards',
  async ({ app, browser }) => {
    await app.open('/');

    const adapter = createE2EBrowserAdapter(
      browser,
      app,
      'https://www.hollywoodbets.net/'
    );

    // First execute navigation and retrieve page information.
    const navigationPlan = {
      thought: 'Navigate to Live Sports',
      actions: [
        {
          type: 'navigate_to_allowlisted_path',
          path: '/betting/live-in-play/0/all-sports',
        },
        {
          type: 'get_page_info',
        },
      ],
    };

    const navigationReport = await executePlan(
      navigationPlan,
      adapter
    );

    console.log(
      'Navigation report:',
      JSON.stringify(navigationReport, null, 2)
    );

    if (!navigationReport.success) {
      throw new Error('Live Sports navigation failed');
    }

    // Confirm that the browser reached the expected route.
    const currentUrl = await browser.url();

    if (
      new URL(currentUrl).pathname !==
      '/betting/live-in-play/0/all-sports'
    ) {
      throw new Error('Unexpected page after navigation');
    }

    // Wait for the event cards after navigation.
    await expect(
      browser.locator('.match-list-item-container').first()
    ).toBeVisible({ timeout: 15000 });

    // Execute the visibility check through our agent executor.
    const verificationPlan = {
      thought: 'Verify Live Sports event cards',
      actions: [
        {
          type: 'check_visible',
          selector: '.match-list-item-container',
        },
      ],
    };

    const verificationReport = await executePlan(
      verificationPlan,
      adapter
    );

    console.log(
      'Verification report:',
      JSON.stringify(verificationReport, null, 2)
    );

    if (!verificationReport.success) {
      throw new Error('Live Sports verification failed');
    }
  }
);
