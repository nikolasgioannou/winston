import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { OwnerApiError } from "./api";

function handleError(error: Error) {
  if (error instanceof OwnerApiError && error.status === 401) {
    queryClient.setQueryData(["owner-session"], { ok: false, status: 401 });
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "owner-session" });
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleError }),
  mutationCache: new MutationCache({ onError: handleError }),
  defaultOptions: {
    queries: { retry: false, staleTime: 0 },
    mutations: { retry: false },
  },
});
