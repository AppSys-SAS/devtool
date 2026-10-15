import runServer from "./index.js";
import { logger } from "@appsys/devtool-shared";
import { DEV_UI_PATH } from "./dev-options.js";

void (async () => {
  try {
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
