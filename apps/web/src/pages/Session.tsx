import type {
  AssistanceKind,
  Completion,
  Language,
  PracticeSession,
  PublicExercise,
  Rating,
  Reveal,
} from "@bekor/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, errorCode, type SessionUser } from "../api";
import { ErrorNotice } from "../components/ui";
import { formatDateTime, formatRelative, LANGUAGE_LABEL, RATING_LABEL } from "../format";
import { recentSubmissionsQuery, reviewsQuery } from "../queries";
import { ratingBlocker } from "../rules";
import { draftKey, readDraft, useDrafts } from "../stores/drafts";
import { toast } from "../stores/toasts";

const KIND_LABEL = {
  learning: "Learning session",
  review: "Review session",
  practice: "Practice session (unscheduled)",
} as const;

const RATINGS: Rating[] = ["again", "hard", "good", "easy"];

interface Props {
  user: SessionUser;
  exercise: PublicExercise;
  language: Language;
  session: PracticeSession | null;
  unfinished: PracticeSession[];
  completion: Completion | null;
  onOpen: (session: PracticeSession | null) => void;
  onCompleted: (completion: Completion) => void;
}

export function SessionPanel(props: Props) {
  if (props.completion) return <CompletionSummary {...props} completion={props.completion} />;
  if (props.session) return <ActiveSession {...props} session={props.session} />;
  return <StartSession {...props} />;
}

function StartSession({ user, exercise, language, unfinished, onOpen }: Props) {
  const queryClient = useQueryClient();
  const save = useDrafts((state) => state.save);
  const existing = unfinished.find(
    (item) => item.exerciseId === exercise.id && item.language === language,
  );
  const scope = { userId: user.id, exerciseId: exercise.id, language };
  const start = useMutation({
    mutationFn: async (kind: "schedule" | "practice") => {
      const base = { exerciseId: exercise.id, exerciseVersion: exercise.version, language };
      if (kind === "practice") return api.startSession({ ...base, kind: "practice" });
      try {
        return await api.startSession({ ...base, kind: "learning" });
      } catch (error) {
        // Already enrolled: the scheduled path for this problem is a review.
        if (errorCode(error) === "ALREADY_ENROLLED")
          return api.startSession({ ...base, kind: "review" });
        throw error;
      }
    },
    onSuccess: (session) => {
      // Learning and practice may continue the free draft. Reviews always start from the
      // starter, and a resumed session keeps its own draft.
      const target = draftKey({
        ...scope,
        version: session.exerciseVersion,
        sessionId: session.id,
      });
      const free = readDraft(
        draftKey({ ...scope, version: session.exerciseVersion, sessionId: null }),
      );
      if (session.kind !== "review" && free !== undefined && readDraft(target) === undefined)
        save(target, free);
      void queryClient.invalidateQueries({ queryKey: reviewsQuery(user.id).queryKey });
      onOpen(session);
    },
  });
  return (
    <section className="session-panel" aria-label="Practice session">
      {existing ? (
        <p>
          You have an unfinished {KIND_LABEL[existing.kind].toLowerCase()} for{" "}
          {LANGUAGE_LABEL[language]}, started {formatRelative(existing.createdAt)}.{" "}
          <button type="button" className="primary" onClick={() => onOpen(existing)}>
            Resume it
          </button>
        </p>
      ) : (
        <>
          <p>
            <strong>Free practice.</strong> Attempts here are saved to history but do not schedule
            reviews.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={() => start.mutate("schedule")}
              disabled={start.isPending}
            >
              Start scheduled session
            </button>
            <button
              type="button"
              onClick={() => start.mutate("practice")}
              disabled={start.isPending}
            >
              Start unscheduled session
            </button>
          </div>
          <p className="muted small">
            A scheduled session enrolls this problem in {LANGUAGE_LABEL[language]} for spaced review
            (or reviews it if already enrolled). Finish it by rating how well you recalled the
            solution.
          </p>
        </>
      )}
      {start.isError && <ErrorNotice error={start.error} />}
    </section>
  );
}

function ActiveSession({
  user,
  exercise,
  session,
  onOpen,
  onCompleted,
}: Props & { session: PracticeSession }) {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<Reveal | null>(null);
  const recent = useQuery(recentSubmissionsQuery(user.id));
  const attempts = (recent.data ?? []).filter(
    (item) => item.practiceSessionId === session.id && item.status === "completed",
  );
  const evidence = {
    kind: session.kind,
    accepted: attempts.some((item) => item.mode === "submit" && item.verdict === "accepted"),
    unsuccessful: attempts.some((item) => item.verdict !== null && item.verdict !== "accepted"),
    revealed: session.solutionRevealed,
  };
  const refreshQueue = () =>
    queryClient.invalidateQueries({ queryKey: reviewsQuery(user.id).queryKey });

  const assistance = useMutation({
    mutationFn: (kind: Exclude<AssistanceKind, "solution_reveal">) =>
      api.assistance(session.id, kind),
    onSuccess: refreshQueue,
  });
  const reveal = useMutation({
    mutationFn: () => api.reveal(session.id),
    onSuccess: (data) => {
      setRevealed(data);
      void refreshQueue();
    },
  });
  const complete = useMutation({
    mutationFn: (rating: Rating) => api.completeSession(session.id, rating),
    onSuccess: (data) => {
      onCompleted(data);
      void refreshQueue();
      toast(
        data.card ? `Saved. Next review ${formatDateTime(data.card.due)}.` : "Session completed.",
        "ok",
      );
    },
  });

  const confirmReveal = () => {
    if (
      session.solutionRevealed ||
      window.confirm("Reveal the reference solution? This session can then only be rated Again.")
    )
      reveal.mutate();
  };
  const confirmHelp = () => {
    if (
      window.confirm(
        "Record that you used outside help? This session can then only be rated Again.",
      )
    )
      assistance.mutate("external_help");
  };
  const scheduled = session.kind !== "practice";

  return (
    <section className="session-panel" aria-label={KIND_LABEL[session.kind]}>
      <header className="session-header">
        <h2>{KIND_LABEL[session.kind]}</h2>
        <button type="button" className="link-button" onClick={() => onOpen(null)}>
          Leave session
        </button>
      </header>
      <p className="muted small">
        Started {formatRelative(session.createdAt)} · {LANGUAGE_LABEL[session.language]} · v
        {session.exerciseVersion}. Leaving keeps it unfinished; resume it from Reviews.
        {session.kind === "review" && " Reviews start from the starter code."}
      </p>
      {exercise.hints.length > 0 &&
        (session.hintUsed ? (
          <details className="hints" open>
            <summary>Hints (use recorded)</summary>
            <ol>
              {exercise.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ol>
          </details>
        ) : (
          <button
            type="button"
            onClick={() => assistance.mutate("hint")}
            disabled={assistance.isPending}
          >
            Show hints (recorded)
          </button>
        ))}{" "}
      <button type="button" onClick={confirmReveal} disabled={reveal.isPending}>
        {session.solutionRevealed ? "Show revealed solution" : "Reveal solution"}
      </button>{" "}
      {!session.solutionRevealed && (
        <button type="button" onClick={confirmHelp} disabled={assistance.isPending}>
          I used outside help
        </button>
      )}
      {assistance.isError && <ErrorNotice error={assistance.error} />}
      {reveal.isError && <ErrorNotice error={reveal.error} />}
      {revealed && (
        <div className="reveal">
          <h3>Explanation</h3>
          <p className="prewrap">{revealed.explanation}</p>
          <h3>Reference solution</h3>
          <pre className="code">
            <code>{revealed.solution}</code>
          </pre>
        </div>
      )}
      <fieldset className="ratings">
        <legend>{scheduled ? "Finish and rate your recall" : "Finish session"}</legend>
        <div className="rating-grid">
          {RATINGS.map((rating) => {
            const blocker = ratingBlocker(evidence, rating);
            return (
              <button
                key={rating}
                type="button"
                className={`rating rating-${rating}`}
                disabled={Boolean(blocker) || complete.isPending}
                onClick={() => complete.mutate(rating)}
                aria-describedby={`rating-${rating}-help`}
              >
                <strong>{RATING_LABEL[rating].label}</strong>
                <span id={`rating-${rating}-help`} className="small">
                  {blocker ?? RATING_LABEL[rating].description}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>
      {complete.isError && <ErrorNotice error={complete.error} />}
    </section>
  );
}

function CompletionSummary({ completion, onOpen }: Props & { completion: Completion }) {
  const { session, card } = completion;
  return (
    <section className="session-panel notice-ok" aria-live="polite">
      <h2>Session complete</h2>
      <p>
        Rated <strong>{session.rating ? RATING_LABEL[session.rating].label : "—"}</strong>.{" "}
        {card
          ? `Next review ${formatRelative(card.due)} (${formatDateTime(card.due)}).`
          : "Unscheduled practice does not change your review schedule."}
      </p>
      <div className="button-row">
        <Link to="/reviews" className="button primary">
          Back to reviews
        </Link>
        <button type="button" onClick={() => onOpen(null)}>
          Keep practicing freely
        </button>
      </div>
    </section>
  );
}
