import { describe, expect, test } from "bun:test";
import { Template } from "aws-cdk-lib/assertions";
import { production } from "./app.ts";
import { testApp } from "./testing.ts";

describe("infra app", () => {
  const { app, stacks } = testApp();

  test("synthesizes cleanly, including CloudFormation validation", () => {
    expect(() => app.synth()).not.toThrow();
  });

  test("every stack is for winston-prod in us-east-1", () => {
    for (const stack of Object.values(stacks)) {
      Template.fromStack(stack);
      expect(stack.account).toBe(production.account);
      expect(stack.region).toBe(production.region);
    }
    expect(Object.values(stacks).map((stack) => stack.stackName)).toEqual([
      "winston-network",
      "winston-data",
      "winston-services",
      "winston-edge",
      "winston-vm",
      "winston-ci",
      "winston-budget",
    ]);
  });

  test("only the stateful stack has termination protection", () => {
    const protectedStacks = Object.values(stacks).filter(
      (stack) => stack.terminationProtection,
    );
    expect(protectedStacks).toEqual([stacks.data]);
  });
});
