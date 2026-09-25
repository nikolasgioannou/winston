import { createServer } from "node:net";

export async function checkDevelopmentPort(port: number) {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => {
        reject(
          new Error(
            `Local port ${String(port)} is unavailable. Stop its existing development service before starting the stack.`,
          ),
        );
      });
      server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
  }
}
