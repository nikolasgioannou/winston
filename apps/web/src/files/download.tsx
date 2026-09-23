import { useCallback, useEffect, useRef, useState } from "react";
import { deliveryDownloadSchema, signedDownloadSchema } from "@winston/contracts/artifacts";
import { DownloadView, type DownloadState } from "./download-view";
import { rememberDownload } from "./locator";

export function DownloadPage({ id }: { id: string }) {
  const [state, setState] = useState<DownloadState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const response = await fetch(`/api/owner/file-deliveries/${id}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error();
      const result = deliveryDownloadSchema.parse(await response.json());
      if (current !== revision.current) return;
      setState(result);
      if (result.kind !== "ready") rememberDownload(null);
    } catch {
      if (current === revision.current) setState({ kind: "error" });
    }
  }, [id]);
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(async () => {
        if (active) await refresh();
      })
      .catch(() => {});
    return () => {
      active = false;
      revision.current += 1;
    };
  }, [refresh]);

  async function download() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/owner/file-deliveries/${id}/download`, {
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 404) {
        await refresh();
        return;
      }
      if (!response.ok) throw new Error();
      const result = signedDownloadSchema.parse(await response.json());
      window.location.assign(result.url);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <DownloadView
      state={state}
      busy={busy}
      failed={failed}
      onDownload={() => {
        download().catch(() => {
          setFailed(true);
        });
      }}
      onRetry={() => {
        refresh().catch(() => {});
      }}
      onLeave={() => {
        rememberDownload(null);
      }}
    />
  );
}
