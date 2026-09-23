import { useState } from "react";
import { DownloadView, type DownloadState } from "../files/download-view";
import { SignInView } from "../auth/sign-in-view";

export const previewDownload = {
  kind: "ready" as const,
  id: "11111111-1111-4111-8111-111111111111",
  name: "Trip itinerary.pdf",
  size: 621_824,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

export function DownloadPreview({
  initial,
  busy = false,
  failed = false,
}: {
  initial: DownloadState;
  busy?: boolean;
  failed?: boolean;
}) {
  const [state, setState] = useState(initial);
  const [downloading, setDownloading] = useState(busy);
  return (
    <SignInView state="signed-in" onSignIn={() => {}} onSignOut={() => {}} onRetry={() => {}}>
      <DownloadView
        state={state}
        busy={downloading}
        failed={failed}
        onDownload={() => {
          setDownloading(true);
        }}
        onRetry={() => {
          setState(previewDownload);
        }}
      />
    </SignInView>
  );
}
