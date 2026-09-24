import { useState } from "react";
import { DevicePairingView, type DevicePairingState } from "../computers/pairing-view";

const challenge = {
  id: "33333333-3333-4333-8333-333333333333",
  secret: `wdp_${"p".repeat(43)}`,
  expiresAt: "2030-01-01T12:05:00.000Z",
};

function initialState(initial: string): DevicePairingState {
  switch (initial) {
    case "pairing-form":
      return { kind: "form" };
    case "pairing-creating":
      return { kind: "creating" };
    case "pairing-code":
      return { kind: "code", challenge };
    case "pairing-expired":
      return { kind: "expired" };
    case "pairing-error":
      return { kind: "error" };
    case "pairing-closing":
      return { kind: "closing" };
    case "pairing-cancel-error":
      return { kind: "cancel-error", id: challenge.id };
    default:
      return { kind: "closed" };
  }
}

export function DevicePairingPreview({ initial }: { initial: string }) {
  const [state, setState] = useState(() => initialState(initial));
  return (
    <DevicePairingView
      state={state}
      onOpen={() => {
        setState({ kind: "form" });
      }}
      onCreate={() => {
        setState({ kind: "code", challenge });
      }}
      onClose={() => {
        setState({ kind: "closed" });
      }}
    />
  );
}
