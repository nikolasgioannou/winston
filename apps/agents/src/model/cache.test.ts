import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { cacheBreakpoint, withRollingBreakpoint } from "./cache.ts";

describe("cache breakpoints", () => {
  test("default to five minutes; an hour adds the ttl", () => {
    expect(
      cacheBreakpoint<ModelMessage>({ role: "system", content: "x" })
        .providerOptions,
    ).toEqual({ openrouter: { cacheControl: { type: "ephemeral" } } });
    expect(
      cacheBreakpoint<ModelMessage>({ role: "system", content: "x" }, "1h")
        .providerOptions,
    ).toEqual({
      openrouter: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });

  test("the rolling marker goes on the last text part of a user message, with its ttl", () => {
    const [first, last] = withRollingBreakpoint(
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
      "1h",
    );
    expect(first).toEqual({ role: "user", content: "a" });
    expect(last).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "b",
          providerOptions: {
            openrouter: { cacheControl: { type: "ephemeral", ttl: "1h" } },
          },
        },
      ],
    });
  });
});
