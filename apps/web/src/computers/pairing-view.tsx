import { useState } from "react";
import { Button, TextField } from "@winston/ui";
import {
  deviceNameSchema,
  type devicePairingChallengeSchema,
} from "@winston/contracts/device-registry";

export type DevicePairingState =
  | { kind: "closed" | "form" | "creating" | "error" | "expired" | "closing" }
  | { kind: "code"; challenge: ReturnType<typeof devicePairingChallengeSchema.parse> }
  | { kind: "cancel-error"; id: string };

export function DevicePairingView({
  state,
  onOpen,
  onCreate,
  onClose,
}: {
  state: DevicePairingState;
  onOpen: () => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null);
  if (state.kind === "closed") return <Button onClick={onOpen}>Connect a computer</Button>;

  return (
    <section aria-label="Connect a computer" className="max-w-md space-y-3">
      {state.kind === "code" ? (
        <>
          <TextField
            label="Pairing code"
            value={state.challenge.secret}
            readOnly
            autoComplete="off"
          />
          <p className="text-sm text-muted">
            Paste this code into Winston on your Mac. It expires in five minutes.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                navigator.clipboard
                  .writeText(state.challenge.secret)
                  .then(() => {
                    setCopiedId(state.challenge.id);
                    setCopyFailedId(null);
                  })
                  .catch(() => {
                    setCopyFailedId(state.challenge.id);
                  });
              }}
            >
              {copiedId === state.challenge.id ? "Copied" : "Copy code"}
            </Button>
            <Button variant="quiet" onClick={onClose}>
              Close and cancel unused code
            </Button>
          </div>
          {copyFailedId === state.challenge.id ? (
            <p role="status" className="text-sm text-muted">
              Select the code and copy it manually.
            </p>
          ) : null}
        </>
      ) : state.kind === "closing" ? (
        <p role="status" className="text-sm text-muted">
          Canceling code…
        </p>
      ) : state.kind === "cancel-error" ? (
        <>
          <p role="alert" className="text-sm text-muted">
            Could not confirm cancellation. The code may remain usable until it expires.
          </p>
          <Button onClick={onClose}>Retry cancellation</Button>
        </>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (state.kind === "creating") return;
            const parsed = deviceNameSchema.safeParse(name);
            setInvalid(!parsed.success);
            if (parsed.success) onCreate(parsed.data);
          }}
        >
          <TextField
            label="New computer name"
            value={name}
            maxLength={100}
            disabled={state.kind === "creating"}
            {...(invalid ? { error: "Enter a computer name." } : {})}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {state.kind === "error" ? (
            <p role="alert" className="text-sm text-muted">
              Could not confirm the code. Creating a new one replaces any pending code.
            </p>
          ) : state.kind === "expired" ? (
            <p role="status" className="text-sm text-muted">
              Code expired. Create a new one.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={state.kind === "creating"}>
              {state.kind === "creating" ? "Creating code…" : "Create pairing code"}
            </Button>
            <Button variant="quiet" disabled={state.kind === "creating"} onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
