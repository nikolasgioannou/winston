import { Button } from "@winston/ui";
import type { DeliveryDownload } from "@winston/contracts/artifacts";

export type DownloadState = DeliveryDownload | { kind: "loading" | "error" };

export function DownloadView({
  state,
  busy = false,
  failed = false,
  onDownload,
  onRetry,
  onLeave,
}: {
  state: DownloadState;
  busy?: boolean;
  failed?: boolean;
  onDownload: () => void;
  onRetry: () => void;
  onLeave?: () => void;
}) {
  return (
    <section className="space-y-4 border-t border-line pt-5" aria-label="Download file">
      <h2 className="text-base font-medium">Download file</h2>
      {state.kind === "loading" ? <p role="status">Loading…</p> : null}
      {state.kind === "ready" ? (
        <>
          <p className="text-sm wrap-anywhere">{state.name}</p>
          <p className="text-sm text-muted">{new Intl.NumberFormat().format(state.size)} bytes</p>
          <Button variant="primary" disabled={busy} onClick={onDownload}>
            {busy ? "Preparing download…" : "Download"}
          </Button>
        </>
      ) : null}
      {state.kind === "expired" ? (
        <p className="text-sm text-muted">This link expired. Ask Winston to send the file again.</p>
      ) : null}
      {state.kind === "unavailable" ? (
        <p className="text-sm text-muted">This file is unavailable.</p>
      ) : null}
      {state.kind === "error" ? (
        <>
          <p role="alert" className="text-sm text-muted">
            Unable to load this file.
          </p>
          <Button onClick={onRetry}>Try again</Button>
        </>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-muted">
          Unable to download. Please try again.
        </p>
      ) : null}
      <a
        className="block text-sm text-muted underline underline-offset-4"
        href="/"
        onClick={onLeave}
      >
        Back to settings
      </a>
    </section>
  );
}
