const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);

(async () => {
  let browser;

  try {
    browser = await chromium.connectOverCDP(
      "http://127.0.0.1:9222"
    );

    console.log("Connected to Edge through CDP.");

    const contexts = browser.contexts();
    console.log("Browser contexts:", contexts.length);

    const pages = contexts.flatMap(context => context.pages());

    console.log("Open pages:", pages.length);

    for (const page of pages) {
      console.log("Page URL:", page.url());
      console.log("Page title:", await page.title());
    }

    const page = pages.find(p =>
      p.url().includes("hollywoodbets.net")
    );

    if (page) {
      const result = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyTextLength: document.body?.innerText?.length ?? 0
      }));

      console.log("HollywoodBets page check:");
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("No HollywoodBets page found in attached contexts.");
    }
  } catch (error) {
    console.error("CDP attachment test failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
      console.log("Detached from Edge.");
    }
  }
})();
