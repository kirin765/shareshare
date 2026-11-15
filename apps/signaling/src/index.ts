import { loadConfig } from "./config.js";
import { createSignalingServer } from "./server.js";

const config = loadConfig();
const server = createSignalingServer(config);

const port = await server.listen();
config.logger.info("listening", {
  port,
  origins: config.allowedOrigins.join(" "),
  turnConfigured: config.turnUrls.length > 0,
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  config.logger.info("shutting_down", { signal });
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
