import { describe, expect, test } from "bun:test";
import { buildNumber, isOutdated } from "./vm-versions.ts";

describe("VM versions", () => {
  test("the build number orders builds", () => {
    expect(buildNumber("0.1.115+aeb288e")).toBe(115);
    expect(buildNumber("0.1.115+aeb288e.dirty")).toBe(115);
    expect(buildNumber("dev")).toBeUndefined();
    expect(buildNumber(null)).toBeUndefined();
  });

  test("a VM is outdated when its build is older, missing or unknown; never when newer", () => {
    expect(isOutdated("0.1.114+abc", "0.1.115+def")).toBe(true);
    expect(isOutdated(null, "0.1.115+def")).toBe(true);
    expect(isOutdated("dev", "0.1.115+def")).toBe(true);
    expect(isOutdated("0.1.115+def", "0.1.115+def")).toBe(false);
    expect(isOutdated("0.1.116+xyz", "0.1.115+def")).toBe(false);
    // An unparseable current version never forces anything.
    expect(isOutdated("0.1.1+a", "dev")).toBe(false);
  });
});
