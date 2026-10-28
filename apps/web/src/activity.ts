import type { Progress } from "@bekor/contracts";

type ActivityDay = Progress["activity"][number];
const DAY_MS = 86_400_000;

/** The calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday. */
function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * Current streak: consecutive active days ending today, or yesterday when today has no activity
 * yet (the streak is still alive until the day ends). Longest: the best run in the data.
 */
export function streaks(activity: readonly ActivityDay[], today: string) {
  const active = new Set(activity.filter((day) => day.attempts > 0).map((day) => day.date));
  let current = 0;
  let cursor = active.has(today) ? today : addDays(today, -1);
  while (active.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const date of [...active].sort()) {
    run = previous && addDays(previous, 1) === date ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  return { current, longest, activeDays: active.size };
}

export interface HeatCell {
  date: string;
  attempts: number;
  solved: number;
  /** 0 (none) … 4 (most). */
  level: number;
  future: boolean;
}

/**
 * Columns of 7 days (Sunday first) covering `weeks` weeks and ending with the week of `today`.
 * Levels scale to the busiest day so light and heavy users both get a readable map.
 */
export function heatmap(activity: readonly ActivityDay[], today: string, weeks = 53): HeatCell[][] {
  const byDate = new Map(activity.map((day) => [day.date, day]));
  const max = Math.max(1, ...activity.map((day) => day.attempts));
  const start = addDays(today, -weekday(today) - (weeks - 1) * 7);
  const columns: HeatCell[][] = [];
  for (let week = 0; week < weeks; week += 1) {
    const column: HeatCell[] = [];
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(start, week * 7 + day);
      const entry = byDate.get(date);
      const attempts = entry?.attempts ?? 0;
      column.push({
        date,
        attempts,
        solved: entry?.solved ?? 0,
        level: attempts === 0 ? 0 : Math.min(4, Math.ceil((attempts / max) * 4)),
        future: date > today,
      });
    }
    columns.push(column);
  }
  return columns;
}
