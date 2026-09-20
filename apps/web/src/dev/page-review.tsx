import { useState } from "react";
import { Button, Select } from "@winston/ui";
import { readReviewSelection, reviewLink, reviewPages, reviewViewports } from "./review-registry";

export function PageReview() {
  const { page, state, viewport } = readReviewSelection(window.location.search);
  const [revision, setRevision] = useState(0);
  const [feedback, setFeedback] = useState("");

  if (!page || !state) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-semibold tracking-tight">Pages & states</h1>
        <h2 className="text-sm text-muted">No application pages to review yet</h2>
        {reviewPages
          .filter((item) => item.kind === "foundation")
          .map((item) => (
            <a
              key={item.id}
              href={reviewLink(item.id, item.states[0].id)}
              className="block rounded-lg border border-line p-5 hover:bg-hover"
            >
              {item.label}
            </a>
          ))}
      </div>
    );
  }

  async function copyLink() {
    if (!page || !state) {
      return;
    }

    const url = new URL(reviewLink(page.id, state.id, viewport.value), window.location.origin);

    try {
      await navigator.clipboard.writeText(
        `${page.label} / ${state.label} / ${viewport.value}\n${url.href}`,
      );
      setFeedback("Copied.");
    } catch {
      setFeedback("Copy the link from your address bar.");
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">{page.label}</h1>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-44">
          <Select
            label="State"
            options={page.states.map((item) => ({ value: item.id, label: item.label }))}
            value={state.id}
            onValueChange={(value) => {
              if (value) window.location.assign(reviewLink(page.id, value, viewport.value));
            }}
          />
        </div>
        <div className="min-w-44">
          <Select
            label="Viewport"
            options={[...reviewViewports]}
            value={viewport.value}
            onValueChange={(value) => {
              if (value) window.location.assign(reviewLink(page.id, state.id, value));
            }}
          />
        </div>
        <Button
          onClick={() => {
            setRevision((value) => value + 1);
            setFeedback("");
          }}
        >
          Reset
        </Button>
        <Button
          onClick={() => {
            copyLink().catch(() => {
              setFeedback("Could not copy the link.");
            });
          }}
        >
          Copy link
        </Button>
        <p role="status" className="self-center text-xs text-muted empty:hidden">
          {feedback}
        </p>
      </div>
      <div className="w-fit max-w-full overflow-x-auto rounded-lg border border-line">
        <iframe
          key={`${page.id}/${state.id}/${viewport.value}/${String(revision)}`}
          title={`${page.label} — ${state.label}`}
          src={`/__dev/design/frame?${new URLSearchParams({ page: page.id, state: state.id }).toString()}`}
          sandbox="allow-scripts allow-same-origin"
          className="block h-200 max-w-none border-0 bg-paper"
          style={{ width: viewport.width }}
        />
      </div>
    </div>
  );
}
