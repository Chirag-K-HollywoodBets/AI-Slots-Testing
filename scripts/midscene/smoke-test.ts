import { chromium } from 'playwright';
import { PlaywrightPageAgent } from '@midscene/web/playwright';

const PAGE_URL = 'https://the-internet.herokuapp.com/add_remove_elements/';

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  let agent: PlaywrightPageAgent | undefined;

  try {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    agent = new PlaywrightPageAgent(page, { cache: false });

    const description = await agent.aiQuery(
      'Describe the visible page and identify its main heading and the obvious button.'
    );
    console.log('Page description:', description);

    await agent.aiTap('the "Add Element" button');
    console.log('Tapped the Add Element button.');
  } finally {
    await agent?.destroy();
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
