/**
 * Keeps the model's line breaks in a Rich Message. Markdown treats a single
 * newline as a space (a "soft break"), so a haiku or an address written line
 * by line would arrive as one run-on line. Each line followed by another
 * non-empty line gets a hard break (two trailing spaces), except inside
 * fenced code, where lines are kept as they are anyway, and in tables: a
 * table's rows are left alone and it starts after a blank line, or its rows
 * would be read as one paragraph (seen in production: a summary table
 * arrived as raw `| Site | Result |` text).
 */
const tableRow = (line: string) => /^ {0,3}\|/.test(line);

export function keepLineBreaks(markdown: string) {
  const lines = markdown.split("\n");
  let fence: string | undefined;
  return lines
    .map((line, index) => {
      const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (opener?.startsWith(fence)) fence = undefined;
        return line;
      }
      if (opener) {
        fence = opener;
        return line;
      }
      const next = lines[index + 1];
      // A plain line right after a table would be read as another row.
      if (tableRow(line))
        return next !== undefined && next.trim() !== "" && !tableRow(next)
          ? `${line}\n`
          : line;
      if (next !== undefined && tableRow(next) && line.trim() !== "")
        return `${line}\n`;
      const breaks =
        line.trim() !== "" && next !== undefined && next.trim() !== "";
      return breaks && !/( {2}|\\)$/.test(line) ? `${line}  ` : line;
    })
    .join("\n");
}
