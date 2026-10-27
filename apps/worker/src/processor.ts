import { randomUUID } from "node:crypto";
import type { JsonValue, Language, TestCase } from "@bekor/contracts";
import { contentHash, getExercise } from "@bekor/exercises";
import {
  type JudgedCase,
  judgeCase,
  type RunnerAdapter,
  RunnerInfrastructureError,
  type RunnerRequest,
} from "@bekor/runner";

export interface WorkSubmission {
  id: string;
  userId: string;
  exerciseId: string;
  exerciseVersion: string;
  language: Language;
  contentHash: string;
  mode: "run" | "submit";
  files: Record<string, string>;
  totalCount: number;
}
export interface SavedCase extends JudgedCase {
  caseIndex: number;
  isPublic: boolean;
}
export interface Attempt {
  id: string;
  caseIndex: number;
  attemptNumber: number;
  status: string;
  providerToken: string | null;
  createdAt: Date;
}
export interface ClaimedWork {
  submission: WorkSubmission;
  results: SavedCase[];
  attempts: Attempt[];
}
export interface WorkerRepository {
  claim(id: string, owner: string): Promise<ClaimedWork | null>;
  intent(id: string, owner: string, caseIndex: number): Promise<Attempt>;
  dispatched(id: string, owner: string, attemptId: string, token: string): Promise<void>;
  saveCase(id: string, owner: string, attemptId: string, result: SavedCase): Promise<void>;
  finish(id: string, owner: string): Promise<void>;
  fail(id: string, owner: string, retryable: boolean): Promise<void>;
}
export class LeaseLostError extends Error {}
export interface ProcessorOptions {
  repository: WorkerRepository;
  runner: RunnerAdapter;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
// Tests inject a fake adapter; this process never evaluates, imports or compiles learner source.
export function createProcessor(options: ProcessorOptions) {
  const now = options.clock ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (submissionId: string): Promise<void> => {
    const owner = randomUUID();
    const work = await options.repository.claim(submissionId, owner);
    if (!work) return;
    const { submission } = work;
    try {
      const exercise = getExercise(submission.exerciseId, submission.exerciseVersion);
      if (!exercise || contentHash(exercise) !== submission.contentHash)
        throw new RunnerInfrastructureError(
          "Published exercise content is unavailable or changed.",
          false,
        );
      const variant = exercise.public.variants[submission.language];
      const cases: TestCase[] = [
        ...variant.publicTests,
        ...(submission.mode === "submit" ? exercise.privateTests : []),
      ];
      if (cases.length !== submission.totalCount || cases.length > 32)
        throw new RunnerInfrastructureError("Exercise case budget mismatch.", false);
      const source = submission.files[variant.filename];
      if (source === undefined)
        throw new RunnerInfrastructureError("Stored source is unavailable.", false);
      const firstIntent = work.attempts.reduce(
        (time, attempt) => Math.min(time, attempt.createdAt.getTime()),
        now(),
      );
      const totalDeadline = firstIntent + 600_000;
      const deadline = Math.min(now() + 120_000, totalDeadline);
      for (const [caseIndex, test] of cases.entries()) {
        if (work.results.some((result) => result.caseIndex === caseIndex)) continue;
        if (now() >= deadline)
          throw new RunnerInfrastructureError(
            "Submission execution budget exhausted.",
            now() < totalDeadline,
          );
        let attempt = work.attempts
          .filter((item) => item.caseIndex === caseIndex)
          .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
        const base = {
          language: submission.language,
          source,
          entrypoint: variant.entrypoint,
          args: test.args as JsonValue[],
          limits: variant.limits,
        };
        if (!attempt?.providerToken) {
          attempt = await options.repository.intent(submission.id, owner, caseIndex);
          // The attempt ID is random, persisted and never exposed, so it doubles as the nonce.
          const { token } = await options.runner.dispatch({ ...base, nonce: attempt.id });
          await options.repository.dispatched(submission.id, owner, attempt.id, token);
          attempt.providerToken = token;
        }
        const request: RunnerRequest = { ...base, nonce: attempt.id };
        let delay = 100;
        while (true) {
          if (now() >= deadline)
            throw new RunnerInfrastructureError(
              "Submission execution budget exhausted.",
              now() < totalDeadline,
            );
          const result = await options.runner.poll(attempt.providerToken, request);
          if (result.status === "completed") {
            const isPublic = caseIndex < variant.publicTests.length;
            await options.repository.saveCase(submission.id, owner, attempt.id, {
              caseIndex,
              isPublic,
              ...judgeCase(result, test.expected, isPublic),
            });
            break;
          }
          await sleep(Math.min(delay, Math.max(0, deadline - now())));
          delay = Math.min(delay * 2, 2000);
        }
      }
      await options.repository.finish(submission.id, owner);
    } catch (error) {
      if (error instanceof LeaseLostError) return;
      await options.repository.fail(
        submission.id,
        owner,
        error instanceof RunnerInfrastructureError ? error.retryable : true,
      );
      // Let pg-boss retry; the database is the source of truth if queue retries are exhausted.
      throw new RunnerInfrastructureError(
        "Submission processing interrupted.",
        error instanceof RunnerInfrastructureError ? error.retryable : true,
      );
    }
  };
}
