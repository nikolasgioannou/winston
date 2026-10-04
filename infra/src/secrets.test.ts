import { describe, expect, test } from "bun:test";
import { Template } from "aws-cdk-lib/assertions";
import { secrets, serviceSecrets, type SecretRef } from "./secrets.ts";
import { testApp } from "./testing.ts";

/** The secret names a service can read. */
const namesFor = (service: keyof typeof serviceSecrets) =>
  new Set(
    Object.values(serviceSecrets[service] as Record<string, SecretRef>).map(
      (ref) => (typeof ref === "string" ? ref : ref[0]),
    ),
  );

describe("secrets", () => {
  const { stacks } = testApp();
  const template = Template.fromStack(stacks.services);

  test("each secret exists once, named winston/<name>, and is retained", () => {
    const resources = template.findResources("AWS::SecretsManager::Secret");
    const names = Object.values(resources).map(
      (resource) => (resource.Properties as { Name: string }).Name,
    );
    expect(names.sort()).toEqual(
      [
        ...Object.keys(secrets).map((name) => `winston/${name}`),
        // CloudFront's origin header, which no service reads.
        "winston/cloudfront-origin-header",
      ].sort(),
    );
    for (const resource of Object.values(resources))
      expect(resource.DeletionPolicy).toBe("Retain");
  });

  test("services see only what they need", () => {
    expect(namesFor("web").has("telegram-bot-token")).toBe(false);
    expect(namesFor("api").has("openrouter-api-key")).toBe(false);
    // The gateway's OpenRouter key is for Jev (the browser's autopilot).
    expect([...namesFor("gateway")].sort()).toEqual([
      "cloudflare-api-token",
      "gateway-internal-secret",
      "google-oauth",
      "openrouter-api-key",
      "run-token-secret",
      "sites-pass-key",
    ]);
    // Only the services that sign passes hold the key that signs them (§9a).
    expect(namesFor("agents").has("sites-pass-key")).toBe(false);
    expect(namesFor("api").has("cloudflare-api-token")).toBe(false);
    // The site signs people in; the gateway and agents refresh connected
    // accounts' tokens (connector calls; watches and syncs). api never does.
    expect(namesFor("api").has("google-oauth")).toBe(false);
    expect(namesFor("agents").has("google-oauth")).toBe(true);
  });

  test("every secret is used by some service", () => {
    const used = new Set<string>(
      (Object.keys(serviceSecrets) as (keyof typeof serviceSecrets)[]).flatMap(
        (service) => [...namesFor(service)],
      ),
    );
    expect([...used].sort()).toEqual(Object.keys(secrets).sort());
  });

  test("a service's ECS environment maps each variable to its secret", () => {
    const environment = stacks.services.secrets.environmentFor("web");
    expect(Object.keys(environment).sort()).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "SITES_PASS_KEY",
      "TELEGRAM_LOGIN_KEY",
    ]);
    const clientId = stacks.services.resolve(
      environment.GOOGLE_OAUTH_CLIENT_ID?.arn,
    ) as unknown;
    expect(JSON.stringify(clientId)).toContain(":clientId::");
  });
});
