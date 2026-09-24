import type { Responsibility } from "@winston/contracts/responsibilities";
import { useResourceCatalog } from "../management/use-resource-catalog";

export function useScopeNames(items: Responsibility[], catalog = false) {
  return useResourceCatalog({
    connections:
      catalog ||
      items.some((item) => item.scope.some(({ target }) => target.kind === "connection")),
    devices:
      catalog || items.some((item) => item.scope.some(({ target }) => target.kind === "device")),
    workspaces:
      catalog || items.some((item) => item.scope.some(({ target }) => target.kind === "workspace")),
  });
}
