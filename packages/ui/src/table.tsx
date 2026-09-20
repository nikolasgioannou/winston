import type { ReactNode } from "react";

export function Table({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: { id: string; cells: ReactNode[] }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                className="border-b border-line px-3 py-3 font-medium text-muted"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-line last:border-b-0">
              {row.cells.map((cell, index) => (
                <td key={columns[index]} className="px-3 py-4">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
