# AWS access

How Winston's AWS account is set up and how to reach it. Winston runs in its own account, `winston-prod`, inside the maintainer's AWS Organization, and people reach it through IAM Identity Center with short-lived credentials (docs/design.md §8, Account isolation). Nothing here is a secret; credentials never go in the repo.

## What exists

| Thing                  | Value                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Organization           | `o-ciz5sttdch`, all features, created 2026-08-30                                        |
| Management account     | `455012390085` (`ni@nikolas.ai`): billing and the org only, no workloads                |
| Winston OU             | `Winston` (`ou-zgs0-16tzfoqu`), one OU per project like the maintainer's others         |
| `winston-prod`         | `766577085959` (`ni+winston-prod@nikolas.ai`), in the Winston OU                        |
| Region                 | `us-east-1`, for Winston and for Identity Center                                        |
| Identity Center        | organization instance in `us-east-1`, Identity Center directory as the identity source  |
| Access portal          | `https://d-90667d3ddb.awsapps.com/start`                                                |
| User                   | `ni@nikolas.ai`, with MFA                                                               |
| Permission set         | `AdministratorAccess` (AWS managed policy, 1-hour sessions), assigned on `winston-prod` |
| Service control policy | `DenyLeaveAndCloseAccount` on the root, besides the default `FullAWSAccess`             |
| Root access            | centralized root access management is on; `winston-prod` has no root password           |

## Logging in

The AWS CLI is pinned in `mise.toml` (`setup.sh` installs it). Profiles live in `~/.aws/config`:

```ini
[profile winston-prod]
sso_session = winston
sso_account_id = 766577085959
sso_role_name = AdministratorAccess
region = us-east-1

[sso-session winston]
sso_start_url = https://d-90667d3ddb.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access
```

Create it with `aws configure sso`: session name `winston`, the start URL and region above, account `winston-prod`, profile name `winston-prod`. Sign in with your Identity Center user, not the account name or the root user.

Day to day:

```sh
aws sso login --profile winston-prod
aws sts get-caller-identity --profile winston-prod   # account 766577085959
```

The `sso-session` form refreshes role credentials for as long as the portal session lasts (8 hours by default), and `aws sso logout` ends it. The AWS SDK and CDK take the profile from `--profile` or `AWS_PROFILE`, never from the login alone, so set `AWS_PROFILE=winston-prod` when running scripts against production.

## CDK

The CDK app in `infra/` deploys to this account (docs/design.md §19). From the repo root, with the profile logged in:

```sh
AWS_PROFILE=winston-prod bun run infra:diff     # what would change
AWS_PROFILE=winston-prod bun run infra:deploy   # deploy every stack
```

The account was bootstrapped once for CDK, which created the `CDKToolkit` stack (an assets bucket, an image repository, the deploy roles and a version parameter):

```sh
cd infra && bunx cdk bootstrap aws://766577085959/us-east-1 --termination-protection --profile winston-prod
```

Running it again upgrades the bootstrap stack in place; never delete it. GitHub's deploy role gets trusted later (the `Ci` stack).

## How it was set up

The Organization, Identity Center, the user and the permission set already existed for the maintainer's other projects, so Winston reused them. In the management account's console:

1. **OU:** AWS Organizations → select Root → Actions → Organizational unit → Create new → `Winston`.
2. **Account:** Add an AWS account → Create an AWS account: name `winston-prod`, email `ni+winston-prod@nikolas.ai` (plus addressing gives each account its own address), role `OrganizationAccountAccessRole`. Then move it into the Winston OU.
3. **Root access:** IAM → Root access management → enable root credentials management and privileged root actions. Accounts created by Organizations have no root password, and this is the supported way to do root-only tasks in them (via `sts:AssumeRoot`).
4. **Assignment:** IAM Identity Center → AWS accounts → `winston-prod` → Assign users or groups → `ni@nikolas.ai` with `AdministratorAccess`.
5. **CLI:** `aws configure sso` as above.

## Notes

- **Things to know about the Organization:** service control policies never apply to the management account, which is one reason it runs no workloads. Billing is consolidated: `winston-prod`'s costs are on the management account's bill. A member account can only leave four days after it was created, and a closed account blocks deleting the Organization for 90 days.
- **Identity Center's region can't change** without deleting the instance and recreating every user and assignment.
- **Open item:** the management account's root user has no MFA yet. The maintainer will add it.
