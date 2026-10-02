import type { NetworkInterfaceInfo } from "node:os";

/**
 * The address other services reach this task at: its first private IPv4.
 * Skips loopback and link-local (169.254.0.0/16): on Fargate that's the
 * task metadata interface, which nothing else can reach.
 */
export function privateAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
) {
  return Object.values(interfaces)
    .flat()
    .find(
      (nic) =>
        nic?.family === "IPv4" &&
        !nic.internal &&
        !nic.address.startsWith("169.254."),
    )?.address;
}
