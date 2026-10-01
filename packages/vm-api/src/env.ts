import type { RunKind } from "@winston/domain/run-token";

/** The VM-facing API's Hono environment (docs/design.md §15). */
export interface VmApiEnv {
  Bindings: {
    /** The user whose VM's websocket carried this request. Set by the gateway, never by the caller. */
    vmUserId: string;
  };
  Variables: {
    run: { userId: string; runId: string; runKind: RunKind };
  };
}
