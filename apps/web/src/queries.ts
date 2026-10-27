import type { Submission } from "@bekor/contracts";
import {
  infiniteQueryOptions,
  MutationCache,
  QueryCache,
  QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError, api, auth } from "./api";

// Remote data lives in TanStack Query only. Private keys start with ["user", userId] so a
// sign-out (queryClient.clear) or a different account never sees another user's cache.
export const sessionQuery = queryOptions({
  queryKey: ["auth-session"],
  queryFn: () => auth.session(),
  staleTime: 60_000,
});

export const problemsQuery = queryOptions({
  queryKey: ["problems"],
  queryFn: async () => {
    // The beta catalog is small; collect every page so filters can run client-side.
    const items = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await api.problems({ limit: 100, ...(cursor ? { cursor } : {}) });
      items.push(...result.items);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return items;
  },
  staleTime: 5 * 60_000,
});

/** Without a version: the latest published version. Sessions pin their own version. */
export const problemQuery = (slug: string, version?: string) =>
  queryOptions({
    queryKey: ["problem", slug, version ?? "latest"],
    queryFn: () => api.problem(slug, version),
    staleTime: 5 * 60_000,
  });

export const TERMINAL = new Set(["completed", "infrastructure_error"]);
export const isTerminal = (submission: Submission) => TERMINAL.has(submission.status);

/** Polling stops after this long; the result stays reachable from history. */
export const POLL_LIMIT_MS = 3 * 60_000;

export const submissionQuery = (userId: string, id: string) =>
  queryOptions({
    queryKey: ["user", userId, "submission", id],
    queryFn: () => api.submission(id),
    // Exponential backoff from 500 ms to 4 s while queued/running; bounded by POLL_LIMIT_MS.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || isTerminal(data)) return false;
      if (Date.now() - Date.parse(data.createdAt) > POLL_LIMIT_MS) return false;
      return Math.min(500 * 1.6 ** query.state.dataUpdateCount, 4000);
    },
    refetchIntervalInBackground: false,
  });

export const historyQuery = (userId: string) =>
  infiniteQueryOptions({
    queryKey: ["user", userId, "submissions"],
    queryFn: ({ pageParam }) =>
      api.submissions({ limit: 20, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** Recent submissions (newest first); used to show per-exercise and per-session attempts. */
export const recentSubmissionsQuery = (userId: string) =>
  queryOptions({
    queryKey: ["user", userId, "submissions", "recent"],
    queryFn: async () => (await api.submissions({ limit: 100 })).items,
  });

export const reviewsQuery = (userId: string) =>
  queryOptions({
    queryKey: ["user", userId, "reviews"],
    queryFn: () => api.reviews(),
  });

export const settingsQuery = (userId: string) =>
  queryOptions({
    queryKey: ["user", userId, "settings"],
    queryFn: () => api.settings(),
  });

export const tokensQuery = (userId: string) =>
  queryOptions({
    queryKey: ["user", userId, "tokens"],
    queryFn: async () => (await api.tokens()).items,
  });

/** `onUnauthenticated` runs when the server rejects the session (expired or signed out elsewhere). */
export function createQueryClient(onUnauthenticated: () => void) {
  const onError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) onUnauthenticated();
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        // Client errors (4xx) are final; only retry transient failures.
        retry: (count, error) =>
          count < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
        refetchOnWindowFocus: false,
      },
    },
  });
}
