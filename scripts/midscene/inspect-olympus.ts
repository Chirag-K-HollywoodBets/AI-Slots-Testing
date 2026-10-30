import { PlaywrightPageAgent } from '@midscene/web/playwright';
import { chromium, type Page, type Route } from 'playwright';
import { readFile } from 'node:fs/promises';
import { ALLOWED_GAMES } from '../../src/agent/schema';
import { isDoSpinRequest } from '../../src/agent/midscene-slot-guard';

const SITE_ORIGIN = 'https://www.hollywoodbets.net';
const CDP_ENDPOINT = 'http://127.0.0.1:9223';

export function classifyMidsceneError(error: unknown): 'MODEL_UNAVAILABLE' | 'MODEL_IMAGE_INPUT_UNSUPPORTED' | 'MIDSCENE_INSPECTION_FAILED' {
  const message = error instanceof Error ? error.message : String(error);
  if (/image input is not supported|image_url|vision.*not supported|does not support.*image|mmproj/i.test(message)) return 'MODEL_IMAGE_INPUT_UNSUPPORTED';
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|model.*not found|unknown model|401|404/i.test(message)) return 'MODEL_UNAVAILABLE';
  return 'MIDSCENE_INSPECTION_FAILED';
}

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
  if (process.argv.includes('--check-model')) {
    const baseUrl = process.env.MIDSCENE_MODEL_BASE_URL;
    const model = process.env.MIDSCENE_MODEL_NAME;
    if (!baseUrl || !model) {
      console.log(JSON.stringify({ status: 'MODEL_UNAVAILABLE', success: false, error: 'MODEL_UNAVAILABLE', reason: 'Model endpoint or model ID is missing.' }));
      return;
    }
    try {
      const response = await fetch(new URL('/models', baseUrl), { headers: process.env.MIDSCENE_MODEL_API_KEY
        ? { Authorization: 'Bearer ' + process.env.MIDSCENE_MODEL_API_KEY } : {}, signal: AbortSignal.timeout(5000) });
      const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
      const available = response.ok && (!Array.isArray(payload.data) || payload.data.some((entry) => entry.id === model));
      console.log(JSON.stringify({ status: available ? 'MODEL_READY' : 'MODEL_UNAVAILABLE', success: available,
        model, endpoint: baseUrl, ...(available ? {} : { error: 'MODEL_UNAVAILABLE' }) }));
    } catch {
      console.log(JSON.stringify({ status: 'MODEL_UNAVAILABLE', success: false, error: 'MODEL_UNAVAILABLE', model, endpoint: baseUrl }));
    }
    return;
  }
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
    const screenshotPath = process.env.MIDSCENE_SCREENSHOT_PATH;
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: false });

    // Create the agent after the initial navigation so its initialization
    // scripts are not interrupted by the browser's first document change.
    agent = new PlaywrightPageAgent(page, { cache: false });
    const visualObservation = await agent.aiQuery(process.env.MIDSCENE_INSTRUCTION ||
      'Read-only inspection. Describe only the visible slot game title, whether a game canvas is visible, the currently displayed stake if readable, and whether ante is on, off, or unknown. Do not include account balance or personal/account information. Do not click, type, scroll, or perform any action.');

    console.log('MIDSCENE_RESULT:' + JSON.stringify({
      status: 'READ_ONLY_INSPECTION_COMPLETE', success: true, mode: 'SLOTS_INSPECT',
      route: gameRoute,
      blockedDoSpinRequests,
      visualObservation,
      screenshot: screenshotPath ? (await readFile(screenshotPath)).toString('base64') : null,
    }));
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
  const code = classifyMidsceneError(error);
  console.log('MIDSCENE_RESULT:' + JSON.stringify({ status: code, success: false, mode: 'SLOTS_INSPECT', error: code, logs: message.slice(0, 2000) }));
});
