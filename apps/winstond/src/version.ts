/**
 * This build's version, embedded by `bun run image:build:local` with
 * `--define` as `0.1.<commits on main>+<short sha>` (plus `.dirty` for
 * uncommitted builds). The commit count only grows on main, so comparing it
 * says which build is newer. Unbuilt runs are `dev`.
 */
declare const WINSTON_BUILD_VERSION: string | undefined;

export const version =
  typeof WINSTON_BUILD_VERSION === "string" ? WINSTON_BUILD_VERSION : "dev";
