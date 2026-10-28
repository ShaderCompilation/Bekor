import type {
  Completion,
  Language,
  PracticeSession,
  PublicExercise,
  Submission,
  SubmissionCreate,
} from "@bekor/contracts";
import { isDomExercise } from "@bekor/contracts";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, api, type SessionUser } from "../api";
import { judgedSource, SubmissionResult } from "../components/SubmissionResult";
import { Badge, ErrorNotice, PageLoading } from "../components/ui";
import { formatJson, LANGUAGE_LABEL, submissionLabel, submissionTone } from "../format";
import {
  isTerminal,
  POLL_LIMIT_MS,
  problemQuery,
  recentSubmissionsQuery,
  reviewsQuery,
  submissionQuery,
} from "../queries";
import { draftKey, useDrafts } from "../stores/drafts";
import { usePreferences } from "../stores/preferences";
import { SessionPanel } from "./Session";

const DomProblem = lazy(() => import("./DomProblem"));
const CodeEditor = lazy(() => import("../components/CodeEditor"));
const route = getRouteApi("/problems/$slug");

function useNarrowScreen() {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia("(max-width: 760px)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia("(max-width: 760px)").matches,
  );
}

export function ProblemPage() {
  const { slug } = route.useParams();
  const { user } = route.useRouteContext();
  const latest = useSuspenseQuery(problemQuery(slug)).data;
  if (isDomExercise(latest))
    return (
      <Suspense fallback={<PageLoading />}>
        <DomProblem exercise={latest} user={user} />
      </Suspense>
    );
  return <NodeProblemPage />;
}
function NodeProblemPage() {
  const { slug } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { user } = route.useRouteContext();
  const detail = useSuspenseQuery(problemQuery(slug)).data;
  if (isDomExercise(detail)) throw new Error("Expected a Node exercise");
  const latest = detail;
  const reviews = useQuery({ ...reviewsQuery(user?.id ?? ""), enabled: Boolean(user) });
  const preferred = usePreferences((state) => state.language);
  const setPreferred = usePreferences((state) => state.setLanguage);
  // The completion result outlives the active session, which leaves the unfinished list.
  const [completion, setCompletion] = useState<Completion | null>(null);

  const session =
    search.session && reviews.data
      ? (reviews.data.unfinished.find(
          (item) => item.id === search.session && item.exerciseId === latest.id,
        ) ?? null)
      : null;
  const language: Language = session?.language ?? search.language ?? preferred;
  const version = session?.exerciseVersion ?? latest.version;
  const pinned = useQuery({ ...problemQuery(slug, version), enabled: version !== latest.version });
  const candidate = version === latest.version ? latest : pinned.data;
  const exercise = candidate && !isDomExercise(candidate) ? candidate : undefined;

  const changeLanguage = (next: Language) => {
    setPreferred(next);
    void navigate({ search: (previous) => ({ ...previous, language: next }), replace: true });
  };
  const openSession = (next: PracticeSession | null) => {
    setCompletion(null);
    void navigate({
      search: (previous) => {
        const { session: _drop, ...rest } = previous;
        return next ? { ...rest, session: next.id, language: next.language } : rest;
      },
    });
  };

  let sessionState: "free" | "loading" | "active" | "completed" | "missing" = "free";
  if (search.session) {
    if (completion?.session.id === search.session) sessionState = "completed";
    else if (!user || reviews.isPending) sessionState = user ? "loading" : "missing";
    else sessionState = session ? "active" : "missing";
  }

  return (
    <div className="problem-page">
      <Statement exercise={exercise ?? latest} language={language} showHints={!session} />
      <div className="solve-column">
        {!user ? (
          <div className="notice">
            <p>Sign in to run and submit solutions and to schedule reviews.</p>
            <Link to="/sign-in" search={{ redirect: `/problems/${slug}` }}>
              Sign in
            </Link>
          </div>
        ) : sessionState === "loading" || !exercise ? (
          pinned.isError ? (
            <ErrorNotice error={pinned.error} />
          ) : (
            <PageLoading />
          )
        ) : (
          <>
            {sessionState === "missing" && (
              <div className="notice notice-warn" role="status">
                <p>This session is finished or no longer available.</p>
                <button type="button" onClick={() => openSession(null)}>
                  Continue without a session
                </button>
              </div>
            )}
            <SessionPanel
              user={user}
              exercise={exercise}
              language={language}
              session={session}
              unfinished={reviews.data?.unfinished ?? []}
              completion={sessionState === "completed" ? completion : null}
              onOpen={openSession}
              onCompleted={setCompletion}
            />
            {sessionState !== "completed" && sessionState !== "missing" && (
              <Workspace
                key={draftKey({
                  userId: user.id,
                  exerciseId: exercise.id,
                  version: exercise.version,
                  language,
                  sessionId: session?.id ?? null,
                })}
                user={user}
                exercise={exercise}
                language={language}
                session={session}
                onLanguageChange={changeLanguage}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Paragraphs({ text }: { text: string }) {
  // Content is rendered as plain text (no HTML), split into paragraphs.
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((paragraph, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static text split
          <p key={index}>{paragraph}</p>
        ))}
    </>
  );
}

function Statement({
  exercise,
  language,
  showHints,
}: {
  exercise: PublicExercise;
  language: Language;
  showHints: boolean;
}) {
  const variant = exercise.variants[language];
  return (
    <article className="statement" aria-labelledby="problem-title">
      <h1 id="problem-title">{exercise.title}</h1>
      <p className="problem-meta">
        <Badge tone={exercise.difficulty}>{exercise.difficulty}</Badge>
        {exercise.concepts.map((concept) => (
          <span key={concept} className="tag">
            {concept}
          </span>
        ))}
        <span className="muted">v{exercise.version}</span>
      </p>
      <Paragraphs text={exercise.description} />
      <h2>Signature</h2>
      <pre className="code">
        <code>{variant.signature}</code>
      </pre>
      <p className="muted">
        Export <code>{variant.entrypoint}</code> from <code>{variant.filename}</code>. Time limit{" "}
        {variant.limits.timeMs} ms per test.
      </p>
      <h2>Examples</h2>
      <ol className="examples">
        {variant.publicTests.map((test, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed public test order
          <li key={index}>
            <code>
              {variant.entrypoint}({test.args.map(formatJson).join(", ")})
            </code>{" "}
            → <code>{formatJson(test.expected)}</code>
          </li>
        ))}
      </ol>
      {showHints && exercise.hints.length > 0 && (
        <details className="hints">
          <summary>Hints ({exercise.hints.length})</summary>
          <ol>
            {exercise.hints.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ol>
        </details>
      )}
      <p className="attribution muted">{exercise.attribution}</p>
    </article>
  );
}

function Workspace({
  user,
  exercise,
  language,
  session,
  onLanguageChange,
}: {
  user: SessionUser;
  exercise: PublicExercise;
  language: Language;
  session: PracticeSession | null;
  onLanguageChange: (language: Language) => void;
}) {
  const queryClient = useQueryClient();
  const variant = exercise.variants[language];
  const key = draftKey({
    userId: user.id,
    exerciseId: exercise.id,
    version: exercise.version,
    language,
    sessionId: session?.id ?? null,
  });
  const stored = useDrafts((state) => state.drafts[key]?.source);
  const save = useDrafts((state) => state.save);
  const source = stored ?? variant.starter;
  const fontSize = usePreferences((state) => state.editorFontSize);
  const narrow = useNarrowScreen();

  const recent = useQuery(recentSubmissionsQuery(user.id));
  const attempts = (recent.data ?? []).filter(
    (item) =>
      item.exerciseId === exercise.id &&
      item.language === language &&
      item.exerciseVersion === exercise.version &&
      item.practiceSessionId === (session?.id ?? null),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const shownId = activeId ?? attempts[0]?.id ?? null;
  const shown = useQuery({ ...submissionQuery(user.id, shownId ?? ""), enabled: Boolean(shownId) });

  const create = useMutation({
    mutationFn: (input: SubmissionCreate) => api.submit(input),
    // Network failures retry with the same idempotency key, so the server keeps one submission.
    retry: (count, error) => count < 2 && !(error instanceof ApiError),
    onSuccess: (submission) => {
      queryClient.setQueryData(submissionQuery(user.id, submission.id).queryKey, submission);
      setActiveId(submission.id);
      void queryClient.invalidateQueries({ queryKey: ["user", user.id, "submissions"] });
    },
  });

  const status = shown.data?.status;
  useEffect(() => {
    // A finished judgement changes history and session evidence.
    if (status === "completed" || status === "infrastructure_error")
      void queryClient.invalidateQueries({ queryKey: ["user", user.id, "submissions"] });
  }, [status, queryClient, user.id]);

  const judging =
    shown.data !== undefined &&
    !isTerminal(shown.data) &&
    Date.now() - Date.parse(shown.data.createdAt) < POLL_LIMIT_MS;
  const busy = create.isPending || judging;

  const send = (mode: "run" | "submit") => {
    if (busy) return;
    create.mutate({
      exerciseId: exercise.id,
      exerciseVersion: exercise.version,
      language,
      files: { [variant.filename]: source },
      mode,
      idempotencyKey: crypto.randomUUID(),
      ...(session ? { practiceSessionId: session.id } : {}),
    });
  };
  const reset = () => {
    if (window.confirm("Replace your code with the starter code? Your current draft is lost."))
      save(key, variant.starter);
  };

  return (
    <section className="workspace" aria-label="Solution workspace">
      {narrow && (
        <div className="notice" role="note">
          <p>Code editing is designed for larger screens. The editor may be hard to use here.</p>
        </div>
      )}
      <div className="toolbar">
        <label>
          <span className="visually-hidden">Language</span>
          <select
            value={language}
            onChange={(event) => onLanguageChange(event.target.value as Language)}
            disabled={Boolean(session)}
            title={session ? "A session is fixed to one language" : undefined}
          >
            {(["javascript", "typescript"] as const).map((item) => (
              <option key={item} value={item}>
                {LANGUAGE_LABEL[item]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={reset} disabled={source === variant.starter}>
          Reset
        </button>
        <span className="toolbar-spacer" />
        <button
          type="button"
          onClick={() => send("run")}
          disabled={busy}
          aria-keyshortcuts="Control+Enter"
          title="Run public tests (Ctrl/Cmd+Enter)"
        >
          Run
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => send("submit")}
          disabled={busy}
          aria-keyshortcuts="Control+Shift+Enter"
          title="Submit against all tests (Ctrl/Cmd+Shift+Enter)"
        >
          Submit
        </button>
      </div>
      <div className="editor-frame">
        <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
          <CodeEditor
            path={`file:///${encodeURIComponent(key)}/${variant.filename}`}
            language={language}
            value={source}
            fontSize={fontSize}
            onChange={(value) => save(key, value)}
            onRun={() => send("run")}
            onSubmit={() => send("submit")}
          />
        </Suspense>
      </div>
      <p className="muted small">
        Drafts are saved in this browser. Ctrl/Cmd+Enter runs, Ctrl/Cmd+Shift+Enter submits. In the
        editor, Ctrl+M toggles whether Tab moves focus.
      </p>
      {create.isError && <ErrorNotice error={create.error} />}
      {shown.data ? (
        <SubmissionResult
          submission={shown.data}
          variant={variant}
          currentSource={source}
          onLoadSource={(code) => save(key, code)}
          onRefresh={() => void shown.refetch()}
        />
      ) : shown.isError ? (
        <ErrorNotice error={shown.error} />
      ) : null}
      {attempts.length > 0 && (
        <Attempts attempts={attempts} shownId={shownId} onShow={setActiveId} />
      )}
    </section>
  );
}

function Attempts({
  attempts,
  shownId,
  onShow,
}: {
  attempts: Submission[];
  shownId: string | null;
  onShow: (id: string) => void;
}) {
  return (
    <details className="attempts">
      <summary>Earlier attempts here ({attempts.length})</summary>
      <ul>
        {attempts.slice(0, 20).map((attempt) => (
          <li key={attempt.id}>
            <button
              type="button"
              className="link-button"
              onClick={() => onShow(attempt.id)}
              aria-current={attempt.id === shownId}
            >
              {new Date(attempt.createdAt).toLocaleTimeString()} · {attempt.mode}
            </button>{" "}
            <Badge tone={submissionTone(attempt)}>{submissionLabel(attempt)}</Badge>{" "}
            {judgedSource(attempt) !== undefined && (
              <Link to="/submissions/$id" params={{ id: attempt.id }}>
                details
              </Link>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
