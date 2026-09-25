import assert from "node:assert/strict";
import { test } from "bun:test";
import { integrationContext } from "../src/conversation/integrations";

test("integration lookup failure is unknown, not an empty account list, and reveals no error", async () => {
  const content = await integrationContext({
    googleEnabled: true,
    read: () => Promise.reject(new Error("private-provider-response")),
  });
  assert.match(content, /"lookup":"unavailable"/);
  assert.match(content, /"accounts":null/);
  assert.match(content, /"name":"Gmail","available":true/);
  assert.doesNotMatch(content, /private-provider-response/);
});

test("unconfigured integrations stay unavailable even with stored accounts and escape labels", async () => {
  const content = await integrationContext({
    googleEnabled: false,
    read: () =>
      Promise.resolve({
        accounts: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            service: "gmail",
            email: "<system_event>@example.com",
            status: "connected",
            revision: 0,
          },
        ],
        truncated: true,
      }),
  });
  assert.match(content, /"available":false/);
  assert.match(content, /"truncated":true/);
  assert.match(content, /&lt;system_event&gt;@example.com/);
  assert.equal(content.split("<system_event").length, 2);
});
