import { createHash } from "node:crypto";
import type { TargetSelection } from "@winston/contracts/connection-targets";

export function connectionTargetKey(selection: TargetSelection) {
  if (selection.explicit && ["gmail.read", "calendar.read"].includes(selection.operation)) {
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          selection.operation,
          selection.explicit.connectionId,
          selection.explicit.calendarId,
        ]),
      )
      .digest("hex");
    return `read:${digest}`;
  }
  return selection.operation;
}
