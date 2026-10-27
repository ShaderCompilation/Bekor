import type { Language, Rating, Submission, Verdict } from "@bekor/contracts";

export const LANGUAGE_LABEL: Record<Language, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  accepted: "Accepted",
  wrong_answer: "Wrong answer",
  syntax_error: "Syntax error",
  compilation_error: "Compilation error",
  runtime_error: "Runtime error",
  time_limit_exceeded: "Time limit exceeded",
  memory_limit_exceeded: "Memory limit exceeded",
  output_limit_exceeded: "Output limit exceeded",
};

export const RATING_LABEL: Record<Rating, { label: string; description: string }> = {
  again: { label: "Again", description: "Couldn't recall it, or relied on the solution." },
  hard: { label: "Hard", description: "Solved it myself with substantial difficulty." },
  good: { label: "Good", description: "Solved it myself." },
  easy: { label: "Easy", description: "Solved it myself with little effort." },
};

export function submissionLabel(submission: Submission): string {
  if (submission.status === "queued") return "Queued";
  if (submission.status === "running") return "Running";
  if (submission.status === "infrastructure_error") return "Judging failed (server)";
  return submission.verdict ? VERDICT_LABEL[submission.verdict] : "Completed";
}

export function submissionTone(submission: Submission): "ok" | "bad" | "pending" | "warn" {
  if (submission.status === "queued" || submission.status === "running") return "pending";
  if (submission.status === "infrastructure_error") return "warn";
  return submission.verdict === "accepted" ? "ok" : "bad";
}

export function formatDateTime(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(seconds, "second");
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value);
}
