import type { Difficulty } from "@bekor/contracts";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, EmptyState, ErrorNotice, PageLoading } from "../components/ui";
import {
  conceptsQuery,
  problemsQuery,
  recentSubmissionsQuery,
  selfAssessmentsQuery,
} from "../queries";

const route = getRouteApi("/");

const SEARCH_DELAY_MS = 300;

export function CatalogPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { user } = route.useRouteContext();
  const list = useInfiniteQuery({ ...problemsQuery(search), placeholderData: keepPreviousData });
  const concepts = useQuery(conceptsQuery).data ?? [];
  const recent = useQuery({ ...recentSubmissionsQuery(user?.id ?? ""), enabled: Boolean(user) });

  const manual = useQuery({ ...selfAssessmentsQuery(user?.id ?? ""), enabled: Boolean(user) });
  const solved = useMemo(() => {
    const ids = new Set<string>();
    for (const item of recent.data ?? [])
      if (item.mode === "submit" && item.verdict === "accepted") ids.add(item.exerciseId);
    return ids;
  }, [recent.data]);
  const update = useCallback(
    (patch: Record<string, string | undefined>) =>
      navigate({
        search: (previous) => {
          const next: Record<string, string | undefined> = { ...previous, ...patch };
          for (const key of Object.keys(next)) if (!next[key]) delete next[key];
          return next;
        },
        replace: true,
      }),
    [navigate],
  );

  // The search box updates the URL (and so the server query) once typing pauses.
  const [text, setText] = useState(search.q ?? "");
  const pushed = useRef(search.q ?? "");
  useEffect(() => {
    const q = search.q ?? "";
    if (q !== pushed.current) {
      pushed.current = q;
      setText(q);
    }
  }, [search.q]);
  useEffect(() => {
    if (text === pushed.current) return;
    const timer = setTimeout(() => {
      pushed.current = text;
      void update({ q: text });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, update]);

  const filtered = Boolean(search.q || search.difficulty || search.concept);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="page">
      <h1>Problems</h1>
      <search>
        <form className="filters" onSubmit={(event) => event.preventDefault()}>
          <label>
            Search
            <input
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Title or description"
            />
          </label>
          <label>
            Difficulty
            <select
              value={search.difficulty ?? ""}
              onChange={(event) => update({ difficulty: event.target.value as Difficulty | "" })}
            >
              <option value="">Any</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </label>
          <label>
            Concept
            <select
              value={search.concept ?? ""}
              onChange={(event) => update({ concept: event.target.value })}
            >
              <option value="">Any</option>
              {concepts.map((concept) => (
                <option key={concept} value={concept}>
                  {concept}
                </option>
              ))}
            </select>
          </label>
        </form>
      </search>

      {list.isError ? (
        <ErrorNotice error={list.error} />
      ) : list.isPending ? (
        <PageLoading />
      ) : items.length === 0 && !filtered ? (
        <EmptyState title="No problems published yet" />
      ) : items.length === 0 ? (
        <EmptyState title="No problems match these filters">
          <Link to="/" search={{}}>
            Clear filters
          </Link>
        </EmptyState>
      ) : (
        <ul className="problem-list" aria-busy={list.isPlaceholderData}>
          {items.map((problem) => (
            <li key={problem.id}>
              <Link to="/problems/$slug" params={{ slug: problem.slug }} className="problem-card">
                <span className="problem-title">
                  {problem.title}
                  {problem.kind === "dom" && <Badge tone="pending">Self-assessed</Badge>}
                  {manual.data?.some(
                    (item) =>
                      item.exerciseId === problem.id && item.assessment?.outcome === "solved",
                  ) && <Badge tone="ok">Completed</Badge>}
                  {solved.has(problem.id) && <Badge tone="ok">Solved</Badge>}
                </span>
                <span className="problem-meta">
                  <Badge tone={problem.difficulty}>{problem.difficulty}</Badge>
                  {problem.concepts.map((concept) => (
                    <span key={concept} className="tag">
                      {concept}
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && !list.isPlaceholderData && (
        <button
          type="button"
          className="load-more"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {list.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
