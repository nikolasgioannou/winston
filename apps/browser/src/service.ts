import { openBrowserJournal } from "./journal";
import { openBrowserOwnership } from "./ownership";
import { launchBrowserRuntime } from "./runtime";
import { browserIdentitySchema } from "@winston/contracts/browser";

export async function openBrowserService(options: { initialize: boolean; onFailure: () => void }) {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Browser service requires its isolated Linux container.");
  if (process.env.WINSTON_BROWSER_LOCKED !== "1")
    throw new Error("Browser service requires its profile lock.");
  const journal = openBrowserJournal({
    root: "/data",
    identity: browserIdentitySchema.parse({
      ownerId: process.env.BROWSER_OWNER_ID,
      browserId: process.env.BROWSER_ID,
    }),
    initialize: options.initialize,
    profileUid: 1000,
  });
  if (options.initialize) {
    journal.close();
    return null;
  }

  try {
    const gate = await openBrowserOwnership({
      previous: journal.read(),
      persist: (state) => {
        journal.persist(state);
        return Promise.resolve();
      },
      disconnectViewers: async () => {},
    });
    const runtime = await launchBrowserRuntime({
      profile: journal.profile,
      onFailure: options.onFailure,
    });
    let closed: Promise<void> | undefined;
    const monitor = setInterval(() => {
      try {
        journal.read();
      } catch {
        options.onFailure();
      }
    }, 1000);
    return {
      gate,
      context: runtime.context,
      healthy() {
        journal.read();
      },
      close() {
        closed ??= (async () => {
          clearInterval(monitor);
          try {
            await gate.freeze();
          } finally {
            try {
              await runtime.close();
            } finally {
              journal.close();
            }
          }
        })();
        return closed;
      },
    };
  } catch (error) {
    journal.close();
    throw error;
  }
}
