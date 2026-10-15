import { runLoadBalancer } from "./index.js";
import { logger } from "@appsys/devtool-shared";
import { DEV_UI_PATH } from "./dev-options.js";

void (async () => {
  try {
    logger.setLevel("debug");
    await runLoadBalancer({
      uiPath: DEV_UI_PATH,
    });
  } catch (error) {
    logger.error("LoadBalancer", "Dev", error instanceof Error ? error.message : "Unknown startup error");
    process.exit(1);
  }
})();
