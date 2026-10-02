import { describe, expect, test } from "bun:test";
import { apiErrors } from "@winston/domain/api-errors";
import { createLocks, lockDomain, lockTtlMs } from "./locks.ts";
import { BrowserFailure } from "./state.ts";

describe("domain locks", () => {
  test("a lock is per registrable domain; blank and local pages need none", () => {
    expect(lockDomain("https://www.amazon.com/cart")).toBe("amazon.com");
    expect(lockDomain("https://smile.amazon.com/")).toBe("amazon.com");
    expect(lockDomain("https://shop.example.co.uk/")).toBe("example.co.uk");
    expect(lockDomain("https://ada.github.io/")).toBe("ada.github.io");
    expect(lockDomain("http://localhost:8001/a.html")).toBe("localhost");
    expect(lockDomain("about:blank")).toBeUndefined();
    expect(lockDomain("data:text/html,hi")).toBeUndefined();
  });

  test("another run is refused with exit 6, naming the holder; the holder renews it", () => {
    let clock = 0;
    const locks = createLocks(() => clock);
    expect(locks.acquire("https://www.amazon.com", "run_a", "win_a")).toBe(
      "amazon.com",
    );
    let refused: unknown;
    try {
      locks.acquire("https://smile.amazon.com", "run_b", "win_b");
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(BrowserFailure);
    const failure = refused as BrowserFailure;
    expect(apiErrors[failure.code].exitCode).toBe(6);
    expect(failure.message).toBe(
      "amazon.com is in use by task run_a (win_a), for up to 5 more min.",
    );
    // The front of house reads as itself.
    locks.acquire("https://mail.google.com", "front", "win_f");
    expect(() => locks.acquire("https://google.com", "run_b", "win_b")).toThrow(
      "google.com is in use by the front of house (win_f)",
    );
    clock += lockTtlMs - 1000;
    locks.acquire("https://www.amazon.com/orders", "run_a", "win_a");
    clock += 2000;
    // Renewed, so still held.
    expect(() =>
      locks.acquire("https://amazon.com", "run_b", "win_b"),
    ).toThrow();
    expect(locks.heldFrom("win_a")).toEqual(["amazon.com"]);
  });

  test("a lock lapses after its time, and goes when its run is released", () => {
    let clock = 0;
    const locks = createLocks(() => clock);
    locks.acquire("https://a.test", "run_a", "win_a");
    locks.acquire("https://b.test", "run_a", "win_a");
    clock += lockTtlMs;
    expect(locks.acquire("https://a.test", "run_b", "win_b")).toBe("a.test");
    locks.release("run_b");
    locks.release("run_a");
    expect(locks.heldFrom("win_a")).toEqual([]);
    expect(locks.acquire("https://b.test", "run_c", "win_c")).toBe("b.test");
  });
});
