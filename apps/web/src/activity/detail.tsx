import { useState } from "react";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { taskDetailSchema, taskHistorySchema } from "@winston/contracts/tasks";
import { ownerJson } from "../management/api";
import { TaskDetailView } from "./detail-view";
import { ActionEvidence } from "./action-evidence";
import { CancelRequest } from "./cancel-request";

export function TaskDetailPage({ id }: { id: string }) {
  const client = useQueryClient();
  const [version, setVersion] = useState(0);
  const detail = useQuery({
    queryKey: ["owner-task-detail", id],
    queryFn: ({ signal }) => ownerJson(`/api/owner/activity/${id}`, taskDetailSchema, { signal }),
  });
  const history = useInfiniteQuery({
    queryKey: ["owner-task-history", id],
    enabled: !!detail.data && !detail.isError,
    initialPageParam: null as number | null,
    queryFn: ({ signal, pageParam }) =>
      ownerJson(
        `/api/owner/activity/${id}/history${pageParam === null ? "" : `?beforeRevision=${String(pageParam)}`}`,
        taskHistorySchema,
        { signal },
      ),
    getNextPageParam: (page) => page.next,
  });
  const cancel = useMutation({
    mutationFn: (revision: number) =>
      ownerJson(`/api/owner/activity/${id}/cancel`, taskDetailSchema, {
        method: "POST",
        body: { revision },
      }),
    onSuccess: async (receipt) => {
      await client.cancelQueries({ queryKey: ["owner-task-detail", id] });
      client.setQueryData(["owner-task-detail", id], receipt);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["owner-activity"] }),
        client.invalidateQueries({ queryKey: ["owner-task-history", id] }),
        client.invalidateQueries({ queryKey: ["owner-task-actions", id] }),
      ]);
    },
  });

  return (
    <TaskDetailView
      state={
        detail.isError
          ? { kind: "error" }
          : detail.data
            ? { kind: "ready", value: detail.data }
            : { kind: "loading" }
      }
      history={
        history.isError
          ? { kind: "error" }
          : history.data
            ? { kind: "ready", items: history.data.pages.flatMap((page) => page.items) }
            : { kind: "loading" }
      }
      busy={detail.isFetching || history.isFetching || cancel.isPending}
      more={history.hasNextPage}
      cancellation={
        detail.data ? (
          <CancelRequest
            key={version}
            task={detail.data}
            busy={cancel.isPending || detail.isFetching}
            failed={cancel.isError}
            onCancel={(revision) => {
              cancel.mutate(revision);
            }}
          />
        ) : null
      }
      actions={
        detail.data ? (
          <ActionEvidence
            id={id}
            stopped={["succeeded", "failed", "canceled"].includes(detail.data.state)}
          />
        ) : null
      }
      onRefresh={() => {
        Promise.all([
          detail.refetch(),
          history.refetch(),
          client.invalidateQueries({ queryKey: ["owner-task-actions", id] }),
        ])
          .then(([result]) => {
            if (result.isSuccess) {
              cancel.reset();
              setVersion((current) => current + 1);
            }
          })
          .catch(() => {});
      }}
      onMore={() => {
        if (!history.isFetching) history.fetchNextPage().catch(() => {});
      }}
    />
  );
}
