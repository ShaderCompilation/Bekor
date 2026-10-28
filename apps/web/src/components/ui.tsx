import type { ReactNode } from "react";
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
