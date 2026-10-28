import type { CatalogStatus, Difficulty, Progress, ProgressStatus } from "@bekor/contracts";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, EmptyState, ErrorNotice, ListSkeleton } from "../components/ui";
import { conceptsQuery, problemsQuery, progressQuery, randomProblem } from "../queries";
import { toast } from "../stores/toasts";

const route = getRouteApi("/problems");

const SEARCH_DELAY_MS = 300;
const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

export function CatalogPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const go = useNavigate();
  const { user } = route.useRouteContext();
  const list = useInfiniteQuery({
    ...problemsQuery(search, user?.id),
    placeholderData: keepPreviousData,
  });
  const concepts = useQuery(conceptsQuery).data ?? [];
  const progress = useQuery({ ...progressQuery(user?.id ?? ""), enabled: Boolean(user) });
  const status = useMemo(
    () => new Map(progress.data?.items.map((item) => [item.exerciseId, item.status])),
    [progress.data],
  );
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

  const pick = useMutation({
    mutationFn: () => {
      const { status: _ignored, ...anonymous } = search;
      return randomProblem(user ? search : anonymous);
    },
    onSuccess: (problem) => {
      if (problem) void go({ to: "/problems/$slug", params: { slug: problem.slug } });
      else toast("No problem matches these filters.", "warn");
    },
    onError: () => toast("Could not pick a problem. Try again.", "bad"),
  });

  const filtered = Boolean(search.q || search.difficulty || search.concept || search.status);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="page">
      <div className="page-heading">
        <h1>Problems</h1>
        <button
          type="button"
          onClick={() => pick.mutate()}
          disabled={pick.isPending}
          title="Open a random problem matching the filters"
        >
          <span aria-hidden="true">⤨ </span>Pick random
        </button>
      </div>
      {user && progress.data && <ProgressSummary totals={progress.data.totals} />}
      <search>
        <form className="filters" onSubmit={(event) => event.preventDefault()}>
          <label className="filter-search">
            Search
            <input
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Title or description"
            />
          </label>
          {user && (
            <label>
              Status
              <select
                value={search.status ?? ""}
                onChange={(event) => update({ status: event.target.value as CatalogStatus | "" })}
              >
                <option value="">Any</option>
                <option value="todo">Not started</option>
                <option value="attempted">Attempted</option>
                <option value="solved">Solved</option>
              </select>
            </label>
          )}
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
          {filtered && (
            <Link to="/problems" search={{}} className="clear-filters">
              Clear filters
            </Link>
          )}
        </form>
      </search>

      {list.isError ? (
        <ErrorNotice error={list.error} />
      ) : list.isPending ? (
        <ListSkeleton />
      ) : items.length === 0 && !filtered ? (
        <EmptyState title="No problems published yet" />
      ) : items.length === 0 ? (
        <EmptyState title="No problems match these filters">
          <Link to="/problems" search={{}}>
            Clear filters
          </Link>
        </EmptyState>
      ) : (
        <ul className="problem-table" aria-busy={list.isPlaceholderData}>
          {items.map((problem) => {
            const state = status.get(problem.id);
            return (
              <li key={problem.id} className="problem-row">
                <StatusIcon status={state} selfAssessed={problem.kind === "dom"} />
                <span className="problem-row-main">
                  <Link
                    to="/problems/$slug"
                    params={{ slug: problem.slug }}
                    className="problem-row-title"
                  >
                    {problem.title}
                  </Link>
                  {problem.kind === "dom" && <Badge tone="pending">Self-assessed</Badge>}
                </span>
                <span className="problem-row-concepts">
                  {problem.concepts.map((concept) => (
                    <button
                      key={concept}
                      type="button"
                      className="tag tag-button"
                      aria-pressed={search.concept === concept}
                      title={`Filter by ${concept}`}
                      onClick={() =>
                        update({ concept: search.concept === concept ? undefined : concept })
                      }
                    >
                      {concept}
                    </button>
                  ))}
                </span>
                <Badge tone={problem.difficulty}>{problem.difficulty}</Badge>
              </li>
            );
          })}
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

function StatusIcon({
  status,
  selfAssessed,
}: {
  status: ProgressStatus | undefined;
  selfAssessed: boolean;
}) {
  const label =
    status === "solved"
      ? selfAssessed
        ? "Completed"
        : "Solved"
      : status === "attempted"
        ? "Attempted"
        : "Not started";
  return (
    <span className={`status-icon status-${status ?? "todo"}`} title={label}>
      <span aria-hidden="true">
        {status === "solved" ? "✓" : status === "attempted" ? "◐" : ""}
      </span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

export function ProgressSummary({ totals }: { totals: Progress["totals"] }) {
  const solved = DIFFICULTIES.reduce((sum, level) => sum + totals.solved[level], 0);
  const all = DIFFICULTIES.reduce((sum, level) => sum + totals.catalog[level], 0);
  return (
    <section className="progress-summary" aria-label="Your progress">
      <p className="progress-total">
        <strong>{solved}</strong>
        <span className="muted"> / {all} solved</span>
      </p>
      <ul className="progress-levels">
        {DIFFICULTIES.map((level) => {
          const done = totals.solved[level];
          const total = totals.catalog[level];
          return (
            <li key={level}>
              <span className="progress-level-label">
                <span className="capitalize">{level}</span>
                <span className="muted">
                  {done}/{total}
                </span>
              </span>
              <span className={`meter meter-${level}`} aria-hidden="true">
                <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
