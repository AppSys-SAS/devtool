import runServer from "./index.js";
import { logger } from "@appsys/devtool-shared";

void (async () => {
  try {
    logger.setLevel("debug");
    await runServer({
      uiPath: process.env.DEVTOOL_UI_PATH ?? null,
    });
  } catch (error) {
    logger.error("Server", "Dev", error instanceof Error ? error.message : "Unknown startup error");
    process.exit(1);
  }
})();
