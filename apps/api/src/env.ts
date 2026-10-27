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
const postgresUrl = (name: string) =>
  z.string(required(name)).refine((value) => {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, `${name} must be a postgres:// or postgresql:// URL`);

const schema = z
  .object({
    NODE_ENV: z
      .enum(
        ["development", "test", "production"],
        "NODE_ENV must be development, test or production",
      )
      .default("development"),
    PORT: z.coerce
      .number("PORT must be an integer between 1 and 65535")
      .int("PORT must be an integer between 1 and 65535")
      .min(1, "PORT must be an integer between 1 and 65535")
      .max(65535, "PORT must be an integer between 1 and 65535")
      .default(3000),
    API_ORIGIN: z.string(required("API_ORIGIN")).refine((value) => {
      try {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "API_ORIGIN must be an http(s) origin without credentials, path, query or fragment"),
    DATABASE_URL: postgresUrl("DATABASE_URL"),
    BETTER_AUTH_SECRET: z
      .string(required("BETTER_AUTH_SECRET"))
      .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    REGISTRATION_ENABLED: z
      .enum(["true", "false"], "REGISTRATION_ENABLED must be true or false")
      .default("false"),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === "production" && !env.API_ORIGIN.startsWith("https://"))
      context.addIssue({
        code: "custom",
        path: ["API_ORIGIN"],
        message: "API_ORIGIN must use https:// when NODE_ENV=production",
      });
  });

export interface ApiEnv {
  nodeEnv: "development" | "test" | "production";
  port: number;
  apiOrigin: string;
  databaseUrl: string;
  betterAuthSecret: string;
  registrationEnabled: boolean;
}

/** Empty strings (common in copied .env files) are treated as unset. */
export function withoutEmpty(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "",
    ),
  );
}

/** Formats issues as "NAME: message" and never includes the received values. */
export function describeIssues(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((issue) => {
        const name = issue.path.join(".") || "environment";
        return issue.message.startsWith(name) ? issue.message : `${name}: ${issue.message}`;
      }),
    ),
  ];
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const result = schema.safeParse(withoutEmpty(source));
  if (!result.success) throw new EnvironmentError("API", describeIssues(result.error));
  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    apiOrigin: new URL(env.API_ORIGIN).origin,
    databaseUrl: env.DATABASE_URL,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    registrationEnabled: env.REGISTRATION_ENABLED === "true",
  };
}
