import { useState } from "react";
import { Button, Combobox, Select, TextArea, TextField } from "@winston/ui";
import { ownerScheduleUpdateSchema, type Schedule } from "@winston/contracts/schedules";
import {
  localTime,
  resolveLocalTime,
  scheduleChange,
  type ScheduleDraft,
  type Repeat,
} from "./timing";

type Change = ReturnType<typeof ownerScheduleUpdateSchema.parse>;
const repeats: Record<string, Repeat> = {
  keep: "keep",
  once: "once",
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};

export function ScheduleEditorView({
  schedule,
  busy = false,
  failed = false,
  onSave,
  onReload,
  onBack,
}: {
  schedule: Schedule;
  busy?: boolean;
  failed?: boolean;
  onSave: (change: Change) => void;
  onReload: () => void;
  onBack: () => void;
}) {
  const [original] = useState(schedule);
  const [draft, setDraft] = useState<ScheduleDraft>({
    objective: schedule.objective,
    local: localTime(schedule),
    timezone: schedule.timing.timezone,
    repeat: "keep",
    occurrence: "",
  });
  const [error, setError] = useState<string | null>(null);
  const timezones = [
    ...new Set(["UTC", original.timing.timezone, ...Intl.supportedValuesOf("timeZone")]),
  ].sort();
  let repeated: ReturnType<typeof resolveLocalTime> | null = null;
  if (draft.local !== localTime(original) || draft.timezone !== original.timing.timezone) {
    try {
      repeated = resolveLocalTime(draft.local, draft.timezone);
    } catch {
      /* Submission explains invalid local times. */
    }
  }
  if (schedule.state === "canceled")
    return (
      <>
        <h1 className="text-xl font-medium">Schedule canceled</h1>
        <Button onClick={onBack}>Back to schedules</Button>
      </>
    );
  return (
    <>
      <h1 className="text-xl font-medium">Edit schedule</h1>
      {failed ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-muted">
            Could not confirm the current schedule. Reload it before making another change.
          </p>
          <Button disabled={busy} onClick={onReload}>
            Reload schedule
          </Button>
        </div>
      ) : null}
      <form
        className="max-w-lg space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          try {
            if (!draft.objective.trim()) throw new Error("Enter an instruction for Winston.");
            const input = ownerScheduleUpdateSchema.parse(scheduleChange(original, draft));
            onSave(input);
          } catch (failure) {
            setError(
              failure instanceof RangeError
                ? "Choose a valid date, time and timezone."
                : failure instanceof Error && failure.name === "Error"
                  ? failure.message
                  : "Check the schedule details.",
            );
          }
        }}
      >
        <TextArea
          label="Instruction"
          rows={4}
          maxLength={20_000}
          required
          disabled={busy || failed}
          value={draft.objective}
          onChange={(event) => {
            setDraft({ ...draft, objective: event.target.value });
          }}
        />
        <TextField
          label="Date and time"
          type="datetime-local"
          required
          disabled={busy || failed}
          value={draft.local}
          onChange={(event) => {
            setDraft({ ...draft, local: event.target.value, occurrence: "" });
          }}
        />
        <Combobox
          label="Timezone"
          items={timezones}
          value={draft.timezone}
          disabled={busy || failed}
          onValueChange={(value) => {
            if (value) setDraft({ ...draft, timezone: value, occurrence: "" });
          }}
        />
        {repeated?.ambiguous ? (
          <Select
            label="This time happens twice"
            value={draft.occurrence || null}
            disabled={busy || failed}
            options={[
              { value: "earlier", label: `First occurrence (UTC${repeated.earlierOffset})` },
              { value: "later", label: `Second occurrence (UTC${repeated.laterOffset})` },
            ]}
            onValueChange={(value) => {
              setDraft({
                ...draft,
                occurrence: value === "earlier" || value === "later" ? value : "",
              });
            }}
          />
        ) : null}
        <Select
          label="Repeat"
          value={draft.repeat}
          disabled={busy || failed}
          options={[
            { value: "keep", label: "Keep current schedule" },
            { value: "once", label: "Once" },
            { value: "daily", label: "Daily" },
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
          ]}
          onValueChange={(value) => {
            setDraft({ ...draft, repeat: repeats[value ?? "keep"] ?? "keep" });
          }}
        />
        {original.state === "paused" ? (
          <p className="text-sm text-muted">This schedule will stay paused.</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || failed}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
          <Button type="button" variant="quiet" disabled={busy} onClick={onBack}>
            Back to schedules
          </Button>
        </div>
      </form>
    </>
  );
}
