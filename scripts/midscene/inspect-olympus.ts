import { PlaywrightPageAgent } from '@midscene/web/playwright';
import { chromium, type Page, type Route } from 'playwright';
import { ALLOWED_GAMES } from '../../src/agent/schema';
import { isDoSpinRequest } from '../../src/agent/midscene-slot-guard';

const SITE_ORIGIN = 'https://www.hollywoodbets.net';
const CDP_ENDPOINT = 'http://127.0.0.1:9223';

function configureMidsceneModel(): void {
  // The Qwen vision adapter is the default for this image-based inspection;
  // callers can override it when the configured model requires another family.
  process.env.MIDSCENE_MODEL_BASE_URL ??= process.env.LLM_URL ?? 'http://10.6.49.95:8007/gemma/v1';
  process.env.MIDSCENE_MODEL_NAME ??= process.env.LLM_MODEL ?? 'Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf';
  process.env.MIDSCENE_MODEL_FAMILY ??= 'qwen3-vl';
  process.env.MIDSCENE_MODEL_API_KEY ??= process.env.LLM_API_KEY ?? 'dummy-key';
}

async function main(): Promise<void> {
  configureMidsceneModel();
  const gameRoute = ALLOWED_GAMES['games-in-olympus'];
  const gameUrl = new URL(gameRoute, SITE_ORIGIN).href;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let page: Page | undefined;
  let agent: PlaywrightPageAgent | undefined;
  let blockedDoSpinRequests = 0;

  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const context = browser.contexts()[0];
    if (!context) throw new Error('NO_EDGE_CONTEXT');

    // Use a new tab so the user's current Edge tab is not navigated or clicked.
    page = await context.newPage();
    const blockEverySpin = async (route: Route) => {
      const request = route.request();
      if (isDoSpinRequest(request.url(), request.postData())) {
        blockedDoSpinRequests++;
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    };
    // Install before navigation. This inspection script has no action API calls.
    await page.route('**/*', blockEverySpin);

    await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(12_000);

    // Create the agent after the initial navigation so its initialization
    // scripts are not interrupted by the browser's first document change.
    agent = new PlaywrightPageAgent(page, { cache: false });
    const visualObservation = await agent.aiQuery(
      'Read-only inspection. Describe only the visible slot game title, whether a game canvas is visible, the currently displayed stake if readable, and whether ante is on, off, or unknown. Do not include account balance or personal/account information. Do not click, type, scroll, or perform any action.'
    );

    console.log(JSON.stringify({
      status: 'READ_ONLY_INSPECTION_COMPLETE',
      route: gameRoute,
      blockedDoSpinRequests,
      visualObservation,
    }, null, 2));
  } finally {
    await agent?.destroy();
    await page?.close();
    // For a CDP connection, close disconnects this client; it does not launch a
    // second browser. No existing tab is closed by this script.
    await browser?.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^[A-Z0-9_]+$/.test(message)
    ? message
    : /image input is not supported|mmproj/i.test(message)
      ? 'MODEL_IMAGE_INPUT_UNSUPPORTED'
      : 'MIDSCENE_INSPECTION_FAILED';
  console.error(code);
  process.exitCode = 1;
});
