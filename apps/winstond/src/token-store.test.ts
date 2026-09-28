import { describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenStore } from "./token-store.ts";

describe("tokenStore", () => {
  test("reads nothing before the first write, then the token, stored 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "winstond-"));
    const store = tokenStore(join(dir, "token"));
    expect(await store.read()).toBeUndefined();
    await store.write("vm-token-1");
    expect(await store.read()).toBe("vm-token-1");
    expect((await stat(join(dir, "token"))).mode & 0o777).toBe(0o600);
    await store.write("vm-token-2");
    expect(await store.read()).toBe("vm-token-2");
  });
});
