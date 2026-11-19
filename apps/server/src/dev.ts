import runServer, { relaunchUnderApp } from "./index.js";
import { loadMergedConfig } from "@appsys/devtool-config";
import { logger } from "@appsys/devtool-shared";
import { DEV_UI_PATH } from "./dev-options.js";

void (async () => {
  try {
    if (await relaunchUnderApp((await loadMergedConfig()).config)) {
      return;
    }
    logger.setLevel("debug");
    await runServer({
      uiPath: DEV_UI_PATH,
      loadBalancer: false,
    });
  } catch (error) {
    logger.error("Server", "Dev", error instanceof Error ? error.message : "Unknown startup error");
    process.exit(1);
  }
})();
