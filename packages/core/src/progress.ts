import type { Difficulty, Progress } from "@bekor/contracts";
import type { Database } from "@bekor/db";
import type { CatalogService } from "./catalog.js";

const ACTIVITY_DAYS = 365;

interface StatusRow {
  exercise_id: string;
  solved: boolean;
  last_activity_at: Date;
}
interface ActivityRow {
  day: string;
  attempts: number;
  solved: number;
}

export function createProgressService(
  database: Database,
  catalog: CatalogService,
  settings: { get(userId: string): Promise<{ timezone: string }> },
  clock = () => new Date(),
) {
  // Judged solves come from problem_progress; DOM solves from explicit self-assessments.
  const statusRows = (userId: string) =>
    database.pool.query<StatusRow>(
      `select exercise_id, bool_or(solved) as solved, max(at) as last_activity_at
             from (
               select exercise_id, true as solved, last_accepted_at as at
                 from problem_progress where user_id = $1
               union all
               select exercise_id, false, created_at from submissions where user_id = $1
               union all
               select exercise_id, coalesce(assessment->>'outcome' = 'solved', false),
                      coalesce(completed_at, created_at)
                 from practice_sessions where user_id = $1 and framework <> 'node'
             ) events
            group by exercise_id`,
      [userId],
    );
  return {
    /** Exercise id → status, for filtering the catalog. Unlisted exercises are not started. */
    async statuses(userId: string): Promise<Map<string, "solved" | "attempted">> {
      const { rows } = await statusRows(userId);
      return new Map(rows.map((row) => [row.exercise_id, row.solved ? "solved" : "attempted"]));
    },
    async get(userId: string): Promise<Progress> {
      const { timezone } = await settings.get(userId);
      const [statuses, activity, summaries] = await Promise.all([
        statusRows(userId),
        database.pool.query<ActivityRow>(
          `select to_char(day, 'YYYY-MM-DD') as day,
                  count(*)::int as attempts,
                  count(*) filter (where solved)::int as solved
             from (
               select (created_at at time zone $2)::date as day,
                      (mode = 'submit' and verdict = 'accepted') as solved
                 from submissions where user_id = $1 and created_at >= $3
               union all
               select (completed_at at time zone $2)::date,
                      coalesce(assessment->>'outcome' = 'solved', false)
                 from practice_sessions
                where user_id = $1 and framework <> 'node' and completed_at >= $3
             ) events
            group by day
            order by day`,
          [userId, timezone, new Date(clock().getTime() - (ACTIVITY_DAYS + 1) * 86_400_000)],
        ),
        catalog.summaries(),
      ]);
      const difficulty = new Map(summaries.map((summary) => [summary.id, summary.difficulty]));
      const counts = () => ({ easy: 0, medium: 0, hard: 0 }) satisfies Record<Difficulty, number>;
      const totals = { catalog: counts(), solved: counts() };
      for (const summary of summaries) totals.catalog[summary.difficulty] += 1;
      const items: Progress["items"] = [];
      for (const row of statuses.rows) {
        const level = difficulty.get(row.exercise_id);
        // Retired or unpublished problems are not part of the catalog progress.
        if (!level) continue;
        if (row.solved) totals.solved[level] += 1;
        items.push({
          exerciseId: row.exercise_id,
          status: row.solved ? "solved" : "attempted",
          lastActivityAt: new Date(row.last_activity_at).toISOString(),
        });
      }
      items.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      return {
        timezone,
        items,
        activity: activity.rows
          .slice(-ACTIVITY_DAYS)
          .map((row) => ({ date: row.day, attempts: row.attempts, solved: row.solved })),
        totals,
      };
    },
  };
}
export type ProgressService = ReturnType<typeof createProgressService>;
