import { expect, test } from "bun:test";
import { idPrefixes, newId } from "./ids.ts";

test("every entity has a distinct prefix", () => {
  const prefixes = Object.values(idPrefixes);
  expect(new Set(prefixes).size).toBe(prefixes.length);
});

test("newId uses the entity's prefix", () => {
  expect(newId("user")).toStartWith("usr_");
});
