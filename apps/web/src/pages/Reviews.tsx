import type { PracticeSession, ReviewCard } from "@bekor/contracts";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { api, errorCode } from "../api";
import { Badge, EmptyState, ErrorNotice } from "../components/ui";
import { formatDateTime, formatRelative, LANGUAGE_LABEL } from "../format";
import { problemsQuery, reviewsQuery } from "../queries";

const route = getRouteApi("/authed/reviews");

export function ReviewsPage() {
  const { user } = route.useRouteContext();
  const queue = useSuspenseQuery(reviewsQuery(user.id)).data;
  const problems = useSuspenseQuery(problemsQuery).data;
  const byId = new Map(problems.map((problem) => [problem.id, problem]));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const now = Date.now();
  const dueNow = queue.due.filter((card) => Date.parse(card.due) <= now);
  const laterToday = queue.due.filter((card) => Date.parse(card.due) > now);

  const openSession = (session: PracticeSession) => {
    const problem = byId.get(session.exerciseId);
    return navigate({
      to: "/problems/$slug",
      params: { slug: problem?.slug ?? session.exerciseId },
      search: { session: session.id, language: session.language },
    });
  };
  const start = useMutation({
    mutationFn: async (card: ReviewCard) => {
      const problem = byId.get(card.exerciseId);
      if (!problem) throw new Error("This problem is no longer in the catalog.");
      try {
        return await api.startSession({
          exerciseId: card.exerciseId,
          exerciseVersion: problem.version,
          language: card.language,
          kind: "review",
        });
      } catch (error) {
        // An active session on an older version must be resumed with its own version.
        const active = queue.unfinished.find(
          (session) =>
            session.exerciseId === card.exerciseId &&
            session.language === card.language &&
            session.kind !== "practice",
        );
        if (errorCode(error) === "SESSION_MISMATCH" && active) return active;
        throw error;
      }
    },
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: reviewsQuery(user.id).queryKey });
      await openSession(session);
    },
  });

  const title = (exerciseId: string) => byId.get(exerciseId)?.title ?? exerciseId;
  const cardRow = (card: ReviewCard) => {
    const overdue = Date.parse(card.due) <= now;
    return (
      <li key={card.id} className="review-row">
        <span>
          <strong>{title(card.exerciseId)}</strong>{" "}
          <span className="tag">{LANGUAGE_LABEL[card.language]}</span>
        </span>
        <span className="muted" title={formatDateTime(card.due, queue.timezone)}>
          {overdue
            ? `due ${formatRelative(card.due, now)}`
            : `due ${formatDateTime(card.due, queue.timezone)}`}
        </span>
        <button
          type="button"
          className="primary"
          onClick={() => start.mutate(card)}
          disabled={start.isPending}
        >
          Start review
        </button>
      </li>
    );
  };

  return (
    <div className="page">
      <h1>Reviews</h1>
      <p className="muted">
        Day boundaries use {queue.timezone}; up to {queue.dailyReviewLimit} reviews are shown per
        day. <Link to="/settings">Change</Link>
      </p>
      {start.isError && <ErrorNotice error={start.error} />}

      {queue.unfinished.length > 0 && (
        <section>
          <h2>Unfinished sessions</h2>
          <ul className="review-list">
            {queue.unfinished.map((session) => (
              <li key={session.id} className="review-row">
                <span>
                  <strong>{title(session.exerciseId)}</strong>{" "}
                  <span className="tag">{LANGUAGE_LABEL[session.language]}</span>{" "}
                  <Badge tone="pending">{session.kind}</Badge>
                  {session.hintUsed && <Badge tone="warn">hint</Badge>}
                  {session.solutionRevealed && <Badge tone="warn">revealed</Badge>}
                </span>
                <span className="muted">started {formatRelative(session.createdAt, now)}</span>
                <button type="button" onClick={() => void openSession(session)}>
                  Resume
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Due today</h2>
        {queue.due.length === 0 ? (
          <EmptyState title="All done for today">
            <p className="muted">
              Nothing is due. Solve a problem in a scheduled session to add it to your reviews.
            </p>
            <Link to="/">Browse problems</Link>
          </EmptyState>
        ) : (
          <>
            {dueNow.length > 0 && <ul className="review-list">{dueNow.map(cardRow)}</ul>}
            {laterToday.length > 0 && (
              <>
                <h3>Later today</h3>
                <ul className="review-list">{laterToday.map(cardRow)}</ul>
              </>
            )}
            {queue.hasMore && (
              <p className="muted">
                More reviews are due beyond today's limit; they will appear as you finish these.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
