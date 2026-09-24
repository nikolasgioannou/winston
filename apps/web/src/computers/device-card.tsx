import { useState } from "react";
import { Badge, Button, TextField } from "@winston/ui";
import { deviceNameSchema, type RegisteredDevice } from "@winston/contracts/device-registry";
import { Presence, type PresenceState } from "./presence";

export type DeviceChange =
  | { device: RegisteredDevice; action: "default" | "revoke" }
  | { device: RegisteredDevice; action: "rename"; name: string };

export function DeviceCard({
  device,
  presence,
  disabled,
  onChange,
}: {
  device: RegisteredDevice;
  presence: PresenceState;
  disabled: boolean;
  onChange: (change: DeviceChange) => void;
}) {
  const [editing, setEditing] = useState<RegisteredDevice | null>(null);
  const [name, setName] = useState(device.name);
  const [confirm, setConfirm] = useState<RegisteredDevice | null>(null);
  const [invalid, setInvalid] = useState(false);
  return (
    <section aria-label={device.name} className="space-y-3 py-5 first:pt-0">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium wrap-anywhere">{device.name}</h3>
        <Badge>{device.revoked ? "Revoked" : device.isDefault ? "Default" : "Registered"}</Badge>
      </div>
      {!device.revoked ? <Presence state={presence} deviceId={device.id} /> : null}
      <p className="text-xs text-muted">
        {device.platform === "macos"
          ? "macOS"
          : device.platform === "windows"
            ? "Windows"
            : "Linux"}
      </p>
      {!device.revoked && editing ? (
        <form
          className="max-w-sm space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            const parsed = deviceNameSchema.safeParse(name);
            setInvalid(!parsed.success);
            if (parsed.success) onChange({ device: editing, action: "rename", name: parsed.data });
          }}
        >
          <TextField
            label="Computer name"
            value={name}
            maxLength={100}
            disabled={disabled}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {invalid ? (
            <p role="alert" className="text-sm text-muted">
              Enter a name.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={disabled}>
              Save name
            </Button>
            <Button
              variant="quiet"
              disabled={disabled}
              onClick={() => {
                setEditing(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : !device.revoked && confirm ? (
        <div className="space-y-3">
          <p className="text-sm">Revoke access for {confirm.name}?</p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled}
              onClick={() => {
                onChange({ device: confirm, action: "revoke" });
              }}
            >
              Revoke access
            </Button>
            <Button
              variant="quiet"
              disabled={disabled}
              onClick={() => {
                setConfirm(null);
              }}
            >
              Keep access
            </Button>
          </div>
        </div>
      ) : !device.revoked ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="quiet"
            disabled={disabled}
            onClick={() => {
              setName(device.name);
              setEditing(device);
            }}
          >
            Rename
          </Button>
          {!device.isDefault ? (
            <Button
              variant="quiet"
              disabled={disabled}
              onClick={() => {
                onChange({ device, action: "default" });
              }}
            >
              Make default
            </Button>
          ) : null}
          <Button
            variant="quiet"
            disabled={disabled}
            onClick={() => {
              setConfirm(device);
            }}
          >
            Revoke
          </Button>
        </div>
      ) : null}
    </section>
  );
}
