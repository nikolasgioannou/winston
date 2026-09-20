import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Icon } from "./icon";

export function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <Icon icon={CircleAlert} className="mt-0.5 text-warning" />
      <div>
        <h3 className="font-medium">{title}</h3>
        <div className="mt-1 text-sm text-muted">{children}</div>
      </div>
    </div>
  );
}
