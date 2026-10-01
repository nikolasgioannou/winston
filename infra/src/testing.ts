import { App } from "aws-cdk-lib";
import cdkContext from "../cdk.context.json";
import cdkJson from "../cdk.json";
import { defineStacks } from "./app.ts";

/**
 * The whole app as `cdk synth` builds it: `cdk.json`'s feature flags, the
 * committed lookups in `cdk.context.json`, and version reporting, which the
 * CLI turns on by default (it's what keeps empty stacks valid).
 */
export function testApp() {
  const app = new App({
    context: { ...cdkJson.context, ...cdkContext },
    analyticsReporting: true,
  });
  return { app, stacks: defineStacks(app) };
}
