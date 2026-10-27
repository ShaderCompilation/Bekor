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
  JUDGE0_URL: z
    .string(`${required("JUDGE0_URL")} (a private, isolated Judge0 service; see infra/compose)`)
    .refine((value) => {
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
  WORKER_HEALTH_PORT: z.coerce
    .number(portMessage)
    .int(portMessage)
    .min(1, portMessage)
    .max(65535, portMessage)
    .optional(),
  WORKER_HEALTH_HOST: z.string().default("127.0.0.1"),
});

export interface WorkerEnv {
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  judge0Url: string;
  judge0AuthToken?: string;
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
  if (!result.success)
    throw new EnvironmentError("worker", [
      ...new Set(
        result.error.issues.map((issue) => {
          const name = issue.path.join(".") || "environment";
          return issue.message.startsWith(name) ? issue.message : `${name}: ${issue.message}`;
        }),
      ),
    ]);
  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    judge0Url: env.JUDGE0_URL,
    healthHost: env.WORKER_HEALTH_HOST,
    ...(env.JUDGE0_AUTH_TOKEN ? { judge0AuthToken: env.JUDGE0_AUTH_TOKEN } : {}),
    ...(env.WORKER_HEALTH_PORT ? { healthPort: env.WORKER_HEALTH_PORT } : {}),
  };
}
