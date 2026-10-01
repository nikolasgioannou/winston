/**
 * `bun run prod <command> [args]`: runs a production operation as a one-off
 * ECS task on the current `ops` image (packages/db/src/ops.ts), streams its
 * logs here, and exits with its status (docs/runbooks/production.md):
 *
 *   bun run prod allowlist list
 *   bun run prod allowlist add someone@example.com
 *   bun run prod sql "select count(*) from users"
 *   bun run prod migrate
 *
 * Anything that writes asks for confirmation first; `--yes` skips it (deploys).
 * Uses the `winston-prod` profile unless AWS credentials are already set.
 */
import { $ } from "bun";

const args = Bun.argv.slice(2).filter((arg) => arg !== "--yes");
const confirmed = Bun.argv.includes("--yes");
const [command, subcommand] = args;

const commands = ["migrate", "allowlist", "sql"];
if (!command || !commands.includes(command)) {
  console.error(`usage: bun run prod ${commands.join(" | ")} …`);
  process.exit(1);
}
const writes =
  command === "migrate" ||
  (command === "allowlist" &&
    (subcommand === "add" || subcommand === "remove"));

const env = {
  ...process.env,
  AWS_REGION: "us-east-1",
  ...(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE
    ? {}
    : { AWS_PROFILE: "winston-prod" }),
};
const aws = async (...parts: string[]) =>
  JSON.parse(await $`aws ${parts} --output json`.env(env).text()) as unknown;

if (writes && !confirmed) {
  process.stdout.write(
    `This changes production: ${args.join(" ")}\nType "yes" to go on: `,
  );
  for await (const line of console) {
    if (line.trim() !== "yes") {
      console.log("Stopped; nothing ran.");
      process.exit(1);
    }
    break;
  }
}

const outputs = Object.fromEntries(
  (
    (await aws(
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      "winston-services",
      "--query",
      "Stacks[0].Outputs",
    )) as { OutputKey: string; OutputValue: string }[]
  ).map(({ OutputKey, OutputValue }) => [OutputKey, OutputValue]),
);
const cluster = outputs.ClusterName ?? "";
const network = JSON.stringify({
  awsvpcConfiguration: {
    subnets: (outputs.OpsSubnets ?? "").split(","),
    securityGroups: [outputs.OpsSecurityGroup],
    assignPublicIp: "ENABLED",
  },
});
const overrides = JSON.stringify({
  containerOverrides: [{ name: "ops", command: args }],
});

const { tasks } = (await aws(
  "ecs",
  "run-task",
  "--cluster",
  cluster,
  "--task-definition",
  outputs.OpsTaskDefinition ?? "",
  "--launch-type",
  "FARGATE",
  "--network-configuration",
  network,
  "--overrides",
  overrides,
)) as { tasks: { taskArn: string; taskDefinitionArn: string }[] };
const task = tasks[0];
if (!task) throw new Error("ECS started no task.");
const taskId = task.taskArn.split("/").at(-1) ?? "";
console.log(`Started ops task ${taskId}: ${args.join(" ")}`);

const { taskDefinition } = (await aws(
  "ecs",
  "describe-task-definition",
  "--task-definition",
  task.taskDefinitionArn,
)) as {
  taskDefinition: {
    containerDefinitions: {
      logConfiguration: { options: Record<string, string> };
    }[];
  };
};
const logGroup =
  taskDefinition.containerDefinitions[0]?.logConfiguration.options[
    "awslogs-group"
  ] ?? "";
const logStream = `ops/ops/${taskId}`;

interface TaskState {
  lastStatus: string;
  stoppedReason?: string;
  containers: { exitCode?: number; reason?: string }[];
}
const describe = async () =>
  (
    (await aws(
      "ecs",
      "describe-tasks",
      "--cluster",
      cluster,
      "--tasks",
      taskId,
    )) as {
      tasks: TaskState[];
    }
  ).tasks[0];

// Prints new log lines until the task has stopped and its logs are drained.
// CloudWatch can lag a few seconds, so a stopped task gets a few more polls.
let token: string | undefined;
let state: TaskState | undefined;
let quietPollsAfterStop = 0;
for (;;) {
  state = await describe();
  const stopped = state?.lastStatus === "STOPPED";
  const events = (await aws(
    "logs",
    "get-log-events",
    "--log-group-name",
    logGroup,
    "--log-stream-name",
    logStream,
    "--start-from-head",
    ...(token ? ["--next-token", token] : []),
  ).catch(() => ({ events: [], nextForwardToken: token }))) as {
    events: { message: string }[];
    nextForwardToken?: string;
  };
  for (const { message } of events.events) console.log(message);
  token = events.nextForwardToken;
  if (stopped) {
    quietPollsAfterStop =
      events.events.length === 0 ? quietPollsAfterStop + 1 : 0;
    if (quietPollsAfterStop >= 3) break;
  }
  await Bun.sleep(2000);
}

const exitCode = state?.containers[0]?.exitCode;
if (exitCode === undefined) {
  console.error(
    `The task stopped without running: ${state?.stoppedReason ?? state?.containers[0]?.reason ?? "unknown"}`,
  );
  process.exit(1);
}
process.exit(exitCode);
