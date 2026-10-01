/**
 * `bun run docker:build`: builds the four service images and the ops image
 * from the repo root as `winston-<name>:local` (docs/design.md §9). Pass service names to
 * build only those: `bun run docker:build api web`.
 */
const services = ["api", "agents", "gateway", "web", "ops"] as const;
type Service = (typeof services)[number];

/** api, agents and gateway share one Dockerfile; web and ops have their own. */
const dockerfileArgs = (service: Service) =>
  service === "web" || service === "ops"
    ? ["-f", `docker/${service}.Dockerfile`]
    : ["-f", "docker/service.Dockerfile", "--build-arg", `SERVICE=${service}`];

const requested = process.argv.slice(2);
for (const name of requested)
  if (!services.includes(name as Service)) {
    console.error(
      `Unknown service "${name}". Choose from: ${services.join(", ")}`,
    );
    process.exit(1);
  }

for (const service of requested.length > 0 ? requested : services) {
  const args = dockerfileArgs(service as Service);
  console.log(`Building winston-${service}:local`);
  const proc = Bun.spawn(
    ["docker", "build", ...args, "-t", `winston-${service}:local`, "."],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}
