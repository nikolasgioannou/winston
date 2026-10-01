import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Repository, TagMutability } from "aws-cdk-lib/aws-ecr";
import type { Construct } from "constructs";
import type { Service } from "./secrets.ts";

/** Everything that ships as an image, one repository each: the services and ops. */
export const images = ["api", "agents", "gateway", "web", "ops"] as const;

export type Image = Service | "ops";

/**
 * What deploys build on (docs/design.md §19): the image repositories, which
 * exist before the Services stack so images can be pushed before the first
 * service starts. GitHub's deploy role joins it later.
 */
export class CiStack extends Stack {
  readonly repositories: Record<Image, Repository>;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.repositories = Object.fromEntries(
      images.map((image) => [
        image,
        new Repository(this, `${image}Repository`, {
          repositoryName: `winston/${image}`,
          // Tags are commit SHAs; a pushed tag never changes meaning.
          imageTagMutability: TagMutability.IMMUTABLE,
          imageScanOnPush: true,
          lifecycleRules: [
            {
              description: "Keep the last 30 images, enough to roll back",
              maxImageCount: 30,
            },
          ],
          removalPolicy: RemovalPolicy.RETAIN,
        }),
      ]),
    ) as Record<Image, Repository>;
  }
}
