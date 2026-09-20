import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ESLint } from "eslint";
import * as prettier from "prettier";

const root = resolve(import.meta.dirname, "..");
const eslint = new ESLint({ cwd: root });
const server = join(root, "apps/server/src/main.ts");
const web = join(root, "apps/web/src/main.tsx");

async function expectRule(code, filePath, ruleId) {
  const [result] = await eslint.lintText(code, { filePath });

  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  assert.ok(
    result.messages.some((message) => message.ruleId === ruleId),
    JSON.stringify(result.messages),
  );
}

test("typed rules reject floating promises, including void discards", async () => {
  await expectRule("Promise.resolve(1);", server, "@typescript-eslint/no-floating-promises");
  await expectRule("void Promise.resolve(1);", server, "@typescript-eslint/no-floating-promises");
});

test("typed rules reject unsafe input and async callbacks in synchronous contracts", async () => {
  await expectRule(
    'export const payload = JSON.parse("{}");',
    server,
    "@typescript-eslint/no-unsafe-assignment",
  );

  await expectRule(
    `
      [1].forEach(async () => {
        await Promise.resolve();
      });
    `,
    server,
    "@typescript-eslint/no-misused-promises",
  );
});

test("web code cannot import server code through static, dynamic, or re-export paths", async () => {
  await expectRule('import "../../server/src/main";', web, "boundaries/dependencies");

  await expectRule(
    'export const load = () => import("../../server/src/main");',
    web,
    "boundaries/dependencies",
  );

  await expectRule('export * from "../../server/src/main";', web, "boundaries/dependencies");
});

test("web code cannot import Node built-ins", async () => {
  await expectRule('export { readFile } from "node:fs/promises";', web, "boundaries/dependencies");
});

test("a server cannot reach into the workspace app", async () => {
  await expectRule('import "../../workspace/src/main";', server, "boundaries/dependencies");
});

test("production code cannot depend on the test harness", async () => {
  await expectRule('import "../../../packages/testing/src";', server, "boundaries/dependencies");
});

test("normal React and awaited Bun code remain allowed", async () => {
  for (const [code, filePath] of [
    [
      `
        import { createElement } from "react";

        export const screen = createElement("main");
      `,
      web,
    ],
    ['export const contents = await Bun.file("example.txt").text();', server],
  ]) {
    const [result] = await eslint.lintText(code, { filePath });

    assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
  }
});

test("React hooks and accessibility rules are active", async () => {
  await expectRule('export const screen = <img src="/example.png" />;', web, "jsx-a11y/alt-text");

  await expectRule(
    `
      import { useState } from "react";

      export function Screen({ show }: { show: boolean }) {
        if (show) {
          useState(0);
        }

        return null;
      }
    `,
    web,
    "react-hooks/rules-of-hooks",
  );
});

test("Tailwind rules reject conflicting, unknown, duplicate, and deprecated classes", async () => {
  for (const [classes, rule] of [
    ["flex grid", "no-conflicting-classes"],
    ["w-button-typo", "no-unknown-classes"],
    ["flex flex", "no-duplicate-classes"],
    ["rounded", "no-deprecated-classes"],
  ]) {
    await expectRule(
      `export const screen = <div className="${classes}" />;`,
      web,
      `better-tailwindcss/${rule}`,
    );
  }

  await expectRule(
    "export const screen = (color: string) => <div className={`bg-${color}`} />;",
    web,
    "better-tailwindcss/no-concatenated-classes",
  );
});

test("Tailwind reads shared theme tokens in both UI workspaces", async () => {
  for (const filePath of [web, join(root, "packages/ui/src/button.tsx")]) {
    const [result] = await eslint.lintText(
      `
        export const screen = (active: boolean) => (
          <div className={active
            ? "bg-paper text-ink flex md:grid w-[min(271px,90vw)]"
            : "bg-input text-muted shadow-input-focus"}
          />
        );
      `,
      { filePath },
    );

    assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
  }
});

test("Tailwind checks reusable class strings and variant maps", async () => {
  await expectRule(
    'export const popupClasses = "flex grid";',
    join(root, "packages/ui/src/popup-styles.ts"),
    "better-tailwindcss/no-conflicting-classes",
  );

  await expectRule(
    'export const variantClasses = { primary: "bg-typo" };',
    join(root, "packages/ui/src/button.tsx"),
    "better-tailwindcss/no-unknown-classes",
  );
});

test("Tailwind canonical fixes simplify spacing and shorthand without changing direction", async () => {
  const checker = new ESLint({ cwd: root, fix: true });
  const [result] = await checker.lintText(
    'export const screen = <div className="after:left-[3px] h-8 w-8 ms-2 me-2" />;',
    { filePath: web },
  );

  assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
  assert.ok(result.output.includes("after:left-0.75"));
  assert.ok(result.output.includes("size-8"));
  assert.ok(!result.output.includes("mx-2"));
});

test("Prettier keeps a Markdown paragraph on one source line", async () => {
  const options = await prettier.resolveConfig(join(root, "README.md"));
  const paragraph = "A deliberately long paragraph with several sentences. ".repeat(10).trim();

  assert.equal(
    await prettier.format(paragraph + "\n", { ...options, parser: "markdown" }),
    paragraph + "\n",
  );
});

test("Prettier normalizes code and rejects literal escaped source newlines", async () => {
  const options = await prettier.resolveConfig(server);
  const output = await prettier.format("const value=1;export{value}\r\n", {
    ...options,
    parser: "typescript",
  });

  assert.ok(output.includes("\nexport"));
  assert.ok(output.endsWith("\n") && !output.includes("\r"));

  await assert.rejects(() =>
    prettier.format(String.raw`export {};\nexport {};`, { ...options, parser: "typescript" }),
  );
});

test("text checks cover TOML and respect local Git exclusions", () => {
  const directory = mkdtempSync(join(tmpdir(), "winston-text-"));

  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    mkdirSync(join(directory, "private"));
    writeFileSync(join(directory, ".git/info/exclude"), "/private/\n/local.config.yml\n");
    writeFileSync(join(directory, "private/notes.md"), "private\r\n");
    writeFileSync(join(directory, "local.config.yml"), "private");
    writeFileSync(join(directory, "sample.toml"), 'name = "test"\r\nmissing = true');

    const command = [join(root, "scripts/check-text.mjs")];
    const failed = spawnSync(process.execPath, command, { cwd: directory, encoding: "utf8" });

    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /use LF line endings/);
    assert.match(failed.stderr, /add a final newline/);
    assert.doesNotMatch(failed.stderr, /private|local\.config/);

    writeFileSync(join(directory, "sample.toml"), 'name = "test"\n');

    const passed = spawnSync(process.execPath, command, { cwd: directory, encoding: "utf8" });

    assert.equal(passed.status, 0, passed.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("formatter excludes generated output and skips the Bun lockfile", async () => {
  const ignorePath = [".gitignore", ".git/info/exclude"].map((path) => join(root, path));
  const generated = await prettier.getFileInfo(join(root, "apps/web/dist/index.html"), {
    ignorePath,
  });
  const lockfile = await prettier.getFileInfo(join(root, "bun.lock"), { ignorePath });

  assert.equal(generated.ignored, true);
  assert.equal(lockfile.inferredParser, null);

  assert.ok(readFileSync(join(root, ".gitattributes"), "utf8").includes("eol=lf"));
});

test("package policies allow public exports and reject relative shortcuts and domain I/O", async () => {
  const directory = mkdtempSync(join(tmpdir(), "winston-boundaries-"));

  try {
    writeFileSync(
      join(directory, "eslint.config.mjs"),
      readFileSync(join(root, "eslint.config.mjs")),
    );
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");

    for (const name of ["domain", "application"]) {
      const location = join(directory, "packages", name);

      mkdirSync(join(location, "src"), { recursive: true });

      writeFileSync(
        join(location, "package.json"),
        JSON.stringify({
          name: `@winston/${name}`,
          type: "module",
          exports: { ".": "./src/index.ts" },
        }),
      );

      writeFileSync(
        join(location, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "Preserve",
            moduleResolution: "Bundler",
            strict: true,
            noEmit: true,
            types: [],
          },
          include: ["src/**/*.ts"],
        }),
      );

      writeFileSync(join(location, "src/index.ts"), "export const value = 1;\n");
    }

    const scope = join(directory, "packages/application/node_modules/@winston");

    mkdirSync(scope, { recursive: true });
    symlinkSync(join(directory, "packages/domain"), join(scope, "domain"), "dir");

    const checker = new ESLint({ cwd: directory });
    const application = join(directory, "packages/application/src/index.ts");

    const [allowed] = await checker.lintText('export { value } from "@winston/domain";', {
      filePath: application,
    });

    assert.equal(allowed.errorCount, 0, JSON.stringify(allowed.messages));

    const [shortcut] = await checker.lintText('export { value } from "../../domain/src/index";', {
      filePath: application,
    });

    assert.ok(
      shortcut.messages.some((message) => message.ruleId === "boundaries/dependencies"),
      JSON.stringify(shortcut.messages),
    );

    const [domain] = await checker.lintText('export { readFile } from "node:fs/promises";', {
      filePath: join(directory, "packages/domain/src/index.ts"),
    });

    assert.ok(
      domain.messages.some((message) => message.ruleId === "boundaries/dependencies"),
      JSON.stringify(domain.messages),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
