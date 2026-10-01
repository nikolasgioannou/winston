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
      Object.keys(secrets)
        .map((name) => `winston/${name}`)
        .sort(),
    );
    for (const resource of Object.values(resources))
      expect(resource.DeletionPolicy).toBe("Retain");
  });

  test("services see only what they need", () => {
    expect(namesFor("web").has("telegram-bot-token")).toBe(false);
    expect(namesFor("gateway").has("openrouter-api-key")).toBe(false);
    expect([...namesFor("gateway")].sort()).toEqual([
      "gateway-internal-secret",
      "run-token-secret",
    ]);
    // Only the site signs people in with Google today.
    for (const service of ["api", "agents", "gateway"] as const)
      expect(namesFor(service).has("google-oauth")).toBe(false);
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
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
    ]);
    const clientId = stacks.services.resolve(
      environment.GOOGLE_OAUTH_CLIENT_ID?.arn,
    ) as unknown;
    expect(JSON.stringify(clientId)).toContain(":clientId::");
  });
});
