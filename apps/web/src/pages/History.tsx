import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { judgedSource, SubmissionResult } from "../components/SubmissionResult";
import { Badge, EmptyState, ErrorNotice, PageLoading } from "../components/ui";
import { formatDateTime, LANGUAGE_LABEL, submissionLabel, submissionTone } from "../format";
import { historyQuery, problemQuery, problemsQuery, submissionQuery } from "../queries";

const historyRoute = getRouteApi("/authed/history");
const submissionRoute = getRouteApi("/authed/submissions/$id");

export function HistoryPage() {
  const { user } = historyRoute.useRouteContext();
  const history = useInfiniteQuery(historyQuery(user.id));
  const problems = useQuery(problemsQuery);
  const titles = new Map((problems.data ?? []).map((problem) => [problem.id, problem]));

  if (history.isPending) return <PageLoading />;
  if (history.isError) return <ErrorNotice error={history.error} />;
  const items = history.data.pages.flatMap((page) => page.items);

  return (
    <div className="page">
      <h1>Submission history</h1>
      {items.length === 0 ? (
        <EmptyState title="No submissions yet">
          <Link to="/">Pick a problem to solve</Link>
        </EmptyState>
      ) : (
        <table className="history">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Problem</th>
              <th scope="col">Language</th>
              <th scope="col">Mode</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link to="/submissions/$id" params={{ id: item.id }}>
                    {formatDateTime(item.createdAt)}
                  </Link>
                </td>
                <td>{titles.get(item.exerciseId)?.title ?? item.exerciseId}</td>
                <td>{LANGUAGE_LABEL[item.language]}</td>
                <td>
                  {item.mode}
                  {item.practiceSessionId && <span className="muted"> · session</span>}
                </td>
                <td>
                  <Badge tone={submissionTone(item)}>{submissionLabel(item)}</Badge>{" "}
                  {item.status === "completed" && (
                    <span className="muted">
                      {item.passedCount}/{item.totalCount}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {history.hasNextPage && (
        <button
          type="button"
          onClick={() => void history.fetchNextPage()}
          disabled={history.isFetchingNextPage}
        >
          {history.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

export function SubmissionPage() {
  const { id } = submissionRoute.useParams();
  const { user } = submissionRoute.useRouteContext();
  const submission = useQuery(submissionQuery(user.id, id));
  const problems = useQuery(problemsQuery);
  const slug = problems.data?.find((item) => item.id === submission.data?.exerciseId)?.slug;
  const exercise = useQuery({
    ...problemQuery(slug ?? "", submission.data?.exerciseVersion),
    enabled: Boolean(slug && submission.data),
  });

  if (submission.isPending) return <PageLoading />;
  if (submission.isError) return <ErrorNotice error={submission.error} />;
  const data = submission.data;
  const source = judgedSource(data);
  return (
    <div className="page">
      <p>
        <Link to="/history">← History</Link>
      </p>
      <h1>
        {exercise.data?.title ?? data.exerciseId}{" "}
        <span className="muted">
          · {LANGUAGE_LABEL[data.language]} · v{data.exerciseVersion}
        </span>
      </h1>
      {slug && (
        <p>
          <Link to="/problems/$slug" params={{ slug }} search={{ language: data.language }}>
            Open problem
          </Link>
        </p>
      )}
      <SubmissionResult
        submission={data}
        variant={exercise.data?.variants[data.language]}
        onRefresh={() => void submission.refetch()}
      />
      {source !== undefined && (
        <>
          <h2>Submitted code</h2>
          <pre className="code">
            <code>{source}</code>
          </pre>
        </>
      )}
    </div>
  );
}
