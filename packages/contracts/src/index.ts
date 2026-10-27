import { z } from "zod";

export const API_VERSION = "v1" as const;
export const RUNTIME = "node-24.22.1-ts-7.0.2" as const;
export const MAX_SOURCE_BYTES = 65_536;
export const MAX_CASES = 32;
export const languageSchema = z.enum(["javascript", "typescript"]);
export type Language = z.infer<typeof languageSchema>;
export const verdictSchema = z.enum([
  "accepted",
  "wrong_answer",
  "syntax_error",
  "compilation_error",
  "runtime_error",
  "time_limit_exceeded",
  "memory_limit_exceeded",
  "output_limit_exceeded",
]);
export type Verdict = z.infer<typeof verdictSchema>;
export const submissionStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "infrastructure_error",
]);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;
export const ratingSchema = z.enum(["again", "hard", "good", "easy"]);
export type Rating = z.infer<typeof ratingSchema>;
export const sessionKindSchema = z.enum(["learning", "review", "practice"]);
export type SessionKind = z.infer<typeof sessionKindSchema>;

export type JsonValue =
  | null
  | boolean
  | string
  | number
  | JsonValue[]
  | { [key: string]: JsonValue };
// Bound shape before recursion: large/deep results must never exhaust the trusted worker.
export function isJsonValue(value: unknown): value is JsonValue {
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 32) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "string") return item.length <= 32_768;
    if (typeof item === "number") return Number.isSafeInteger(item);
    if (Array.isArray(item)) {
      if (
        item.length > 10_000 ||
        Object.keys(item).length !== item.length ||
        Reflect.ownKeys(item).length !== item.length + 1
      )
        return false;
      for (let i = 0; i < item.length; i++)
        if (!Object.hasOwn(item, i) || !visit(item[i], depth + 1)) return false;
      return true;
    }
    if (typeof item !== "object" || item === undefined) return false;
    const proto: unknown = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Reflect.ownKeys(item).length !== Object.keys(item).length) return false;
    return Object.entries(item).every(
      ([key, entry]) => key.length <= 1024 && visit(entry, depth + 1),
    );
  };
  return visit(value, 0);
}
// Native Zod metadata describes the custom type for OpenAPI generators without importing them here.
export const jsonValueSchema = z
  .custom<JsonValue>(isJsonValue, "Expected bounded JSON with safe integers")
  .meta({
    type: ["null", "boolean", "string", "integer", "array", "object"],
    description: "Bounded JSON value: safe integers only, no floats, depth <= 32.",
  });
export const executionLimitsSchema = z
  .object({
    timeMs: z.number().int().min(100).max(2000),
    memoryKb: z.number().int().min(16_384).max(262_144),
    outputBytes: z.number().int().min(1024).max(32_768),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof executionLimitsSchema>;
export const testCaseSchema = z
  .object({ args: z.array(jsonValueSchema).max(16), expected: jsonValueSchema })
  .strict();
export type TestCase = z.infer<typeof testCaseSchema>;
const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const versionSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$/);
export const languageVariantSchema = z
  .object({
    language: languageSchema,
    runtime: z.literal(RUNTIME),
    filename: z.enum(["solution.js", "solution.ts"]),
    entrypoint: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/),
    signature: z.string().max(2000),
    starter: z.string().max(MAX_SOURCE_BYTES),
    publicTests: z.array(testCaseSchema).min(1).max(MAX_CASES),
    limits: executionLimitsSchema,
  })
  .strict();
export type LanguageVariant = z.infer<typeof languageVariantSchema>;
export const publicExerciseSchema = z
  .object({
    id: idSchema,
    slug: idSchema,
    version: versionSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(30_000),
    difficulty: z.enum(["easy", "medium", "hard"]),
    concepts: z.array(z.string().max(80)).max(20),
    hints: z.array(z.string().max(2000)).max(10),
    attribution: z.string().max(2000),
    variants: z
      .object({ javascript: languageVariantSchema, typescript: languageVariantSchema })
      .strict(),
  })
  .strict();
export type PublicExercise = z.infer<typeof publicExerciseSchema>;
export const submissionCreateSchema = z
  .object({
    exerciseId: idSchema,
    exerciseVersion: versionSchema,
    language: languageSchema,
    files: z.record(z.string(), z.string().max(MAX_SOURCE_BYTES)),
    mode: z.enum(["run", "submit"]),
    practiceSessionId: z.uuid().optional(),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict()
  .superRefine((input, ctx) => {
    const filename = input.language === "javascript" ? "solution.js" : "solution.ts";
    if (Object.keys(input.files).length !== 1 || !Object.hasOwn(input.files, filename))
      ctx.addIssue({ code: "custom", path: ["files"], message: `Exactly ${filename} is required` });
    const source = input.files[filename];
    if (source !== undefined && new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES)
      ctx.addIssue({ code: "custom", path: ["files"], message: "Source exceeds byte limit" });
  });
export type SubmissionCreate = z.infer<typeof submissionCreateSchema>;
export const publicCaseResultSchema = z
  .object({
    caseIndex: z.number().int().nonnegative(),
    passed: z.boolean(),
    actual: jsonValueSchema.optional(),
    diagnostic: z.string().max(8192).optional(),
  })
  .strict();
export const submissionSchema = z
  .object({
    id: z.uuid(),
    exerciseId: idSchema,
    exerciseVersion: versionSchema,
    language: languageSchema,
    mode: z.enum(["run", "submit"]),
    practiceSessionId: z.uuid().nullable(),
    status: submissionStatusSchema,
    verdict: verdictSchema.nullable(),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    passedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    diagnostic: z.string().max(8192).nullable(),
    publicResults: z.array(publicCaseResultSchema),
    files: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type Submission = z.infer<typeof submissionSchema>;
export const paginationSchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type Page<T> = { items: T[]; nextCursor: string | null };
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }),
});
export const tokenScopeSchema = z.enum([
  "submissions:read",
  "submissions:write",
  "reviews:read",
  "reviews:write",
]);
export type TokenScope = z.infer<typeof tokenScopeSchema>;
export const tokenCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(tokenScopeSchema).min(1).max(4),
    expiresInDays: z.number().int().min(1).max(90),
  })
  .strict();
export type TokenCreate = z.infer<typeof tokenCreateSchema>;
export const credentialSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(tokenScopeSchema),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type Credential = z.infer<typeof credentialSchema>;
export const tokenCreatedSchema = z.object({ token: z.string(), credential: credentialSchema });
export const settingsSchema = z
  .object({
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Unknown timezone"),
    dailyReviewLimit: z.number().int().min(1).max(100),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const sessionStartSchema = z
  .object({
    exerciseId: idSchema,
    exerciseVersion: versionSchema,
    language: languageSchema,
    kind: sessionKindSchema,
  })
  .strict();
export type SessionStart = z.infer<typeof sessionStartSchema>;
export const sessionCompleteSchema = z.object({ rating: ratingSchema }).strict();
export const assistanceSchema = z
  .object({ kind: z.enum(["hint", "solution_reveal", "external_help"]) })
  .strict();
export type AssistanceKind = z.infer<typeof assistanceSchema>["kind"];
// Returned only after the server records a solution_reveal for the session.
export const revealSchema = z
  .object({
    session: z.lazy(() => practiceSessionSchema),
    explanation: z.string(),
    solution: z.string(),
  })
  .strict();
export type Reveal = { session: PracticeSession; explanation: string; solution: string };
export const practiceSessionSchema = z.object({
  id: z.uuid(),
  exerciseId: idSchema,
  exerciseVersion: versionSchema,
  language: languageSchema,
  kind: sessionKindSchema,
  status: z.enum(["active", "completed"]),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  rating: ratingSchema.nullable(),
  solutionRevealed: z.boolean(),
  hintUsed: z.boolean(),
});
export type PracticeSession = z.infer<typeof practiceSessionSchema>;
export const reviewCardSchema = z.object({
  id: z.uuid(),
  exerciseId: idSchema,
  language: languageSchema,
  due: z.iso.datetime(),
  state: z.record(z.string(), z.unknown()),
  schedulerVersion: z.string(),
});
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export const completionSchema = z.object({
  session: practiceSessionSchema,
  card: reviewCardSchema.nullable(),
});
export type Completion = z.infer<typeof completionSchema>;
export const reviewQueueSchema = z.object({
  due: z.array(reviewCardSchema),
  unfinished: z.array(practiceSessionSchema),
  timezone: z.string(),
  dailyReviewLimit: z.number().int(),
  hasMore: z.boolean(),
});
export type ReviewQueue = z.infer<typeof reviewQueueSchema>;
export const downloadSchema = z.object({ files: z.record(z.string(), z.string()) }).strict();
export type Download = z.infer<typeof downloadSchema>;
