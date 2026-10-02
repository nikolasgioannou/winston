import { describe, expect, test } from "bun:test";
import { createLogger } from "@winston/shared/logger";
import { chromeWatch, createChromeWatch } from "./chrome-watch.ts";

const logger = createLogger("winstond-test", {
  pretty: false,
  destination: { write: () => undefined },
});

function setup(answers: boolean[]) {
  let clock = 0;
  let restarts = 0;
  const check = createChromeWatch({
    probe: () => Promise.resolve(answers.shift() ?? true),
    restart: () => {
      restarts += 1;
      return Promise.resolve();
    },
    logger,
    now: () => clock,
  });
  return {
    /** Moves the clock one interval on, then checks. */
    tick: async () => {
      clock += chromeWatch.everyMs;
      return check();
    },
    restarts: () => restarts,
  };
}

describe("the Chrome watch", () => {
  test("one missed answer waits; 60 s without one restarts Chrome, once", async () => {
    const watch = setup([false, false, false, false]);
    expect(await watch.tick()).toBe("waiting");
    expect(await watch.tick()).toBe("restarted");
    // The new Chrome gets a full window before it's judged.
    expect(await watch.tick()).toBe("waiting");
    expect(watch.restarts()).toBe(1);
  });

  test("an answer in between resets the clock", async () => {
    const watch = setup([false, true, false, true]);
    for (let i = 0; i < 4; i += 1) await watch.tick();
    expect(watch.restarts()).toBe(0);
  });
});
