const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: false
  });

  try {
    const page = await browser.newPage();

    page.on("requestfailed", request => {
      const url = request.url();
      const error = request.failure()?.errorText || "";

      if (/sport|api|match|event/i.test(url) ||
          /local network|private network|blocked/i.test(error)) {
        console.log("RELEVANT REQUEST FAILED:", url, error);
      }
    });

    page.on("response", response => {
      const url = response.url();

      if (/sport|api|match|event/i.test(url)) {
        console.log("API RESPONSE:", response.status(), url);
      }
    });

    await page.goto("https://www.hollywoodbets.net/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(15000);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
