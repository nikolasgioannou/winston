/**
 * `bun run docker:build`: builds the four service images from the repo root
 * as `winston-<service>:local` (docs/design.md §9). Pass service names to
 * build only those: `bun run docker:build api web`.
 */
const services = ["api", "agents", "gateway", "web"] as const;
type Service = (typeof services)[number];

const requested = process.argv.slice(2);
for (const name of requested)
  if (!services.includes(name as Service)) {
    console.error(
      `Unknown service "${name}". Choose from: ${services.join(", ")}`,
    );
    process.exit(1);
  }

for (const service of requested.length > 0 ? requested : services) {
  const args =
    service === "web"
      ? ["-f", "docker/web.Dockerfile"]
      : [
          "-f",
          "docker/service.Dockerfile",
          "--build-arg",
          `SERVICE=${service}`,
        ];
  console.log(`Building winston-${service}:local`);
  const proc = Bun.spawn(
    ["docker", "build", ...args, "-t", `winston-${service}:local`, "."],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}
