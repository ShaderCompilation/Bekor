import { z } from "zod";

/** Thrown when the process environment is invalid. The message names variables, never values. */
export class EnvironmentError extends Error {
  constructor(
    readonly component: string,
    readonly problems: string[],
  ) {
    super(
      `Invalid ${component} environment (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems.map((problem) => `  - ${problem}`).join("\n")}\nSee .env.example and README.md.`,
    );
    this.name = "EnvironmentError";
  }
}

const required = (name: string) => `${name} is required`;
const portMessage = "WORKER_HEALTH_PORT must be an integer between 1 and 65535";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"], "NODE_ENV must be development, test or production")
    .default("development"),
  DATABASE_URL: z.string(required("DATABASE_URL")).refine((value) => {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "DATABASE_URL must be a postgres:// or postgresql:// URL"),
  RUNNER: z.enum(["judge0", "podman"], "RUNNER must be judge0 or podman").default("judge0"),
  JUDGE0_URL: z
    .string()
    .optional()
    .refine((value) => {
      if (value === undefined) return true;
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "JUDGE0_URL must be an http(s) URL without credentials, query or fragment"),
  JUDGE0_AUTH_TOKEN: z.string().optional(),
  PODMAN_RUNNER_IMAGE: z.string().optional(),
  WORKER_HEALTH_PORT: z.coerce
    .number(portMessage)
    .int(portMessage)
    .min(1, portMessage)
    .max(65535, portMessage)
    .optional(),
  WORKER_HEALTH_HOST: z.string().default("127.0.0.1"),
});

export type RunnerEnv =
  | { kind: "judge0"; url: string; authToken?: string }
  /** Development-only local Podman runner (plan F05). Never allowed in production. */
  | { kind: "podman"; image?: string };

export interface WorkerEnv {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  runner: RunnerEnv;
  healthPort?: number;
  healthHost: string;
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const present = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
    ),
  );
  const result = schema.safeParse(present);
  const problems = result.success
    ? []
    : result.error.issues.map((issue) => {
        const name = issue.path.join(".") || "environment";
        return issue.message.startsWith(name) ? issue.message : `${name}: ${issue.message}`;
      });
  // Cross-field rules, checked even when other variables are invalid so one error lists everything.
  const runner = present.RUNNER ?? "judge0";
  if (runner === "judge0" && !present.JUDGE0_URL)
    problems.push(
      `${required("JUDGE0_URL")} when RUNNER=judge0 (a private, isolated Judge0 service; see infra/compose)`,
    );
  if (runner === "podman" && present.NODE_ENV === "production")
    problems.push("RUNNER=podman is development-only and not allowed when NODE_ENV=production");
  if (!result.success || problems.length)
    throw new EnvironmentError("worker", [...new Set(problems)]);
  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    runner:
      env.RUNNER === "podman"
        ? { kind: "podman", ...(env.PODMAN_RUNNER_IMAGE ? { image: env.PODMAN_RUNNER_IMAGE } : {}) }
        : {
            kind: "judge0",
            url: env.JUDGE0_URL as string,
            ...(env.JUDGE0_AUTH_TOKEN ? { authToken: env.JUDGE0_AUTH_TOKEN } : {}),
          },
    healthHost: env.WORKER_HEALTH_HOST,
    ...(env.WORKER_HEALTH_PORT ? { healthPort: env.WORKER_HEALTH_PORT } : {}),
  };
}
