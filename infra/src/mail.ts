import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import type { Bucket } from "aws-cdk-lib/aws-s3";
import {
  ConfigurationSet,
  EmailIdentity,
  EmailSendingEvent,
  EventDestination,
  Identity,
  MailFromBehaviorOnMxFailure,
  ReceiptRuleSet,
  TlsPolicy,
} from "aws-cdk-lib/aws-ses";
import { S3 } from "aws-cdk-lib/aws-ses-actions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { UrlSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from "aws-cdk-lib/custom-resources";
import type { Construct } from "constructs";

export interface MailStackProps extends StackProps {
  /** Winston's mail domain, `runwinston.email` (ead827). */
  mailDomain: string;
  /** The site's domain: SNS posts to its api. */
  domain: string;
  inboundMail: Bucket;
}

/**
 * Winston's own mail (docs/design.md §19, docs/runbooks/email.md): SES sends
 * from and receives for his domain. DNS is on Cloudflare, so the records SES
 * needs are added there by hand from this stack's outputs.
 */
export class MailStack extends Stack {
  /** Each received message, once SES has written it to the bucket. */
  readonly inbound: Topic;
  /** Bounces, complaints and deliveries of what he sends. */
  readonly sendingEvents: Topic;
  readonly configurationSet: ConfigurationSet;
  readonly identity: EmailIdentity;

  constructor(scope: Construct, id: string, props: MailStackProps) {
    super(scope, id, props);

    // SHA256 signatures, which the api verifies (SNS defaults to SHA1).
    this.inbound = new Topic(this, "Inbound", { signatureVersion: "2" });
    this.sendingEvents = new Topic(this, "SendingEvents", {
      signatureVersion: "2",
    });
    // The api confirms the subscription when SNS first posts (its own
    // signed confirmation), then gets each received message's notice.
    const webhook = `https://api.${props.domain}/webhooks/ses`;
    this.inbound.addSubscription(new UrlSubscription(webhook));
    this.sendingEvents.addSubscription(new UrlSubscription(webhook));

    this.configurationSet = new ConfigurationSet(this, "Sending");
    this.configurationSet.addEventDestination("Events", {
      destination: EventDestination.snsTopic(this.sendingEvents),
      events: [
        EmailSendingEvent.BOUNCE,
        EmailSendingEvent.COMPLAINT,
        EmailSendingEvent.DELIVERY,
      ],
    });

    // Easy DKIM (2048-bit) on the domain, and a MAIL FROM subdomain so SPF
    // aligns with it too.
    this.identity = new EmailIdentity(this, "Identity", {
      identity: Identity.domain(props.mailDomain),
      mailFromDomain: `mail.${props.mailDomain}`,
      mailFromBehaviorOnMxFailure: MailFromBehaviorOnMxFailure.REJECT_MESSAGE,
      configurationSet: this.configurationSet,
    });

    // Every address on the domain: the api decides whose mailbox it is.
    const ruleSet = new ReceiptRuleSet(this, "Receiving");
    ruleSet.addRule("ToWinston", {
      recipients: [props.mailDomain],
      scanEnabled: true,
      tlsPolicy: TlsPolicy.REQUIRE,
      actions: [
        new S3({
          bucket: props.inboundMail,
          objectKeyPrefix: "inbound/",
          topic: this.inbound,
        }),
      ],
    });
    // CloudFormation can't make a rule set the active one (one per account
    // and region), so an SDK call does, and clears it if the stack goes.
    new AwsCustomResource(this, "ActivateReceiving", {
      onUpdate: {
        service: "SES",
        action: "setActiveReceiptRuleSet",
        parameters: { RuleSetName: ruleSet.receiptRuleSetName },
        physicalResourceId: PhysicalResourceId.of("active-receipt-rule-set"),
      },
      onDelete: {
        service: "SES",
        action: "setActiveReceiptRuleSet",
        parameters: {},
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
      installLatestAwsSdk: false,
    });

    // The records to add in Cloudflare (docs/runbooks/email.md).
    this.identity.dkimRecords.forEach((record, i) => {
      new CfnOutput(this, `DkimRecord${String(i + 1)}`, {
        value: `${record.name} CNAME ${record.value}`,
      });
    });
  }
}
