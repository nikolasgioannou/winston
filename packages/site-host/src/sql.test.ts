import { describe, expect, test } from "bun:test";
import { splitSql } from "./sql.ts";

describe("splitSql", () => {
  test("splits statements on semicolons, across lines", () => {
    expect(
      splitSql(`CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL
);
CREATE INDEX notes_body ON notes (body);`),
    ).toEqual([
      "CREATE TABLE notes (\n  id INTEGER PRIMARY KEY,\n  body TEXT NOT NULL\n)",
      "CREATE INDEX notes_body ON notes (body)",
    ]);
  });

  test("keeps semicolons inside strings, identifiers and comments", () => {
    expect(
      splitSql(
        `INSERT INTO "a;b" (body) VALUES ('it''s; fine'); -- done; really
/* two; */ SELECT 1`,
      ),
    ).toEqual([
      `INSERT INTO "a;b" (body) VALUES ('it''s; fine')`,
      "-- done; really\n/* two; */ SELECT 1",
    ]);
  });

  test("keeps a trigger's body together", () => {
    const trigger = `CREATE TRIGGER touch AFTER UPDATE ON notes BEGIN
  UPDATE notes SET updated = 1 WHERE id = NEW.id;
  SELECT 1;
END`;
    expect(splitSql(`${trigger};\nSELECT 2;`)).toEqual([trigger, "SELECT 2"]);
  });

  test("drops empty statements and comment-only leftovers", () => {
    expect(splitSql(";;\n-- nothing here\n")).toEqual([]);
    expect(splitSql("SELECT 1;\n-- trailing")).toEqual(["SELECT 1"]);
  });
});
