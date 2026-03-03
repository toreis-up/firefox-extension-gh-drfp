(async () => {
  try {
    const moduleUrl = browser.runtime.getURL("src/content/main.js");
    const module = await import(moduleUrl);
    module.start();
  } catch (error) {
    console.error("[pnpm-resolver] Failed to bootstrap content script", error);
  }
})();
