import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { Badge, EmptyState } from "../components/ui";
import { problemsQuery, recentSubmissionsQuery } from "../queries";
import type { Difficulty } from "../router";

const route = getRouteApi("/");

export function CatalogPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { user } = route.useRouteContext();
  const problems = useSuspenseQuery(problemsQuery).data;
  const recent = useQuery({ ...recentSubmissionsQuery(user?.id ?? ""), enabled: Boolean(user) });

  const solved = useMemo(() => {
    const ids = new Set<string>();
    for (const item of recent.data ?? [])
      if (item.mode === "submit" && item.verdict === "accepted") ids.add(item.exerciseId);
    return ids;
  }, [recent.data]);
  const concepts = useMemo(
    () => [...new Set(problems.flatMap((problem) => problem.concepts))].sort(),
    [problems],
  );
  const query = search.q?.toLowerCase() ?? "";
  const visible = problems.filter(
    (problem) =>
      (!query ||
        problem.title.toLowerCase().includes(query) ||
        problem.description.toLowerCase().includes(query)) &&
      (!search.difficulty || problem.difficulty === search.difficulty) &&
      (!search.concept || problem.concepts.includes(search.concept)),
  );
  const update = (patch: Record<string, string | undefined>) =>
    navigate({
      search: (previous) => {
        const next: Record<string, string | undefined> = { ...previous, ...patch };
        for (const key of Object.keys(next)) if (!next[key]) delete next[key];
        return next;
      },
      replace: true,
    });

  return (
    <div className="page">
      <h1>Problems</h1>
      <search>
        <form className="filters" onSubmit={(event) => event.preventDefault()}>
          <label>
            Search
            <input
              type="search"
              value={search.q ?? ""}
              onChange={(event) => update({ q: event.target.value })}
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

      {problems.length === 0 ? (
        <EmptyState title="No problems published yet" />
      ) : visible.length === 0 ? (
        <EmptyState title="No problems match these filters">
          <Link to="/" search={{}}>
            Clear filters
          </Link>
        </EmptyState>
      ) : (
        <ul className="problem-list">
          {visible.map((problem) => (
            <li key={problem.id}>
              <Link to="/problems/$slug" params={{ slug: problem.slug }} className="problem-card">
                <span className="problem-title">
                  {problem.title}
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
    </div>
  );
}
