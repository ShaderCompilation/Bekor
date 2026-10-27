import { randomUUID } from "node:crypto";
import {
  caseResults,
  createDatabase,
  executionAttempts,
  exerciseVersions,
  problemProgress,
  problems,
  submissions,
  user,
} from "@bekor/db";
import { contentHash, getExercise, listExercises } from "@bekor/exercises";
import { type RunnerAdapter, RunnerInfrastructureError, type RunnerRequest } from "@bekor/runner";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../../../packages/db/src/migrate.js";
import { createProcessor, LeaseLostError } from "../src/processor.js";
import { createWorkerRepository } from "../src/repository.js";

const adminUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!adminUrl)(
  "real PostgreSQL worker recovery with FAKE runner (no execution verification)",
  () => {
    const name = `bekor_worker_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool;
    let database: ReturnType<typeof createDatabase>;
    let time = Date.now();
    const clock = () => new Date(time);
    const exercise = getExercise("cumulative-sums", "1.0.0")!;
    let repository: ReturnType<typeof createWorkerRepository>;
    async function seed(
      mode: "run" | "submit" = "submit",
      language: "javascript" | "typescript" = "javascript",
    ) {
      const userId = randomUUID(),
        id = randomUUID();
      await database.db
        .insert(user)
        .values({ id: userId, name: "Worker Test", email: `${userId}@example.test` });
      await database.db.insert(submissions).values({
        id,
        userId,
        exerciseId: exercise.public.id,
        exerciseVersion: exercise.public.version,
        language,
        mode,
        files: {
          [exercise.public.variants[language].filename]: "FAKE source: deliberately never executed",
        },
        idempotencyKey: id,
        payloadHash: "fake-test",
        totalCount:
          exercise.public.variants[language].publicTests.length +
          (mode === "submit" ? exercise.privateTests.length : 0),
        createdAt: clock(),
        updatedAt: clock(),
      });
      return id;
    }
    function fakeRunner() {
      const requests = new Map<string, RunnerRequest>();
      const dispatch = vi.fn(async (request: RunnerRequest) => {
        const token = randomUUID();
        requests.set(token, request);
        return { token };
      });
      const poll = vi.fn(async (token: string) => {
        const request = requests.get(token)!;
        const test = [
          ...exercise.public.variants.javascript.publicTests,
          ...exercise.privateTests,
        ].find((item) => JSON.stringify(item.args) === JSON.stringify(request.args));
        return {
          status: "completed" as const,
          outcome: "executed" as const,
          actual: test!.expected,
          diagnostic: "PRIVATE MARKER FROM SANDBOX",
        };
      });
      return { dispatch, poll, requests };
    }
    const processor = (runner: RunnerAdapter) =>
      createProcessor({
        repository,
        runner,
        clock: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      });
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: adminUrl });
      await admin.query(`CREATE DATABASE "${name}"`);
      const url = new URL(adminUrl!);
      url.pathname = `/${name}`;
      database = createDatabase(url.toString());
      await migrateDatabase(database);
      for (const item of listExercises()) {
        await database.db.insert(problems).values({ id: item.public.id, slug: item.public.slug });
        await database.db.insert(exerciseVersions).values({
          exerciseId: item.public.id,
          version: item.public.version,
          contentHash: contentHash(item),
        });
      }
      repository = createWorkerRepository(database, clock);
    });
    afterAll(async () => {
      await database?.close();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });
    it.each(["javascript", "typescript"] as const)(
      "persists accepted %s fake-runner submissions once under concurrent delivery",
      async (language) => {
        const id = await seed("submit", language),
          runner = fakeRunner();
        await Promise.all([processor(runner)(id), processor(runner)(id)]);
        await processor(runner)(id);
        const [row] = await database.db.select().from(submissions).where(eq(submissions.id, id));
        expect(row).toMatchObject({ status: "completed", verdict: "accepted", workerAttempts: 1 });
        expect(runner.dispatch).toHaveBeenCalledTimes(row!.totalCount);
        expect(
          await database.db
            .select()
            .from(problemProgress)
            .where(eq(problemProgress.userId, row!.userId)),
        ).toHaveLength(1);
        const hidden = await database.db
          .select()
          .from(caseResults)
          .where(and(eq(caseResults.submissionId, id), eq(caseResults.isPublic, false)));
        expect(hidden.length).toBeGreaterThan(0);
        expect(hidden.every((result) => result.actual === null && result.diagnostic === null)).toBe(
          true,
        );
        const attempts = await database.db
          .select()
          .from(executionAttempts)
          .where(eq(executionAttempts.submissionId, id));
        expect(
          attempts
            .filter((a) => a.caseIndex >= exercise.public.variants.javascript.publicTests.length)
            .every((a) => !JSON.stringify(a.result).includes("PRIVATE MARKER")),
        ).toBe(true);
      },
    );
    it("Run never creates solved progress", async () => {
      const id = await seed("run");
      await processor(fakeRunner())(id);
      const [row] = await database.db.select().from(submissions).where(eq(submissions.id, id));
      expect(
        await database.db
          .select()
          .from(problemProgress)
          .where(eq(problemProgress.userId, row!.userId)),
      ).toHaveLength(0);
    });
    it("resumes a provider token after an expired crash lease without redispatching that case", async () => {
      const id = await seed(),
        runner = fakeRunner(),
        oldOwner = randomUUID();
      const work = await repository.claim(id, oldOwner);
      expect(work).not.toBeNull();
      const intent = await repository.intent(id, oldOwner, 0);
      const variant = exercise.public.variants.javascript;
      const { token } = await runner.dispatch({
        language: "javascript",
        source: "fake",
        entrypoint: variant.entrypoint,
        args: variant.publicTests[0]!.args,
        limits: variant.limits,
      });
      await repository.dispatched(id, oldOwner, intent.id, token);
      time += 150_001;
      expect(await repository.recoverable()).toContain(id);
      await processor(runner)(id);
      const [row] = await database.db.select().from(submissions).where(eq(submissions.id, id));
      expect(row).toMatchObject({ status: "completed", verdict: "accepted", workerAttempts: 2 });
      expect(runner.dispatch).toHaveBeenCalledTimes(row!.totalCount);
      expect(runner.poll.mock.calls[0]![0]).toBe(token);
      await expect(repository.finish(id, oldOwner)).rejects.toBeInstanceOf(LeaseLostError);
    });
    it("accounts for uncertain dispatch and fences an old worker after recovery", async () => {
      const id = await seed(),
        oldOwner = randomUUID();
      await repository.claim(id, oldOwner);
      const orphan = await repository.intent(id, oldOwner, 0);
      time += 150_001;
      await processor(fakeRunner())(id);
      const [oldAttempt] = await database.db
        .select()
        .from(executionAttempts)
        .where(eq(executionAttempts.id, orphan.id));
      expect(oldAttempt!.status).toBe("uncertain");
      await expect(
        repository.dispatched(id, oldOwner, orphan.id, "late-token"),
      ).rejects.toBeInstanceOf(LeaseLostError);
      const attempts = await database.db
        .select()
        .from(executionAttempts)
        .where(and(eq(executionAttempts.submissionId, id), eq(executionAttempts.caseIndex, 0)));
      expect(attempts.map((a) => a.attemptNumber).sort()).toEqual([1, 2]);
    });
    it("bounds provider outage retries and preserves terminal infrastructure failure", async () => {
      const id = await seed();
      const dispatch = vi.fn(async () => {
        throw new RunnerInfrastructureError("Simulated outage", true, true);
      });
      const runner: RunnerAdapter = { dispatch, poll: vi.fn() };
      for (let i = 0; i < 3; i++)
        await expect(processor(runner)(id)).rejects.toThrow("interrupted");
      await processor(runner)(id);
      expect(dispatch).toHaveBeenCalledTimes(3);
      const [row] = await database.db.select().from(submissions).where(eq(submissions.id, id));
      expect(row).toMatchObject({
        status: "infrastructure_error",
        verdict: null,
        workerAttempts: 3,
      });
    });
    it("rejects content drift before dispatch", async () => {
      const id = await seed(),
        runner = fakeRunner();
      await database.db
        .update(exerciseVersions)
        .set({ contentHash: "changed" })
        .where(eq(exerciseVersions.exerciseId, exercise.public.id));
      try {
        await expect(processor(runner)(id)).rejects.toThrow("interrupted");
        expect(runner.dispatch).not.toHaveBeenCalled();
      } finally {
        await database.db
          .update(exerciseVersions)
          .set({ contentHash: contentHash(exercise) })
          .where(eq(exerciseVersions.exerciseId, exercise.public.id));
      }
    });
  },
);
