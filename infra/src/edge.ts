import { Stack, type StackProps } from "aws-cdk-lib";
import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import type { Construct } from "constructs";

export interface EdgeStackProps extends StackProps {
  domain: string;
}

/**
 * The certificate (docs/design.md §19). DNS is on Cloudflare, so it's
 * validated by CNAME records added there (docs/runbooks/dns.md). CloudFront
 * lives in the Services stack, next to its origin: here it would make a
 * cycle, since the load balancer uses this certificate.
 */
export class EdgeStack extends Stack {
  /** The site, the API and the gateway; in us-east-1, as CloudFront requires. */
  readonly certificate: Certificate;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    this.certificate = new Certificate(this, "Certificate", {
      domainName: props.domain,
      subjectAlternativeNames: [
        `api.${props.domain}`,
        `gateway.${props.domain}`,
      ],
      validation: CertificateValidation.fromDns(),
    });
  }
}
