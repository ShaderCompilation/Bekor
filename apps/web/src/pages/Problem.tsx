import type {
  Completion,
  Language,
  LanguageVariant,
  PracticeSession,
  PublicExercise,
  Submission,
  SubmissionCreate,
} from "@bekor/contracts";
import { isDomExercise } from "@bekor/contracts";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
  type CSSProperties,
  type KeyboardEvent,
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiError, api, type SessionUser } from "../api";
import { ProblemShell } from "../components/ProblemShell";
import { Splitter } from "../components/Splitter";
import { judgedSource, SubmissionResult } from "../components/SubmissionResult";
import { Tabs } from "../components/Tabs";
import { Badge, ErrorNotice, PageLoading, useDraftStatus } from "../components/ui";
import { formatJson, LANGUAGE_LABEL, submissionLabel, submissionTone } from "../format";
import {
  invalidateProgress,
  isTerminal,
  POLL_LIMIT_MS,
  problemQuery,
  recentSubmissionsQuery,
  reviewsQuery,
  submissionQuery,
} from "../queries";
import { draftKey, useDrafts } from "../stores/drafts";
import { usePreferences } from "../stores/preferences";
import { toast } from "../stores/toasts";
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
    <ProblemShell
      exercise={exercise ?? latest}
      user={user}
      statement={
        <Statement exercise={exercise ?? latest} language={language} showHints={!session} />
      }
    >
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
    </ProblemShell>
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
  const [tab, setTab] = useState<"description" | "hints">("description");
  const variant = exercise.variants[language];
  const description = (
    <article className="statement" aria-labelledby="problem-title">
      <h1 id="problem-title">{exercise.title}</h1>
      <p className="problem-meta">
        <Badge tone={exercise.difficulty}>{exercise.difficulty}</Badge>
        {exercise.concepts.map((concept) => (
          <Link key={concept} to="/problems" search={{ concept }} className="tag">
            {concept}
          </Link>
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
      <p className="attribution muted">{exercise.attribution}</p>
    </article>
  );
  // Hints inside a session go through the recorded flow in the session panel instead.
  if (!showHints || exercise.hints.length === 0) return description;
  return (
    <Tabs
      label="Problem"
      selected={tab}
      onSelect={setTab}
      tabs={[
        { id: "description", label: "Description", content: description },
        {
          id: "hints",
          label: `Hints (${exercise.hints.length})`,
          content: (
            <div className="statement">
              <h2>Hints</h2>
              <p className="muted">Try the problem first; reveal hints one at a time.</p>
              <ol className="hint-list">
                {exercise.hints.map((hint, index) => (
                  <li key={hint}>
                    <details>
                      <summary>Hint {index + 1}</summary>
                      <p>{hint}</p>
                    </details>
                  </li>
                ))}
              </ol>
            </div>
          ),
        },
      ]}
    />
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
  const wordWrap = usePreferences((state) => state.wordWrap);
  const consoleHeight = usePreferences((state) => state.consoleHeight);
  const setSizes = usePreferences((state) => state.setPaneSizes);
  const narrow = useNarrowScreen();
  const split = useRef<HTMLDivElement>(null);
  const editorId = useId();
  const draft = useDraftStatus();
  // Until the learner picks a tab, show the latest result when there is one.
  const [tab, setTab] = useState<"cases" | "result" | "attempts" | null>(null);

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
  const consoleTab = tab ?? (shownId ? "result" : "cases");
  const shown = useQuery({ ...submissionQuery(user.id, shownId ?? ""), enabled: Boolean(shownId) });

  const create = useMutation({
    mutationFn: (input: SubmissionCreate) => api.submit(input),
    // Network failures retry with the same idempotency key, so the server keeps one submission.
    retry: (count, error) => count < 2 && !(error instanceof ApiError),
    onSuccess: (submission) => {
      queryClient.setQueryData(submissionQuery(user.id, submission.id).queryKey, submission);
      setActiveId(submission.id);
      setTab("result");
      void queryClient.invalidateQueries({ queryKey: ["user", user.id, "submissions"] });
    },
  });

  const status = shown.data?.status;
  // Announce verdicts of submissions made here, once each (not ones loaded from history).
  const announced = useRef(new Set<string>());
  useEffect(() => {
    const submission = shown.data;
    if (!submission || submission.id !== activeId || !isTerminal(submission)) return;
    if (announced.current.has(submission.id)) return;
    announced.current.add(submission.id);
    const tone = submissionTone(submission);
    const label = submission.mode === "run" ? "Run" : "Submission";
    toast(`${label}: ${submissionLabel(submission)}`, tone === "pending" ? "info" : tone);
  }, [shown.data, activeId]);
  useEffect(() => {
    // A finished judgement changes history and session evidence.
    if (status === "completed" || status === "infrastructure_error") {
      void queryClient.invalidateQueries({ queryKey: ["user", user.id, "submissions"] });
      void invalidateProgress(queryClient, user.id);
    }
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

  // The editor handles these itself; this covers focus on the toolbar, tabs and results.
  const onShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter" || event.altKey) return;
    // Also stops Enter from activating a focused button a second time.
    event.preventDefault();
    send(event.shiftKey ? "submit" : "run");
  };

  return (
    <section
      className="workspace workspace-node"
      aria-label="Solution workspace"
      onKeyDown={onShortcut}
    >
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
        <EditorSettings />
        <span className="toolbar-spacer" />
        {draft.status}
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
      <div
        ref={split}
        className="editor-console"
        style={{ "--console-height": `${consoleHeight}%` } as CSSProperties}
      >
        <div className="editor-frame" id={editorId}>
          <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
            <CodeEditor
              path={`file:///${encodeURIComponent(key)}/${variant.filename}`}
              language={language}
              value={source}
              fontSize={fontSize}
              wordWrap={wordWrap}
              onChange={(value) => save(key, value)}
              onRun={() => send("run")}
              onSubmit={() => send("submit")}
              onSave={draft.confirm}
            />
          </Suspense>
        </div>
        <Splitter
          orientation="horizontal"
          value={100 - consoleHeight}
          min={25}
          max={85}
          onChange={(editorHeight) => setSizes({ consoleHeight: 100 - editorHeight })}
          container={split}
          label="Resize editor and results"
          controls={editorId}
        />
        <div className="console">
          <Tabs
            label="Results"
            selected={consoleTab}
            onSelect={setTab}
            tabs={[
              {
                id: "cases",
                label: "Test cases",
                content: (
                  <TestCases
                    variant={variant}
                    results={
                      shown.data?.exerciseVersion === exercise.version &&
                      shown.data.language === language
                        ? shown.data.publicResults
                        : []
                    }
                  />
                ),
              },
              {
                id: "result",
                label: (
                  <>
                    Result
                    {shown.data && (
                      <span className={`tab-dot tab-dot-${submissionTone(shown.data)}`} />
                    )}
                  </>
                ),
                content: shown.data ? (
                  <SubmissionResult
                    submission={shown.data}
                    variant={variant}
                    currentSource={source}
                    onLoadSource={(code) => save(key, code)}
                    onRefresh={() => void shown.refetch()}
                  />
                ) : shown.isError ? (
                  <ErrorNotice error={shown.error} />
                ) : (
                  <p className="muted console-empty">
                    Run your code to check it against the examples, or Submit to run every test.
                  </p>
                ),
              },
              {
                id: "attempts",
                label: `Attempts (${attempts.length})`,
                content: (
                  <Attempts
                    attempts={attempts}
                    shownId={shownId}
                    onShow={(id) => {
                      setActiveId(id);
                      setTab("result");
                    }}
                  />
                ),
              },
            ]}
          />
        </div>
      </div>
      {create.isError && <ErrorNotice error={create.error} />}
      <p className="muted small">
        Drafts save as you type. Press <kbd>?</kbd> for keyboard shortcuts.
      </p>
    </section>
  );
}

function EditorSettings() {
  const fontSize = usePreferences((state) => state.editorFontSize);
  const setFontSize = usePreferences((state) => state.setEditorFontSize);
  const wordWrap = usePreferences((state) => state.wordWrap);
  const setWordWrap = usePreferences((state) => state.setWordWrap);
  return (
    <details className="popover">
      <summary className="button">
        <span aria-hidden="true">⚙ </span>Editor
      </summary>
      <div className="popover-body">
        <div className="popover-row">
          <span>Font size</span>
          <span className="stepper">
            <button
              type="button"
              aria-label="Smaller font"
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
            >
              −
            </button>
            <output aria-live="polite">{fontSize}px</output>
            <button
              type="button"
              aria-label="Larger font"
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 24}
            >
              +
            </button>
          </span>
        </div>
        <label className="popover-row">
          Word wrap
          <input
            type="checkbox"
            checked={wordWrap}
            onChange={(event) => setWordWrap(event.target.checked)}
          />
        </label>
      </div>
    </details>
  );
}

function TestCases({
  variant,
  results,
}: {
  variant: LanguageVariant;
  results: Submission["publicResults"];
}) {
  const byIndex = new Map(results.map((result) => [result.caseIndex, result]));
  return (
    <ol className="test-cases">
      {variant.publicTests.map((test, index) => {
        const result = byIndex.get(index);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed public test order
          <li key={index} className={result ? (result.passed ? "case-pass" : "case-fail") : ""}>
            <div className="case-title">
              <span aria-hidden="true">{result ? (result.passed ? "✓" : "✗") : "•"}</span> Example{" "}
              {index + 1}
              {result && (
                <span className="visually-hidden">{result.passed ? " passed" : " failed"}</span>
              )}
            </div>
            <dl className="case-details">
              <dt>Input</dt>
              <dd>
                <code>{test.args.map(formatJson).join(", ")}</code>
              </dd>
              <dt>Expected</dt>
              <dd>
                <code>{formatJson(test.expected)}</code>
              </dd>
              {result?.actual !== undefined && (
                <>
                  <dt>Actual</dt>
                  <dd>
                    <code>{formatJson(result.actual)}</code>
                  </dd>
                </>
              )}
            </dl>
          </li>
        );
      })}
    </ol>
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
    <div className="attempts">
      {attempts.length === 0 && <p className="muted console-empty">No attempts yet.</p>}
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
    </div>
  );
}
