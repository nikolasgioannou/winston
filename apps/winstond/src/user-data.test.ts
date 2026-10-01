import { afterAll, describe, expect, test } from "bun:test";
import { readUserData } from "./user-data.ts";

/** A stand-in for the metadata service, IMDSv2 only, serving `userData`. */
function fakeImds(userData: string | undefined) {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/latest/api/token" && request.method === "PUT")
        return new Response("session-token");
      if (pathname === "/latest/user-data") {
        if (request.headers.get("X-aws-ec2-metadata-token") !== "session-token")
          return new Response("unauthorized", { status: 401 });
        return userData === undefined
          ? new Response("not found", { status: 404 })
          : new Response(userData);
      }
      return new Response("not found", { status: 404 });
    },
  });
}

const servers: ReturnType<typeof fakeImds>[] = [];
const url = (userData: string | undefined) => {
  const server = fakeImds(userData);
  servers.push(server);
  return server.url.origin;
};
afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
});

describe("readUserData", () => {
  test("reads the settings through an IMDSv2 session", async () => {
    const data = JSON.stringify({
      winston: {
        gatewayUrl: "wss://gateway.runwinston.com",
        registrationToken: "reg_123",
      },
    });
    expect(await readUserData(url(data))).toEqual({
      gatewayUrl: "wss://gateway.runwinston.com",
      registrationToken: "reg_123",
    });
  });

  test("is empty without user data, with other user data, or with no metadata service", async () => {
    expect(await readUserData(url(undefined))).toEqual({});
    expect(await readUserData(url("#!/bin/bash\necho hi"))).toEqual({});
    expect(await readUserData(url("{}"))).toEqual({
      gatewayUrl: undefined,
      registrationToken: undefined,
    });
    // Nothing listening: fails fast instead of hanging winstond's start.
    const started = Date.now();
    expect(await readUserData("http://127.0.0.1:9")).toEqual({});
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
