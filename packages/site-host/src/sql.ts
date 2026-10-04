/**
 * Splits a SQLite script (a site's migration file) into statements, since D1
 * runs statements one at a time: on `;`, except inside quotes, comments and
 * a trigger's `BEGIN … END` body. Comments are kept with their statement;
 * empty statements are dropped.
 */
export function splitSql(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0; // BEGIN … END nesting, for triggers
  let i = 0;
  const push = () => {
    const statement = current.trim();
    if (statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim())
      statements.push(statement);
    current = "";
  };
  while (i < script.length) {
    const char = script[i] ?? "";
    const pair = script.slice(i, i + 2);
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let end = i + 1;
      // A doubled quote inside a string is an escaped quote.
      while (end < script.length) {
        if (script[end] === close) {
          if (close !== "]" && script[end + 1] === close) end += 2;
          else break;
        } else end++;
      }
      current += script.slice(i, end + 1);
      i = end + 1;
    } else if (pair === "--") {
      const end = script.indexOf("\n", i);
      const stop = end === -1 ? script.length : end;
      current += script.slice(i, stop);
      i = stop;
    } else if (pair === "/*") {
      const end = script.indexOf("*/", i + 2);
      const stop = end === -1 ? script.length : end + 2;
      current += script.slice(i, stop);
      i = stop;
    } else if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(script.slice(i))?.[0] ?? char;
      const upper = word.toUpperCase();
      if (upper === "BEGIN" && /\bTRIGGER\b/i.test(current)) depth++;
      else if (upper === "END" && depth > 0) depth--;
      current += word;
      i += word.length;
    } else if (char === ";" && depth === 0) {
      push();
      i++;
    } else {
      current += char;
      i++;
    }
  }
  push();
  return statements;
}
