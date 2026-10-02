import { describe, expect, test } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import { privateAddress } from "./self-url.ts";

const nic = (address: string, internal = false) =>
  ({ address, family: "IPv4", internal }) as NetworkInterfaceInfo;

describe("the gateway's own address", () => {
  test("is the task's private IPv4, never loopback or Fargate's metadata interface", () => {
    // As on Fargate: the metadata interface comes first.
    expect(
      privateAddress({
        lo: [nic("127.0.0.1", true)],
        eth0: [nic("169.254.172.2")],
        eth1: [nic("10.0.1.206")],
      }),
    ).toBe("10.0.1.206");
    expect(privateAddress({ eth0: [nic("169.254.172.2")] })).toBeUndefined();
  });
});
