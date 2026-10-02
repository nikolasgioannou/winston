/**
 * Domain locks (docs/design.md §5 Browser): every agent shares one
 * logged-in profile, so only one run acts on a website at a time, or two
 * tasks would fight over the same cart or login. A lock is per registrable
 * domain (eTLD+1 from the Public Suffix List, via tldts: `www.amazon.com`
 * and `smile.amazon.com` are both `amazon.com`; `you.github.io` is its own).
 *
 * A lock belongs to a run and lasts while it keeps acting there: each
 * acting command renews it for five minutes. It goes when the run's windows
 * all close, or when it lapses, so a crashed run never holds a site for good.
 * Looking (snapshot, screenshot, peeks) never takes one.
 */
import { getDomain } from "tldts";
import { BrowserFailure } from "./state.ts";

export const lockTtlMs = 5 * 60_000;

/** The lock a URL needs: its registrable domain, its host when there's none, nothing for blank pages. */
export function lockDomain(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return undefined;
  // An IP address or `localhost` has no registrable domain: lock the host.
  return (
    getDomain(parsed.hostname, { allowPrivateDomains: true }) ?? parsed.hostname
  );
}

interface Lock {
  owner: string;
  /** The window that acted there last. */
  windowId: string;
  expiresAt: number;
}

/** How an owner reads in a message. */
const whose = (owner: string) =>
  owner === "front" ? "the front of house" : `task ${owner}`;

export function createLocks(now: () => number) {
  const locks = new Map<string, Lock>();

  const live = (domain: string) => {
    const lock = locks.get(domain);
    if (lock && lock.expiresAt <= now()) {
      locks.delete(domain);
      return undefined;
    }
    return lock;
  };

  return {
    /**
     * Takes (or renews) the lock for acting on `url` from a window. Fails
     * with exit 6, naming the holder, when another run has it.
     */
    acquire(url: string, owner: string, windowId: string) {
      const domain = lockDomain(url);
      if (!domain) return undefined;
      const held = live(domain);
      if (held && held.owner !== owner) {
        const minutes = Math.max(
          1,
          Math.ceil((held.expiresAt - now()) / 60_000),
        );
        throw new BrowserFailure(
          "conflict",
          `${domain} is in use by ${whose(held.owner)} (${held.windowId}), for up to ${String(minutes)} more min.`,
          "Only one task acts on a site at a time. Wait and try again, or work on something else meanwhile.",
        );
      }
      locks.set(domain, { owner, windowId, expiresAt: now() + lockTtlMs });
      return domain;
    },

    /**
     * Keeps a run's locks while the user has its window (a handoff): they
     * don't lapse until `unpin`, so no other task takes the site meanwhile.
     */
    pin(owner: string) {
      for (const lock of locks.values())
        if (lock.owner === owner) lock.expiresAt = Infinity;
    },

    /** The handoff is over: the run's locks lapse as usual again. */
    unpin(owner: string) {
      for (const lock of locks.values())
        if (lock.owner === owner && lock.expiresAt === Infinity)
          lock.expiresAt = now() + lockTtlMs;
    },

    /** Frees every lock a run holds (its windows are all closed). */
    release(owner: string) {
      for (const [domain, lock] of locks)
        if (lock.owner === owner) locks.delete(domain);
    },

    /** The domains locked from a window, for `browser windows`. */
    heldFrom(windowId: string) {
      return [...locks.keys()]
        .filter((domain) => live(domain)?.windowId === windowId)
        .sort();
    },
  };
}
