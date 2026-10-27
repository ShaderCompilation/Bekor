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
