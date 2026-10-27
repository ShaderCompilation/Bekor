import { randomUUID } from "node:crypto";
import type { JsonValue, Verdict } from "@bekor/contracts";
import {
  caseResults,
  type Database,
  executionAttempts,
  exerciseVersions,
  problemProgress,
  submissions,
} from "@bekor/db";
import { RunnerInfrastructureError } from "@bekor/runner";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  type Attempt,
  LeaseLostError,
  type SavedCase,
  type WorkerRepository,
} from "./processor.js";

type Transaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];
export function createWorkerRepository(
  database: Database,
  clock = () => new Date(),
): WorkerRepository & { recoverable(): Promise<string[]> } {
  async function lock(tx: Transaction, id: string, owner: string) {
    const [row] = await tx.select().from(submissions).where(eq(submissions.id, id)).for("update");
    if (
      !row ||
      row.status !== "running" ||
      row.leaseOwner !== owner ||
      !row.leaseExpiresAt ||
      row.leaseExpiresAt <= clock()
    )
      throw new LeaseLostError("Worker lease expired.");
    return row;
  }
  return {
    async claim(id, owner) {
      return database.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(submissions)
          .where(eq(submissions.id, id))
          .for("update");
        const now = clock();
        if (
          !row ||
          !["queued", "running"].includes(row.status) ||
          (row.leaseExpiresAt && row.leaseExpiresAt > now)
        )
          return null;
        if (row.workerAttempts >= 3) {
          await tx
            .update(submissions)
            .set({
              status: "infrastructure_error",
              completedAt: now,
              updatedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              diagnostic: "Execution infrastructure unavailable.",
            })
            .where(eq(submissions.id, id));
          return null;
        }
        await tx
          .update(submissions)
          .set({
            status: "running",
            leaseOwner: owner,
            leaseExpiresAt: new Date(now.getTime() + 150_000),
            workerAttempts: row.workerAttempts + 1,
            updatedAt: now,
          })
          .where(eq(submissions.id, id));
        const results = await tx
          .select()
          .from(caseResults)
          .where(eq(caseResults.submissionId, id))
          .orderBy(asc(caseResults.caseIndex));
        const attempts = await tx
          .select()
          .from(executionAttempts)
          .where(eq(executionAttempts.submissionId, id));
        const [version] = await tx
          .select()
          .from(exerciseVersions)
          .where(
            and(
              eq(exerciseVersions.exerciseId, row.exerciseId),
              eq(exerciseVersions.version, row.exerciseVersion),
            ),
          );
        return {
          submission: { ...row, contentHash: version?.contentHash ?? "" },
          attempts,
          results: results.map((result) => ({
            caseIndex: result.caseIndex,
            isPublic: result.isPublic,
            passed: result.passed,
            verdict: result.verdict as Verdict,
            ...(result.isPublic && ["accepted", "wrong_answer"].includes(result.verdict)
              ? { actual: result.actual as JsonValue }
              : {}),
            ...(result.isPublic && result.diagnostic ? { diagnostic: result.diagnostic } : {}),
          })),
        };
      });
    },
    async intent(id, owner, caseIndex) {
      return database.db.transaction(async (tx) => {
        await lock(tx, id, owner);
        const attempts = await tx
          .select()
          .from(executionAttempts)
          .where(
            and(eq(executionAttempts.submissionId, id), eq(executionAttempts.caseIndex, caseIndex)),
          );
        const number = Math.max(0, ...attempts.map((a) => a.attemptNumber)) + 1;
        if (number > 3)
          throw new RunnerInfrastructureError("Execution dispatch budget exhausted.", false);
        await tx
          .update(executionAttempts)
          .set({ status: "uncertain", updatedAt: clock() })
          .where(
            and(
              eq(executionAttempts.submissionId, id),
              eq(executionAttempts.caseIndex, caseIndex),
              eq(executionAttempts.status, "intent"),
            ),
          );
        const [row] = await tx
          .insert(executionAttempts)
          .values({
            id: randomUUID(),
            submissionId: id,
            caseIndex,
            attemptNumber: number,
            status: "intent",
            createdAt: clock(),
            updatedAt: clock(),
          })
          .returning();
        if (!row) throw new Error("Execution intent insertion failed.");
        return row as Attempt;
      });
    },
    async dispatched(id, owner, attemptId, token) {
      await database.db.transaction(async (tx) => {
        await lock(tx, id, owner);
        const updated = await tx
          .update(executionAttempts)
          .set({ status: "dispatched", providerToken: token, updatedAt: clock() })
          .where(
            and(
              eq(executionAttempts.id, attemptId),
              eq(executionAttempts.submissionId, id),
              eq(executionAttempts.status, "intent"),
            ),
          )
          .returning();
        if (!updated.length) throw new LeaseLostError("Execution intent no longer current.");
      });
    },
    async saveCase(id, owner, attemptId, result) {
      await database.db.transaction(async (tx) => {
        await lock(tx, id, owner);
        const clean: SavedCase = {
          caseIndex: result.caseIndex,
          isPublic: result.isPublic,
          passed: result.passed,
          verdict: result.verdict,
          ...(result.isPublic && result.actual !== undefined ? { actual: result.actual } : {}),
          ...(result.isPublic && result.diagnostic ? { diagnostic: result.diagnostic } : {}),
        };
        const updated = await tx
          .update(executionAttempts)
          .set({ status: "completed", result: clean, updatedAt: clock() })
          .where(
            and(
              eq(executionAttempts.id, attemptId),
              eq(executionAttempts.submissionId, id),
              eq(executionAttempts.caseIndex, result.caseIndex),
              eq(executionAttempts.status, "dispatched"),
            ),
          )
          .returning();
        if (!updated.length) throw new LeaseLostError("Execution token no longer current.");
        await tx
          .insert(caseResults)
          .values({ id: randomUUID(), submissionId: id, ...clean })
          .onConflictDoNothing();
      });
    },
    async finish(id, owner) {
      await database.db.transaction(async (tx) => {
        const submission = await lock(tx, id, owner);
        const results = await tx
          .select()
          .from(caseResults)
          .where(eq(caseResults.submissionId, id))
          .orderBy(asc(caseResults.caseIndex));
        if (
          results.length !== submission.totalCount ||
          results.some((row, index) => row.caseIndex !== index)
        )
          throw new RunnerInfrastructureError("Submission results are incomplete.", false);
        const verdict = (results.find((result) => !result.passed)?.verdict ??
          "accepted") as Verdict;
        const now = clock();
        await tx
          .update(submissions)
          .set({
            status: "completed",
            verdict,
            passedCount: results.filter((result) => result.passed).length,
            completedAt: now,
            updatedAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            diagnostic: null,
            publicResults: results
              .filter((result) => result.isPublic)
              .map((result) => ({
                caseIndex: result.caseIndex,
                passed: result.passed,
                ...(["accepted", "wrong_answer"].includes(result.verdict)
                  ? { actual: result.actual }
                  : {}),
                ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
              })),
          })
          .where(eq(submissions.id, id));
        if (submission.mode === "submit" && verdict === "accepted")
          await tx
            .insert(problemProgress)
            .values({
              userId: submission.userId,
              exerciseId: submission.exerciseId,
              language: submission.language,
              firstAcceptedAt: now,
              lastAcceptedAt: now,
              lastSubmissionId: id,
            })
            .onConflictDoUpdate({
              target: [
                problemProgress.userId,
                problemProgress.exerciseId,
                problemProgress.language,
              ],
              set: { lastAcceptedAt: now, lastSubmissionId: id },
            });
      });
    },
    async fail(id, owner, retryable) {
      await database.db.transaction(async (tx) => {
        let row: typeof submissions.$inferSelect;
        try {
          row = await lock(tx, id, owner);
        } catch (error) {
          if (error instanceof LeaseLostError) return;
          throw error;
        }
        const terminal = !retryable || row.workerAttempts >= 3;
        await tx
          .update(submissions)
          .set({
            status: terminal ? "infrastructure_error" : "queued",
            completedAt: terminal ? clock() : null,
            updatedAt: clock(),
            leaseOwner: null,
            leaseExpiresAt: null,
            diagnostic: terminal ? "Execution infrastructure unavailable." : null,
          })
          .where(eq(submissions.id, id));
      });
    },
    async recoverable() {
      const now = clock();
      const rows = await database.db
        .select({ id: submissions.id })
        .from(submissions)
        .where(
          sql`(${submissions.status} = 'queued' and ${submissions.updatedAt} < ${new Date(now.getTime() - 60_000)}) or (${submissions.status} = 'running' and ${submissions.leaseExpiresAt} < ${now})`,
        )
        .orderBy(asc(submissions.createdAt))
        .limit(100);
      return rows.map((row) => row.id);
    },
  };
}
