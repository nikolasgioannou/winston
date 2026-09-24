import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { scheduleSchema, type ownerScheduleUpdateSchema } from "@winston/contracts/schedules";
import { ownerJson } from "../management/api";
import { ScheduleEditorView } from "./editor-view";
import { EditorStatus } from "./editor-status";

export function ScheduleEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const client = useQueryClient();
  const [version, setVersion] = useState(0);
  const query = useQuery({
    queryKey: ["owner-schedule", id],
    queryFn: ({ signal }) => ownerJson(`/api/owner/schedules/${id}`, scheduleSchema, { signal }),
  });
  const edit = useMutation({
    mutationFn: (input: ReturnType<typeof ownerScheduleUpdateSchema.parse>) =>
      ownerJson(`/api/owner/schedules/${id}`, scheduleSchema, { method: "PUT", body: input }),
    onSuccess: async (receipt) => {
      await client.cancelQueries({ queryKey: ["owner-schedule", id] });
      client.setQueryData(["owner-schedule", id], receipt);
      await client.invalidateQueries({ queryKey: ["owner-schedules"] });
      onBack();
    },
  });
  if (!query.data)
    return (
      <EditorStatus
        state={query.isError ? "error" : "loading"}
        onBack={onBack}
        onRetry={() => {
          query.refetch().catch(() => {});
        }}
      />
    );
  return (
    <ScheduleEditorView
      key={`${id}:${String(version)}`}
      schedule={query.data}
      busy={edit.isPending}
      failed={edit.isError || query.isError}
      onSave={(input) => {
        edit.mutate(input);
      }}
      onBack={onBack}
      onReload={() => {
        query
          .refetch()
          .then((result) => {
            if (result.isSuccess) {
              edit.reset();
              setVersion((current) => current + 1);
            }
          })
          .catch(() => {});
      }}
    />
  );
}
