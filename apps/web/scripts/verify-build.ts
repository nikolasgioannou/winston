/**
 * Builds the site and checks the dev design view stayed out (vite.config.ts,
 * docs/design.md §9): no /dev/design route and no fixtures anywhere in the
 * output, and the committed route tree untouched by the build.
 */
import { $ } from "bun";

const routeTree = "src/routeTree.gen.ts";
const before = await Bun.file(routeTree).text();
await $`rm -rf dist`;
await $`bun --bun vite build`.quiet();

const leaks =
  await $`grep -rlE "/dev/design|signInFixtures|appShellFixtures|homeFixtures|profileFixtures|accountsFixtures|accountFixtures|notFoundFixtures|designPages" dist`
    .nothrow()
    .text();
if (leaks.trim()) {
  console.error(`The production build includes the dev design view:\n${leaks}`);
  process.exit(1);
}
if ((await Bun.file(routeTree).text()) !== before) {
  console.error(`The build rewrote the committed ${routeTree}.`);
  process.exit(1);
}
console.log("Production build is clean: no dev design view.");
