import { RemovalPolicy } from "aws-cdk-lib";
import { Secret as EcsSecret } from "aws-cdk-lib/aws-ecs";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

import {
  secrets,
  serviceSecrets,
  type SecretName,
  type SecretRef,
  type Service,
} from "./secret-names.ts";

export { secrets, serviceSecrets };
export type { SecretName, SecretRef, Service };

/** The Secrets Manager secrets, and each service's ECS secret environment. */
export class Secrets extends Construct {
  readonly byName: Record<SecretName, Secret>;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const entries = Object.entries(secrets).map(([name, { generated }]) => [
      name,
      new Secret(this, name, {
        secretName: `winston/${name}`,
        description: generated
          ? "Generated at creation"
          : "Set out of band (docs/runbooks/secrets.md)",
        // Letters and digits, the format the services' configs accept.
        generateSecretString: { excludePunctuation: true, passwordLength: 48 },
        removalPolicy: RemovalPolicy.RETAIN,
      }),
    ]);
    this.byName = Object.fromEntries(entries) as Record<SecretName, Secret>;
  }

  /** The secrets a service's task definition injects, by variable name. */
  environmentFor(service: Service): Record<string, EcsSecret> {
    return Object.fromEntries(
      Object.entries(serviceSecrets[service] as Record<string, SecretRef>).map(
        ([variable, ref]) => {
          const [name, field] = typeof ref === "string" ? [ref] : ref;
          return [
            variable,
            EcsSecret.fromSecretsManager(this.byName[name], field),
          ];
        },
      ),
    );
  }
}
