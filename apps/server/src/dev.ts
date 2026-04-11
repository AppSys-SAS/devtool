import runServer from "./index.js";
import { logger } from "@appsys/devtool-shared";

const DEFAULT_UI_DEV_URL = "http://127.0.0.1:6731";

void (async () => {
  try {
    logger.setLevel("debug");
    await runServer({
      uiPath: process.env.DEVTOOL_UI_PATH ?? DEFAULT_UI_DEV_URL,
    });
  } catch (error) {
    logger.error("Server", "Dev", error instanceof Error ? error.message : "Unknown startup error");
    process.exit(1);
  }
})();
