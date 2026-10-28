import type { ProblemSummary } from "@bekor/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, type ReactNode, useId, useRef } from "react";
import { api, type SessionUser } from "../api";
import { formatDateTime } from "../format";
import { progressQuery, randomProblem, reviewsQuery } from "../queries";
import { usePreferences } from "../stores/preferences";
import { toast } from "../stores/toasts";
import { Splitter } from "./Splitter";

/** The next problem in catalog (slug) order, wrapping to the first. */
async function nextProblem(slug: string): Promise<ProblemSummary | null> {
  const after = await api.problems({ cursor: slug, limit: 1 });
  return after.items[0] ?? (await api.problems({ limit: 1 })).items[0] ?? null;
}

/**
 * Problem page frame: a header bar (breadcrumb, progress, navigation) above a statement pane and
 * a work pane. On wide screens the panes fill the viewport and a splitter resizes them.
 */
export function ProblemShell({
  exercise,
  user,
  statement,
  children,
  className = "",
}: {
  exercise: { id: string; slug: string; title: string };
  user: SessionUser | null;
  statement: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const statementId = useId();
  const width = usePreferences((state) => state.statementWidth);
  const setSizes = usePreferences((state) => state.setPaneSizes);
  const navigate = useNavigate();
  const open = (problem: ProblemSummary | null) => {
    if (problem) void navigate({ to: "/problems/$slug", params: { slug: problem.slug } });
    else toast("No other problem to open.", "warn");
  };
  const next = useMutation({ mutationFn: () => nextProblem(exercise.slug), onSuccess: open });
  const random = useMutation({
    mutationFn: async () => {
      // Signed-in learners get a problem they have not started, when one exists.
      const fresh = user ? await randomProblem({ status: "todo" }) : null;
      return fresh ?? (await randomProblem({}));
    },
    onSuccess: open,
  });

  return (
    <div className={`problem-shell ${className}`}>
      <div className="problem-bar">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <Link to="/problems">Problems</Link>
          <span aria-hidden="true"> / </span>
          <span aria-current="page">{exercise.title}</span>
        </nav>
        {user && <ProgressPill userId={user.id} exerciseId={exercise.id} />}
        <span className="toolbar-spacer" />
        <button type="button" onClick={() => random.mutate()} disabled={random.isPending}>
          <span aria-hidden="true">⤨ </span>Random
        </button>
        <button type="button" onClick={() => next.mutate()} disabled={next.isPending}>
          Next<span aria-hidden="true"> →</span>
        </button>
      </div>
      <div
        ref={container}
        className="problem-panes"
        style={{ "--statement-width": `${width}%` } as CSSProperties}
      >
        <div className="pane statement-pane" id={statementId}>
          {statement}
        </div>
        <Splitter
          orientation="vertical"
          value={width}
          min={20}
          max={70}
          onChange={(statementWidth) => setSizes({ statementWidth })}
          container={container}
          label="Resize problem description"
          controls={statementId}
        />
        <div className="pane work-pane">{children}</div>
      </div>
    </div>
  );
}

function ProgressPill({ userId, exerciseId }: { userId: string; exerciseId: string }) {
  const progress = useQuery(progressQuery(userId)).data;
  const reviews = useQuery(reviewsQuery(userId)).data;
  const status = progress?.items.find((item) => item.exerciseId === exerciseId)?.status;
  const due = reviews?.due.find((card) => card.exerciseId === exerciseId);
  return (
    <span className="progress-pills">
      {status && (
        <span className={`pill pill-${status}`}>
          {status === "solved" ? "✓ Solved" : "◐ Attempted"}
        </span>
      )}
      {due && (
        <span className="pill pill-due" title={formatDateTime(due.due, reviews?.timezone)}>
          Review due
        </span>
      )}
    </span>
  );
}
