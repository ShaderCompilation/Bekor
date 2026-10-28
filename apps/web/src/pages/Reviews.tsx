import type { ReviewCard } from "@bekor/contracts";
import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Badge, EmptyState, ErrorNotice } from "../components/ui";
import { formatDateTime, formatRelative, LANGUAGE_LABEL } from "../format";
import { useStartReview } from "../hooks/useStartReview";
import { problemsByIdQuery, reviewExerciseIds, reviewsQuery } from "../queries";

const route = getRouteApi("/authed/reviews");

export function ReviewsPage() {
  const { user } = route.useRouteContext();
  const queue = useSuspenseQuery(reviewsQuery(user.id)).data;
  const byId = useSuspenseQuery(problemsByIdQuery(reviewExerciseIds(queue))).data;
  const now = Date.now();
  const dueNow = queue.due.filter((card) => Date.parse(card.due) <= now);
  const laterToday = queue.due.filter((card) => Date.parse(card.due) > now);
  const { start, openSession } = useStartReview(user.id, queue, byId);

  const title = (exerciseId: string) => byId.get(exerciseId)?.title ?? exerciseId;
  const cardRow = (card: ReviewCard) => {
    const overdue = Date.parse(card.due) <= now;
    return (
      <li key={card.id} className="review-row">
        <span>
          <strong>{title(card.exerciseId)}</strong>{" "}
          <span className="tag">
            {LANGUAGE_LABEL[card.language]}
            {card.framework ? ` · ${card.framework} · Self-assessed` : ""}
          </span>
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
                  <span className="tag">
                    {LANGUAGE_LABEL[session.language]}
                    {session.framework ? ` · ${session.framework} · Self-assessed` : ""}
                  </span>{" "}
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
            <Link to="/problems">Browse problems</Link>
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
