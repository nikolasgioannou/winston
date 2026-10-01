import { describe, test } from "bun:test";
import { Template } from "aws-cdk-lib/assertions";
import { testApp } from "./testing.ts";

describe("edge stack", () => {
  const { stacks } = testApp();
  const template = Template.fromStack(stacks.edge);

  test("one DNS-validated certificate covers the site, the API and the gateway", () => {
    template.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    template.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "runwinston.com",
      SubjectAlternativeNames: ["api.runwinston.com", "gateway.runwinston.com"],
      ValidationMethod: "DNS",
    });
  });
});
