import type { Progress, ReviewQueue } from "@bekor/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { type HeatCell, heatmap, localDate, streaks } from "../activity";
import type { SessionUser } from "../api";
import { Badge, ErrorNotice, Skeleton } from "../components/ui";
import { formatRelative, LANGUAGE_LABEL } from "../format";
import { useStartReview } from "../hooks/useStartReview";
import {
  problemsByIdQuery,
  problemsQuery,
  progressQuery,
  randomProblem,
  reviewExerciseIds,
  reviewsQuery,
} from "../queries";
import { ProgressSummary } from "./Catalog";

const route = getRouteApi("/");

export function HomePage() {
  const { user } = route.useRouteContext();
  return user ? <Dashboard user={user} /> : <Landing />;
}

function Dashboard({ user }: { user: SessionUser }) {
  const reviews = useQuery(reviewsQuery(user.id));
  const progress = useQuery(progressQuery(user.id));
  const firstName = (user.name || user.email).split(/\s|@/)[0];
  return (
    <div className="page dashboard">
      <h1>Welcome back, {firstName}</h1>
      <div className="dashboard-grid">
        {reviews.isError ? (
          <ErrorNotice error={reviews.error} />
        ) : reviews.data ? (
          <ReviewHero userId={user.id} queue={reviews.data} />
        ) : (
          <section className="card hero-card">
            <Skeleton lines={2} />
          </section>
        )}
        <Recommended userId={user.id} />
      </div>
      {progress.isError ? (
        <ErrorNotice error={progress.error} />
      ) : progress.data ? (
        <>
          <ProgressSummary totals={progress.data.totals} />
          <ActivityCard progress={progress.data} />
          <ContinueList progress={progress.data} queue={reviews.data} />
        </>
      ) : (
        <Skeleton lines={3} />
      )}
    </div>
  );
}

function ReviewHero({ userId, queue }: { userId: string; queue: ReviewQueue }) {
  const byId = useQuery(problemsByIdQuery(reviewExerciseIds(queue))).data ?? new Map();
  const { start, openSession } = useStartReview(userId, queue, byId);
  const now = Date.now();
  const dueNow = queue.due.filter((card) => Date.parse(card.due) <= now);
  const next = dueNow[0];
  const resume = queue.unfinished.find((session) => session.kind === "review");
  const nextLater = queue.due.find((card) => Date.parse(card.due) > now);
  return (
    <section className="card hero-card" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading">Reviews</h2>
      {dueNow.length > 0 ? (
        <>
          <p className="hero-number">
            <strong>{dueNow.length}</strong> due now
          </p>
          <p className="muted">
            Next up: {byId.get(next?.exerciseId ?? "")?.title ?? "…"}
            {next ? ` · ${LANGUAGE_LABEL[next.language]}` : ""}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={start.isPending || !next || !byId.has(next.exerciseId)}
              onClick={() => next && start.mutate(next)}
            >
              Start next review
            </button>
            <Link to="/reviews" className="button">
              See all
            </Link>
          </div>
          {start.isError && <ErrorNotice error={start.error} />}
        </>
      ) : resume ? (
        <>
          <p className="hero-number">Unfinished review</p>
          <p className="muted">{byId.get(resume.exerciseId)?.title ?? "…"}</p>
          <button type="button" className="primary" onClick={() => void openSession(resume)}>
            Resume
          </button>
        </>
      ) : (
        <>
          <p className="hero-number">All caught up</p>
          <p className="muted">
            {nextLater
              ? `Next review ${formatRelative(nextLater.due, now)}.`
              : "Solve a problem in a learning session to schedule reviews."}
          </p>
          <Link to="/reviews" className="button">
            Open reviews
          </Link>
        </>
      )}
    </section>
  );
}

function Recommended({ userId }: { userId: string }) {
  const pick = useQuery({
    queryKey: ["user", userId, "recommended"],
    queryFn: async () =>
      (await randomProblem({ status: "todo", difficulty: "easy" })) ??
      (await randomProblem({ status: "todo" })),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const problem = pick.data;
  return (
    <section className="card hero-card" aria-labelledby="recommended-heading">
      <h2 id="recommended-heading">Try something new</h2>
      {pick.isPending ? (
        <Skeleton lines={2} />
      ) : problem ? (
        <>
          <p className="hero-number">{problem.title}</p>
          <p className="problem-meta">
            <Badge tone={problem.difficulty}>{problem.difficulty}</Badge>
            {problem.concepts.slice(0, 3).map((concept) => (
              <span key={concept} className="tag">
                {concept}
              </span>
            ))}
          </p>
          <div className="button-row">
            <Link to="/problems/$slug" params={{ slug: problem.slug }} className="button primary">
              Solve it
            </Link>
            <button type="button" onClick={() => void pick.refetch()} disabled={pick.isFetching}>
              Another
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="hero-number">You have tried every problem</p>
          <Link to="/problems" search={{ status: "attempted" }} className="button">
            Finish attempted ones
          </Link>
        </>
      )}
    </section>
  );
}

const WEEKDAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const CELL = 11;
const GAP = 3;

function ActivityCard({ progress }: { progress: Progress }) {
  const today = localDate(new Date(), progress.timezone);
  const { current, longest, activeDays } = streaks(progress.activity, today);
  const grid = useMemo(() => heatmap(progress.activity, today), [progress.activity, today]);
  const yearAttempts = progress.activity.reduce((sum, day) => sum + day.attempts, 0);
  const yearSolved = progress.activity.reduce((sum, day) => sum + day.solved, 0);
  const months = monthLabels(grid);
  // Narrow screens show the most recent weeks first.
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, []);
  const width = 28 + grid.length * (CELL + GAP);
  const height = 16 + 7 * (CELL + GAP);
  return (
    <section className="card activity-card" aria-labelledby="activity-heading">
      <div className="activity-header">
        <h2 id="activity-heading">Activity</h2>
        <dl className="stat-row">
          <div>
            <dt>Current streak</dt>
            <dd>
              {current} {current === 1 ? "day" : "days"}
            </dd>
          </div>
          <div>
            <dt>Longest streak</dt>
            <dd>
              {longest} {longest === 1 ? "day" : "days"}
            </dd>
          </div>
          <div>
            <dt>Active days</dt>
            <dd>{activeDays}</dd>
          </div>
          <div>
            <dt>Past year</dt>
            <dd>
              {yearAttempts} attempts · {yearSolved} solved
            </dd>
          </div>
        </dl>
      </div>
      <div className="heatmap-scroll" ref={scroller}>
        <svg
          className="heatmap"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={`Activity over the past year: ${yearAttempts} attempts on ${activeDays} days.`}
        >
          {months.map(({ label, column }) => (
            <text
              key={`${label}-${column}`}
              x={28 + column * (CELL + GAP)}
              y={10}
              className="heat-label"
            >
              {label}
            </text>
          ))}
          {WEEKDAY_LABELS.map((label, row) =>
            label ? (
              <text key={label} x={0} y={16 + row * (CELL + GAP) + CELL - 2} className="heat-label">
                {label}
              </text>
            ) : null,
          )}
          {grid.map((column, x) =>
            column.map((cell, y) =>
              cell.future ? null : (
                <rect
                  key={cell.date}
                  x={28 + x * (CELL + GAP)}
                  y={16 + y * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  className={`heat heat-${cell.level}`}
                >
                  <title>{cellTitle(cell)}</title>
                </rect>
              ),
            ),
          )}
        </svg>
      </div>
      <p className="heat-legend muted small" aria-hidden="true">
        Less
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={`heat-swatch heat-${level}`} />
        ))}
        More
      </p>
    </section>
  );
}

function cellTitle(cell: HeatCell) {
  const date = new Date(`${cell.date}T12:00:00Z`).toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  if (cell.attempts === 0) return `${date}: no activity`;
  return `${date}: ${cell.attempts} ${cell.attempts === 1 ? "attempt" : "attempts"}, ${cell.solved} solved`;
}

function monthLabels(grid: HeatCell[][]) {
  const labels: { label: string; column: number }[] = [];
  let previous = "";
  grid.forEach((column, index) => {
    const first = column[0]?.date ?? "";
    const month = first.slice(0, 7);
    if (month !== previous) {
      previous = month;
      // Skip a label squeezed into the very first partial column.
      if (index > 0 || column.every((cell) => cell.date.slice(0, 7) === month))
        labels.push({
          label: new Date(`${first}T12:00:00Z`).toLocaleDateString(undefined, {
            month: "short",
            timeZone: "UTC",
          }),
          column: index,
        });
    }
  });
  return labels;
}

function ContinueList({ progress, queue }: { progress: Progress; queue: ReviewQueue | undefined }) {
  const recent = progress.items.slice(0, 6);
  const byId = useQuery(problemsByIdQuery(recent.map((item) => item.exerciseId))).data;
  if (recent.length === 0)
    return (
      <section className="card" aria-labelledby="continue-heading">
        <h2 id="continue-heading">Get started</h2>
        <p className="muted">
          Pick any problem, solve it in the browser, and submit. Solving inside a learning session
          schedules it for spaced-repetition review.
        </p>
        <Link to="/problems" className="button primary">
          Browse problems
        </Link>
      </section>
    );
  const unfinished = new Set(queue?.unfinished.map((session) => session.exerciseId));
  const now = Date.now();
  return (
    <section className="card" aria-labelledby="continue-heading">
      <div className="card-header">
        <h2 id="continue-heading">Recent problems</h2>
        <Link to="/history">History</Link>
      </div>
      <ul className="recent-list">
        {recent.map((item) => {
          const problem = byId?.get(item.exerciseId);
          return (
            <li key={item.exerciseId}>
              <span className={`status-icon status-${item.status}`} aria-hidden="true">
                {item.status === "solved" ? "✓" : "◐"}
              </span>
              {problem ? (
                <Link to="/problems/$slug" params={{ slug: problem.slug }}>
                  {problem.title}
                </Link>
              ) : (
                <span className="muted">{item.exerciseId}</span>
              )}
              <span className="muted small">
                {item.status === "solved" ? "Solved" : "Attempted"} ·{" "}
                {formatRelative(item.lastActivityAt, now)}
              </span>
              {unfinished.has(item.exerciseId) && <Badge tone="pending">session open</Badge>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Landing() {
  const featured = useInfiniteQuery(problemsQuery({ difficulty: "easy" }));
  const items = featured.data?.pages[0]?.items.slice(0, 6) ?? [];
  return (
    <div className="landing">
      <section className="landing-hero">
        <h1>Practice coding problems. Remember how to solve them.</h1>
        <p className="landing-lead">
          Solve JavaScript and TypeScript exercises in the browser, get judged against hidden tests,
          and keep your skills fresh with spaced-repetition reviews.
        </p>
        <div className="button-row">
          <Link to="/sign-up" className="button primary">
            Create a free account
          </Link>
          <Link to="/problems" className="button">
            Browse problems
          </Link>
        </div>
      </section>
      <section className="feature-grid" aria-label="How it works">
        <article className="card">
          <h2>Solve</h2>
          <p className="muted">
            A full code editor with JavaScript and TypeScript, public examples, and one-key Run and
            Submit.
          </p>
        </article>
        <article className="card">
          <h2>Get judged</h2>
          <p className="muted">
            Run against the public examples, then submit against additional hidden tests and see
            per-case results.
          </p>
        </article>
        <article className="card">
          <h2>Review</h2>
          <p className="muted">
            Solved problems come back on an FSRS schedule, so you practise right before you would
            forget.
          </p>
        </article>
      </section>
      {items.length > 0 && (
        <section className="page" aria-labelledby="featured-heading">
          <div className="card-header">
            <h2 id="featured-heading">Start with these</h2>
            <Link to="/problems">All problems</Link>
          </div>
          <ul className="problem-table">
            {items.map((problem) => (
              <li key={problem.id} className="problem-row problem-row-simple">
                <span className="problem-row-main">
                  <Link
                    to="/problems/$slug"
                    params={{ slug: problem.slug }}
                    className="problem-row-title"
                  >
                    {problem.title}
                  </Link>
                </span>
                <Badge tone={problem.difficulty}>{problem.difficulty}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
