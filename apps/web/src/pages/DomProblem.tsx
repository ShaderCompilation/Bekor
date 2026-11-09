import {
  type Completion,
  type DomExercise,
  type DomVariant,
  isDomExercise,
  MAX_SOURCE_BYTES,
  type PracticeSession,
  type Rating,
  type Reveal,
  type SelfAssessment,
} from "@bekor/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { lazy, Suspense, useRef, useState } from "react";
import { ApiError, api, errorCode, type SessionUser } from "../api";
import { ProblemShell } from "../components/ProblemShell";
import { ErrorNotice, PageLoading, useDraftStatus } from "../components/ui";
import { domRatingBlocker } from "../dom-rules";
import { formatDateTime, RATING_LABEL } from "../format";
import { invalidateProgress, problemQuery, reviewsQuery, selfAssessmentsQuery } from "../queries";
import { draftKey, readDraft, useDrafts } from "../stores/drafts";
import { usePreferences } from "../stores/preferences";
import { toast } from "../stores/toasts";

const Editor = lazy(() => import("../components/CodeEditor"));
const Preview = lazy(() => import("../components/DomPreview"));
const route = getRouteApi("/problems/$slug");
export function domDraftKey(
  userId: string,
  exercise: DomExercise,
  variant: DomVariant,
  sessionId: string | null,
) {
  return `${draftKey({ userId, exerciseId: exercise.id, version: exercise.version, language: variant.language, sessionId })}|${variant.framework}`;
}
function readFiles(key: string, starter: Record<string, string>) {
  try {
    const raw: unknown = JSON.parse(readDraft(key) ?? "null");
    if (
      raw &&
      typeof raw === "object" &&
      Object.keys(raw).length === Object.keys(starter).length &&
      Object.keys(starter).every(
        (path) => typeof (raw as Record<string, unknown>)[path] === "string",
      )
    )
      return raw as Record<string, string>;
  } catch {
    /* invalid local draft falls back to the fixed starter */
  }
  return starter;
}

export default function DomProblem({
  exercise: latest,
  user,
}: {
  exercise: DomExercise;
  user: SessionUser | null;
}) {
  const [completed, setCompleted] = useState<Completion | null>(null);
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const queue = useQuery({ ...reviewsQuery(user?.id ?? ""), enabled: Boolean(user) });
  const session =
    queue.data?.unfinished.find((s) => s.id === search.session && s.exerciseId === latest.id) ??
    null;
  const version = session?.exerciseVersion ?? latest.version;
  const pinned = useQuery({
    ...problemQuery(latest.slug, version),
    enabled: version !== latest.version,
  });
  const candidate = version === latest.version ? latest : pinned.data;
  const exercise = candidate && isDomExercise(candidate) ? candidate : null;
  const open = (next: PracticeSession | null) => {
    setCompleted(null);
    void navigate({
      search: (previous) => {
        const { session: _drop, ...rest } = previous;
        return next
          ? {
              ...rest,
              session: next.id,
              ...(next.framework ? { framework: next.framework } : {}),
              language: next.language,
            }
          : rest;
      },
    });
  };
  if (!exercise) return pinned.isError ? <ErrorNotice error={pinned.error} /> : <PageLoading />;
  const variant =
    exercise.variants.find(
      (v) =>
        v.framework === (session?.framework ?? search.framework) &&
        v.language === (session?.language ?? search.language ?? "javascript"),
    ) ?? exercise.variants[0];
  if (!variant) return <p>This exercise has no available variants.</p>;
  if (user && search.session && queue.isPending) return <PageLoading />;
  if (user && search.session && queue.isError) return <ErrorNotice error={queue.error} />;
  return (
    <ProblemShell
      className="dom-problem"
      exercise={exercise}
      user={user}
      statement={
        <article className="statement">
          <h1>{exercise.title}</h1>
          <p>
            <span className="tag">Self-assessed</span> {exercise.difficulty} · v{exercise.version}
          </p>
          {exercise.description.split(/\n{2,}/).map((text) => (
            <p key={text}>{text}</p>
          ))}
          <h2>Manual verification checklist</h2>
          <ol>
            {exercise.checklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
          <p className="muted">
            Check your own solution in the preview. Rendering does not verify correctness.
          </p>
          <p className="muted">{exercise.attribution}</p>
        </article>
      }
    >
      <div className="solve-column">
        {!user ? (
          <div className="notice">
            <p>Sign in to edit, preview and record your self-assessment.</p>
            <Link to="/sign-in" search={{ redirect: `/problems/${exercise.slug}` }}>
              Sign in
            </Link>
          </div>
        ) : completed && completed.session.id === search.session ? (
          <div className="notice" role="status">
            <h2>Self-assessed completion</h2>
            <p>
              {completed.card
                ? `Next review: ${formatDateTime(completed.card.due)}`
                : "Unscheduled practice recorded."}
            </p>
            <button type="button" onClick={() => open(null)}>
              Continue practicing
            </button>
            <Link to="/reviews">Reviews</Link>
          </div>
        ) : search.session && !session ? (
          <div className="notice">
            <p>This session is finished or unavailable.</p>
            <button type="button" onClick={() => open(null)}>
              Continue practicing
            </button>
          </div>
        ) : (
          <DomWorkspace
            key={domDraftKey(user.id, exercise, variant, session?.id ?? null)}
            user={user}
            exercise={exercise}
            variant={variant}
            session={session}
            unfinished={queue.data?.unfinished ?? []}
            onOpen={open}
            onCompleted={setCompleted}
            onVariant={(id) => {
              const next = exercise.variants.find((v) => v.id === id);
              if (next)
                void navigate({
                  search: (previous) => ({
                    ...previous,
                    framework: next.framework,
                    language: next.language,
                  }),
                });
            }}
          />
        )}
      </div>
    </ProblemShell>
  );
}

function DomWorkspace({
  user,
  exercise,
  variant,
  session,
  unfinished,
  onOpen,
  onCompleted,
  onVariant,
}: {
  user: SessionUser;
  exercise: DomExercise;
  variant: DomVariant;
  session: PracticeSession | null;
  unfinished: PracticeSession[];
  onOpen: (session: PracticeSession | null) => void;
  onCompleted: (completion: Completion) => void;
  onVariant: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const key = domDraftKey(user.id, exercise, variant, session?.id ?? null);
  const stored = useDrafts((state) => state.drafts[key]?.source);
  const save = useDrafts((state) => state.save);
  const files = stored === undefined ? variant.files : readFiles(key, variant.files);
  const [activeFile, setActiveFile] = useState(variant.entry);
  const [restart, setRestart] = useState(0);
  const [checked, setChecked] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<SelfAssessment>();
  const [revealed, setRevealed] = useState<Reveal | null>(null);
  const freeSession = useRef<string | null>(null);
  const freeStartRequest = useRef<string>(crypto.randomUUID());
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [editError, setEditError] = useState("");
  const [hints, setHints] = useState(false);
  const fontSize = usePreferences((state) => state.editorFontSize);
  const draft = useDraftStatus();
  const history = useQuery(selfAssessmentsQuery(user.id));
  const existing = unfinished.find(
    (s) =>
      s.exerciseId === exercise.id &&
      s.framework === variant.framework &&
      s.language === variant.language &&
      s.kind !== "practice",
  );
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: reviewsQuery(user.id).queryKey }),
      queryClient.invalidateQueries({ queryKey: selfAssessmentsQuery(user.id).queryKey }),
      invalidateProgress(queryClient, user.id),
    ]);
  };
  const start = useMutation({
    mutationFn: async (kind: "learning" | "practice") => {
      const base = {
        exerciseId: exercise.id,
        exerciseVersion: exercise.version,
        framework: variant.framework,
        language: variant.language,
      };
      try {
        return await api.startSession({ ...base, kind });
      } catch (error) {
        if (kind === "learning" && errorCode(error) === "ALREADY_ENROLLED")
          return api.startSession({ ...base, kind: "review" });
        throw error;
      }
    },
    onSuccess: async (next) => {
      // Review starts from starter; resumed sessions retain their own buffer.
      const target = domDraftKey(user.id, exercise, variant, next.id);
      if (next.kind !== "review" && readDraft(target) === undefined)
        save(target, JSON.stringify(files));
      await invalidate();
      onOpen(next);
    },
  });
  const assistance = useMutation({
    mutationFn: async (kind: "hint" | "solution_reveal" | "external_help") => {
      if (!session) throw new Error("Start a session first to record assistance.");
      if (kind === "solution_reveal") return api.reveal(session.id);
      const updated = await api.assistance(session.id, kind);
      return { session: updated };
    },
    onSuccess: async (result) => {
      if ("solution" in result) setRevealed(result);
      else setHints(true);
      await invalidate();
    },
  });
  const complete = useMutation({
    mutationFn: async ({
      rating,
      assessment,
    }: {
      rating: Rating | undefined;
      assessment: SelfAssessment | undefined;
    }) => {
      // Free practice also persists through a session, without advancing a review card.
      let id = session?.id ?? freeSession.current;
      if (!id) {
        const active = await api.startSession({
          exerciseId: exercise.id,
          exerciseVersion: exercise.version,
          framework: variant.framework,
          language: variant.language,
          kind: "practice",
          requestId: freeStartRequest.current,
        });
        id = active.id;
        freeSession.current = id;
      }
      return api.completeSession(
        id,
        session?.kind === "practice" && session.solutionRevealed ? "again" : rating,
        assessment,
      );
    },
    retry: (count, error) => count < 2 && !(error instanceof ApiError),
    onSuccess: async (result) => {
      setCompletion(result);
      if (session) onCompleted(result);
      toast(
        result.card
          ? `Marked complete. Next review ${formatDateTime(result.card.due)}.`
          : "Marked complete.",
        "ok",
      );
      await invalidate();
    },
  });
  const allChecked = checked.length === exercise.checklist.length;
  const solvedBefore = history.data?.find(
    (s) =>
      s.exerciseId === exercise.id &&
      s.framework === variant.framework &&
      s.language === variant.language &&
      s.assessment?.outcome === "solved",
  );
  const update = (source: string) => {
    const next = { ...files, [activeFile]: source };
    if (new TextEncoder().encode(Object.values(next).join("")).byteLength > MAX_SOURCE_BYTES) {
      setEditError("Project exceeds the 64 KiB source limit. Shorten this edit before saving.");
      return;
    }
    setEditError("");
    save(key, JSON.stringify(next));
    // A changed solution needs a fresh explicit assessment.
    setChecked([]);
    setOutcome(undefined);
  };
  return (
    <section className="workspace" aria-label="DOM workspace">
      <div className="toolbar">
        <label>
          Framework{" "}
          <select
            aria-label="Framework"
            value={variant.id}
            disabled={Boolean(session)}
            onChange={(event) => onVariant(event.target.value)}
          >
            {exercise.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.framework} · {v.language}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Replace all files with starter code?")) {
              save(key, JSON.stringify(variant.files));
              setChecked([]);
              setOutcome(undefined);
              setRestart((n) => n + 1);
            }
          }}
        >
          Reset files
        </button>
        <span className="toolbar-spacer" />
        {draft.status}
      </div>
      <p className="muted">
        Drafts save in this browser. Vue/Svelte editing provides syntax highlighting only; compiler
        diagnostics appear below. Larger screens work best.
      </p>
      <div className="file-tabs" role="tablist" aria-label="Project files">
        {Object.keys(variant.files).map((path) => (
          <button
            type="button"
            role="tab"
            aria-selected={path === activeFile}
            aria-controls="dom-file-editor"
            key={path}
            onClick={() => setActiveFile(path)}
          >
            {path}
          </button>
        ))}
      </div>
      <div id="dom-file-editor" className="editor-frame" role="tabpanel" aria-label={activeFile}>
        <Suspense fallback={<PageLoading />}>
          <Editor
            path={`file:///${encodeURIComponent(key)}/${activeFile}`}
            language={
              activeFile.endsWith(".css")
                ? "css"
                : activeFile.endsWith(".html")
                  ? "html"
                  : activeFile.endsWith(".vue") || activeFile.endsWith(".svelte")
                    ? "html"
                    : variant.language
            }
            preview
            value={files[activeFile] ?? ""}
            fontSize={fontSize}
            onChange={update}
            onRun={() => setRestart((n) => n + 1)}
            onSubmit={() => setRestart((n) => n + 1)}
            onSave={draft.confirm}
          />
        </Suspense>
      </div>
      {editError && <p role="alert">{editError}</p>}
      <Suspense fallback={<PageLoading />}>
        <Preview variant={variant} files={files} restart={restart} />
      </Suspense>
      <section className="session-panel" aria-label="Self-assessment">
        {completion ? (
          <div role="status">
            <h2>
              Self-assessed{" "}
              {completion.session.assessment?.outcome === "solved"
                ? "complete"
                : "attempt recorded"}
            </h2>
            <p>
              {completion.card
                ? `Next review: ${formatDateTime(completion.card.due)}`
                : "Unscheduled practice recorded. Review dates were not changed."}
            </p>
            <button
              type="button"
              onClick={() => {
                setCompletion(null);
                freeSession.current = null;
                freeStartRequest.current = crypto.randomUUID();
                setOutcome(undefined);
                setChecked([]);
                if (session) onOpen(null);
              }}
            >
              Continue practicing
            </button>{" "}
            <Link to="/reviews">Reviews</Link>
          </div>
        ) : (
          <>
            <h2>{session ? `${session.kind} session · ${variant.framework}` : "Free practice"}</h2>
            {solvedBefore && (
              <p>
                Last self-assessed completion:{" "}
                {formatDateTime(solvedBefore.completedAt ?? solvedBefore.createdAt)}
              </p>
            )}
            {!session && (
              <div className="button-row">
                {existing ? (
                  <button type="button" onClick={() => onOpen(existing)}>
                    Resume unfinished session
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={start.isPending}
                    onClick={() => start.mutate("learning")}
                  >
                    Start scheduled session
                  </button>
                )}
                <button
                  type="button"
                  disabled={start.isPending}
                  onClick={() => start.mutate("practice")}
                >
                  Start unscheduled session
                </button>
              </div>
            )}
            <fieldset disabled={complete.isPending}>
              <legend>Verify the behavior yourself</legend>
              {exercise.checklist.map((item) => (
                <label className="checklist-item" key={item}>
                  <input
                    type="checkbox"
                    checked={checked.includes(item)}
                    onChange={(event) => {
                      setChecked((previous) =>
                        event.target.checked
                          ? [...previous, item]
                          : previous.filter((value) => value !== item),
                      );
                      setOutcome(undefined);
                    }}
                  />
                  {item}
                </label>
              ))}
              <label className="checklist-item">
                <input
                  type="radio"
                  name="assessment"
                  checked={outcome === "solved"}
                  disabled={!allChecked}
                  onChange={() => setOutcome("solved")}
                />
                I confirm that my solution satisfies every requirement.
              </label>
              {session?.kind === "review" && (
                <label className="checklist-item">
                  <input
                    type="radio"
                    name="assessment"
                    checked={outcome === "unable"}
                    onChange={() => setOutcome("unable")}
                  />
                  I attempted it but was unable to complete it.
                </label>
              )}
            </fieldset>
            {session && session.kind !== "practice" && (
              <p>Choose a recall rating to mark this session complete.</p>
            )}
            {session && session.kind !== "practice" ? (
              <div className="rating-row">
                {(["again", "hard", "good", "easy"] as const).map((rating) => {
                  const reason = domRatingBlocker(session, outcome, rating);
                  return (
                    <button
                      type="button"
                      key={rating}
                      disabled={Boolean(reason) || complete.isPending}
                      title={reason ?? RATING_LABEL[rating].description}
                      onClick={() => complete.mutate({ rating, assessment: outcome })}
                    >
                      {RATING_LABEL[rating].label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={outcome !== "solved" || complete.isPending}
                onClick={() => complete.mutate({ rating: undefined, assessment: outcome })}
              >
                Mark complete
              </button>
            )}
            {session?.solutionRevealed && (
              <p className="notice">
                Solution reveal or outside help limits this session to Again.
              </p>
            )}
            {session && (
              <div className="button-row">
                <button
                  type="button"
                  disabled={assistance.isPending}
                  onClick={() => assistance.mutate("hint")}
                >
                  Show hints
                </button>
                <button
                  type="button"
                  disabled={assistance.isPending}
                  onClick={() => {
                    if (window.confirm("Reveal the solution? This session will require Again."))
                      assistance.mutate("solution_reveal");
                  }}
                >
                  Reveal solution
                </button>
                <button
                  type="button"
                  disabled={assistance.isPending}
                  onClick={() => assistance.mutate("external_help")}
                >
                  I used outside help
                </button>
              </div>
            )}
            {session?.hintUsed && <p className="muted">Hint use recorded.</p>}
            {hints && (
              <ul>
                {exercise.hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            )}
            {revealed && (
              <details open>
                <summary>Revealed solution</summary>
                <p>{revealed.explanation}</p>
                {Object.entries(revealed.files ?? {}).map(([path, source]) => (
                  <div key={path}>
                    <h3>{path}</h3>
                    <pre className="code">{source}</pre>
                  </div>
                ))}
              </details>
            )}
          </>
        )}
        {start.isError && <ErrorNotice error={start.error} />}
        {assistance.isError && <ErrorNotice error={assistance.error} />}
        {complete.isError && <ErrorNotice error={complete.error} />}
      </section>
    </section>
  );
}
