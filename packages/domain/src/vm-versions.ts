/**
 * VM binary versions (docs/design.md §18): `0.1.<commits on main>+<short sha>`,
 * with `.dirty` for uncommitted builds, or `dev` when unbuilt. The commit
 * count only grows on main, where every commit deploys, so it orders builds.
 */

/** The build number (commits on main), or undefined for `dev` and the unparseable. */
export function buildNumber(version: string | null | undefined) {
  const match = /^0\.1\.(\d+)\+/.exec(version ?? "");
  return match ? Number(match[1]) : undefined;
}

/** Whether a VM reporting `reported` should update to `current`. */
export function isOutdated(
  reported: string | null | undefined,
  current: string,
) {
  const want = buildNumber(current);
  if (want === undefined) return false;
  const have = buildNumber(reported);
  return have === undefined || have < want;
}
