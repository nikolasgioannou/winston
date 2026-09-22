import { Button } from "@winston/ui";
import type { GoogleCalendar } from "@winston/contracts/connections";

export function CalendarSelectionView({
  items,
  selected,
  busy,
  error,
  onToggle,
  onSave,
  onCancel,
}: {
  items: GoogleCalendar[];
  selected: string[];
  busy: boolean;
  error?: boolean;
  onToggle: (id: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="space-y-3" aria-label="Calendar selection">
      <h2 className="text-sm font-medium">Choose calendars</h2>
      {error ? (
        <p role="alert" className="text-sm text-muted">
          Could not save calendars. Try again.
        </p>
      ) : null}
      {items.length ? (
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {items.map((calendar) => (
            <Button
              key={calendar.id}
              aria-pressed={selected.includes(calendar.id)}
              disabled={busy}
              variant={selected.includes(calendar.id) ? "primary" : "default"}
              onClick={() => {
                onToggle(calendar.id);
              }}
            >
              <span className="truncate">{calendar.summary ?? calendar.id}</span>
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No calendars available.</p>
      )}
      <div className="flex gap-2">
        <Button disabled={busy} onClick={onSave}>
          {busy ? "Saving…" : "Save calendars"}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
