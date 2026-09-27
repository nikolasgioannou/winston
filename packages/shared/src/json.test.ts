import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./json.ts";

describe("canonicalJson", () => {
  test("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("renders undefined as null", () => {
    expect(canonicalJson(undefined)).toBe("null");
  });
});
