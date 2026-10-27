import { createHash, randomUUID } from "node:crypto";
import {
  MAX_CASES,
  type Pagination,
  type Submission,
  type SubmissionCreate,
  submissionCreateSchema,
  submissionSchema,
} from "@bekor/contracts";
import { type Database, practiceSessions, schema, submissions, user } from "@bekor/db";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgBoss } from "pg-boss";
import type { CatalogService } from "./catalog.js";
import { ServiceError } from "./errors.js";
import { JUDGE_QUEUE } from "./queue.js";

function publicSubmission(row: typeof submissions.$inferSelect): Submission {
  return submissionSchema.parse({
    id: row.id,
    exerciseId: row.exerciseId,
    exerciseVersion: row.exerciseVersion,
    language: row.language,
    mode: row.mode,
    practiceSessionId: row.practiceSessionId,
    status: row.status,
    verdict: row.verdict,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    passedCount: row.passedCount,
    totalCount: row.totalCount,
    diagnostic: row.diagnostic,
    publicResults: row.publicResults ?? [],
    files: row.files,
  });
}
export function createSubmissionService(
  database: Database,
  boss: Pick<PgBoss, "send">,
  catalog: CatalogService,
  clock = () => new Date(),
) {
  return {
    async create(userId: string, raw: SubmissionCreate) {
      const parsed = submissionCreateSchema.safeParse(raw);
      if (!parsed.success)
        throw new ServiceError("INVALID_INPUT", "Invalid submission files or fields.");
      const input = parsed.data;
      const payloadHash = createHash("sha256")
        .update(
          JSON.stringify([
            input.exerciseId,
            input.exerciseVersion,
            input.language,
            input.mode,
            input.practiceSessionId ?? null,
            Object.entries(input.files),
          ]),
        )
        .digest("hex");
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        const tx = drizzle(client, { schema });
        // Serialize per-user admission and retries so concurrent requests cannot exceed quotas.
        const [owner] = await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, userId))
          .for("update");
        if (!owner) throw new ServiceError("UNAUTHENTICATED", "Sign in required.", 401);
        const [existing] = await tx
          .select()
          .from(submissions)
          .where(
            and(
              eq(submissions.userId, userId),
              eq(submissions.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) {
          if (existing.payloadHash !== payloadHash)
            throw new ServiceError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key already used with different content.",
              409,
            );
          await client.query("COMMIT");
          return publicSubmission(existing);
        }
        const exercise = await catalog.resolve(input.exerciseId, input.exerciseVersion);
        const totalCount =
          exercise.public.variants[input.language].publicTests.length +
          (input.mode === "submit" ? exercise.privateTests.length : 0);
        if (totalCount < 1 || totalCount > MAX_CASES)
          throw new ServiceError("CONTENT_UNAVAILABLE", "Exercise exceeds execution budget.", 503);
        if (input.practiceSessionId) {
          const [session] = await tx
            .select()
            .from(practiceSessions)
            .where(
              and(
                eq(practiceSessions.id, input.practiceSessionId),
                eq(practiceSessions.userId, userId),
              ),
            )
            .for("update");
          if (!session) throw new ServiceError("NOT_FOUND", "Practice session not found.", 404);
          if (
            session.status !== "active" ||
            session.exerciseId !== input.exerciseId ||
            session.exerciseVersion !== input.exerciseVersion ||
            session.language !== input.language
          )
            throw new ServiceError(
              "SESSION_MISMATCH",
              "Submission must match an active practice session.",
              409,
            );
        }
        const now = clock();
        const [counts] = await tx
          .select({
            active: sql<number>`count(*) filter (where ${submissions.status} in ('queued','running'))::int`,
            recent: sql<number>`count(*) filter (where ${submissions.createdAt} > ${new Date(now.getTime() - 60000)})::int`,
          })
          .from(submissions)
          .where(eq(submissions.userId, userId));
        if ((counts?.active ?? 0) >= 3 || (counts?.recent ?? 0) >= 20)
          throw new ServiceError(
            "RATE_LIMITED",
            "Submission limit reached. Wait before retrying.",
            429,
          );
        const [row] = await tx
          .insert(submissions)
          .values({
            id: randomUUID(),
            userId,
            ...input,
            practiceSessionId: input.practiceSessionId ?? null,
            payloadHash,
            totalCount,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error("Submission insert failed");
        const job = await boss.send(
          JUDGE_QUEUE,
          { submissionId: row.id },
          { db: { executeSql: (text, values) => client.query(text, values) } },
        );
        if (!job) throw new Error("Queue insert failed");
        await client.query("COMMIT");
        return publicSubmission(row);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async get(userId: string, id: string) {
      const [row] = await database.db
        .select()
        .from(submissions)
        .where(and(eq(submissions.id, id), eq(submissions.userId, userId)));
      if (!row) throw new ServiceError("NOT_FOUND", "Submission not found.", 404);
      return publicSubmission(row);
    },
    async history(userId: string, page: Pagination) {
      let cursor: { createdAt: Date; id: string } | undefined;
      if (page.cursor)
        try {
          const data = JSON.parse(Buffer.from(page.cursor, "base64url").toString()) as {
            createdAt: string;
            id: string;
          };
          if (
            !/^\d{4}-/.test(data.createdAt) ||
            !/^[0-9a-f-]{36}$/.test(data.id) ||
            Number.isNaN(Date.parse(data.createdAt))
          )
            throw new Error();
          cursor = { createdAt: new Date(data.createdAt), id: data.id };
        } catch {
          throw new ServiceError("INVALID_CURSOR", "Invalid history cursor.");
        }
      const rows = await database.db
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.userId, userId),
            cursor
              ? or(
                  lt(submissions.createdAt, cursor.createdAt),
                  and(eq(submissions.createdAt, cursor.createdAt), lt(submissions.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(submissions.createdAt), desc(submissions.id))
        .limit(page.limit + 1);
      const more = rows.length > page.limit;
      if (more) rows.pop();
      const last = rows.at(-1);
      return {
        items: rows.map(publicSubmission),
        nextCursor:
          more && last
            ? Buffer.from(
                JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id }),
              ).toString("base64url")
            : null,
      };
    },
  };
}
export type SubmissionService = ReturnType<typeof createSubmissionService>;
