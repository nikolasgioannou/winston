// Protected application composition root; implemented by the API host ticket.
import { readConfig } from "./config";
import { startServer } from "./host";

const host = startServer(readConfig(process.env), {
  log: (entry) => {
    console.log(JSON.stringify(entry));
  },
});

function shutdown() {
  host.stop().catch(() => {
    console.error("Server shutdown failed.");
    process.exitCode = 1;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
