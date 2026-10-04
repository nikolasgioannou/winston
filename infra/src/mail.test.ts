import { describe, expect, test } from "bun:test";
import { Match, Template } from "aws-cdk-lib/assertions";
import { testApp } from "./testing.ts";

describe("mail stack", () => {
  const { stacks } = testApp();
  const template = Template.fromStack(stacks.mail);

  test("sends from runwinston.email with Easy DKIM, a MAIL FROM subdomain and its configuration set", () => {
    template.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "runwinston.email",
      MailFromAttributes: {
        MailFromDomain: "mail.runwinston.email",
        BehaviorOnMxFailure: "REJECT_MESSAGE",
      },
      ConfigurationSetAttributes: { ConfigurationSetName: Match.anyValue() },
    });
    template.hasResourceProperties(
      "AWS::SES::ConfigurationSetEventDestination",
      {
        EventDestination: Match.objectLike({
          Enabled: true,
          MatchingEventTypes: ["bounce", "complaint", "delivery"],
        }),
      },
    );
  });

  test("receives every address on the domain into the bucket, scanned and over TLS, and announces it", () => {
    template.hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({
        Recipients: ["runwinston.email"],
        ScanEnabled: true,
        TlsPolicy: "Require",
        Actions: [
          {
            S3Action: Match.objectLike({
              ObjectKeyPrefix: "inbound/",
              TopicArn: Match.anyValue(),
            }),
          },
        ],
      }),
    });
    template.resourceCountIs("Custom::AWS", 1);
  });

  test("received mail, bounces and complaints are announced to the api's webhook", () => {
    template.resourcePropertiesCountIs(
      "AWS::SNS::Subscription",
      {
        Protocol: "https",
        Endpoint: "https://api.runwinston.com/webhooks/ses",
      },
      2,
    );
  });

  test("its topics sign with SHA256", () => {
    const topics = Object.values(template.findResources("AWS::SNS::Topic"));
    expect(topics).toHaveLength(2);
    for (const topic of topics)
      expect(
        (topic as { Properties: { SignatureVersion: string } }).Properties
          .SignatureVersion,
      ).toBe("2");
  });

  test("outputs the three DKIM records to add in Cloudflare", () => {
    const outputs = Object.keys(template.findOutputs("*"));
    expect(
      outputs.filter((name) => name.startsWith("DkimRecord")),
    ).toHaveLength(3);
  });
});
