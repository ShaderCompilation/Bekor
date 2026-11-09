import { type ReactNode, useState } from "react";
import { errorMessage } from "../api";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="spinner" role="status">
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

export function PageLoading() {
  return (
    <div className="page-state">
      <Spinner /> Loading…
    </div>
  );
}

export function ErrorNotice({ error, action }: { error: unknown; action?: ReactNode }) {
  return (
    <div className="notice notice-error" role="alert">
      <p>{errorMessage(error)}</p>
      {action}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Placeholder blocks shown while content loads; hidden from assistive technology. */
export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton-group ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={index} className="skeleton" />
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" className="list-skeleton">
      <span className="visually-hidden">Loading…</span>
      <Skeleton lines={rows} />
    </div>
  );
}

/**
 * Drafts save on every edit. Ctrl/Cmd+S calls `confirm`, which briefly highlights the status so
 * the save habit gets a visible answer.
 */
export function useDraftStatus() {
  const [saves, setSaves] = useState(0);
  const status = (
    // A new key restarts the highlight animation on each save.
    <span key={saves} className={`draft-status${saves ? " draft-status-flash" : ""}`} role="status">
      <span aria-hidden="true">✓ </span>
      {saves ? "Draft saved" : "Saved in this browser"}
    </span>
  );
  return { status, confirm: () => setSaves((count) => count + 1) };
}
