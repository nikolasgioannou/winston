import { chmod, readFile, rename, writeFile } from "node:fs/promises";

/**
 * The VM token on disk (docs/design.md §15): readable only by `winstond`.
 * The directory (/etc/winstond) is 0700 and owned by `winstond`, and the
 * file itself is 0600.
 */
export function tokenStore(path: string) {
  return {
    async read() {
      try {
        const token = (await readFile(path, "utf8")).trim();
        return token || undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },
    /** Writes atomically: a temp file (0600 from the start), then a rename. */
    async write(token: string) {
      const temp = `${path}.tmp`;
      await writeFile(temp, `${token}\n`, { mode: 0o600 });
      await chmod(temp, 0o600);
      await rename(temp, path);
    },
  };
}

export type TokenStore = ReturnType<typeof tokenStore>;
