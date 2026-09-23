import { runCli } from "./run";

const result = await runCli(process.argv.slice(2), () =>
  Promise.resolve({
    version: 1,
    status: "unavailable",
    message: "A configured task gateway is required to run this command.",
  }),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
