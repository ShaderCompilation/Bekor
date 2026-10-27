import type { ExecutionLimits, JsonValue, Language, Verdict } from "@bekor/contracts";

export interface RunnerRequest {
  language: Language;
  source: string;
  entrypoint: string;
  args: JsonValue[];
  limits: ExecutionLimits;
  /** Per-execution secret the harness must echo; never shown to learners. */
  nonce: string;
}
export type ExecutionOutcome = "executed" | Exclude<Verdict, "accepted" | "wrong_answer">;
export interface CompletedExecution {
  status: "completed";
  outcome: ExecutionOutcome;
  actual?: JsonValue;
  diagnostic?: string;
  timeMs?: number;
  memoryKb?: number;
}
export type RunnerResult = { status: "queued" | "running" } | CompletedExecution;
export interface RunnerAdapter {
  dispatch(request: RunnerRequest): Promise<{ token: string }>;
  poll(
    token: string,
    request: Pick<RunnerRequest, "language" | "limits" | "nonce">,
  ): Promise<RunnerResult>;
}
export class RunnerInfrastructureError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "RunnerInfrastructureError";
  }
}
export interface JudgedCase {
  passed: boolean;
  verdict: Verdict;
  actual?: JsonValue;
  diagnostic?: string;
}
