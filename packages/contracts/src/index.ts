import { z } from "zod";

export const API_VERSION = "v1" as const;
export const RUNTIME = "node-24.22.1-ts-7.0.2" as const;
export const MAX_SOURCE_BYTES = 65_536;
export const MAX_CASES = 32;
export const languageSchema = z.enum(["javascript", "typescript"]);
export type Language = z.infer<typeof languageSchema>;
export const difficultySchema = z.enum(["easy", "medium", "hard"]);
export type Difficulty = z.infer<typeof difficultySchema>;
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
    difficulty: difficultySchema,
    concepts: z.array(z.string().max(80)).max(20),
    hints: z.array(z.string().max(2000)).max(10),
    attribution: z.string().max(2000),
    variants: z
      .object({ javascript: languageVariantSchema, typescript: languageVariantSchema })
      .strict(),
  })
  .strict();
export type PublicExercise = z.infer<typeof publicExerciseSchema>;
// DOM projects use their own browser contract; Node exercise shapes remain unchanged.
export const frameworkSchema = z.enum(["vanilla", "react", "vue", "svelte"]);
export type Framework = z.infer<typeof frameworkSchema>;
export const domFilesSchema = z
  .record(
    z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*\.(?:html|css|js|jsx|ts|tsx|vue|svelte)$/),
    z.string().max(MAX_SOURCE_BYTES),
  )
  .superRefine((files, ctx) => {
    if (
      Object.keys(files).length < 1 ||
      Object.keys(files).length > 8 ||
      new TextEncoder().encode(Object.values(files).join("")).byteLength > MAX_SOURCE_BYTES
    )
      ctx.addIssue({ code: "custom", message: "DOM project exceeds file/byte budget" });
  });
export const DOM_DEPENDENCIES = {
  vanilla: {},
  react: { react: "18.3.1", "react-dom": "18.3.1" },
  vue: { vue: "3.5.13", "@vue/cli-plugin-babel": "5.0.8", "@vue/cli-service": "5.0.8" },
  svelte: { svelte: "3.59.2" },
} as const;
export const domVariantSchema = z
  .object({
    id: z.string().regex(/^(vanilla|react|vue|svelte)-(javascript|typescript)$/),
    framework: frameworkSchema,
    language: languageSchema,
    entry: z.string(),
    compilerVersion: z.string().min(1).max(80),
    dependencies: z.record(
      z.string().regex(/^[@a-z][a-z0-9@/._-]*$/),
      z.string().regex(/^\d+\.\d+\.\d+$/),
    ),
    files: domFilesSchema,
  })
  .strict()
  .superRefine((variant, ctx) => {
    const expected = DOM_DEPENDENCIES[variant.framework];
    if (
      variant.compilerVersion !== "sandpack-2.19.8" ||
      Object.keys(variant.dependencies).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([name, version]) => variant.dependencies[name] !== version)
    )
      ctx.addIssue({
        code: "custom",
        message: "Unsupported compiler or framework dependency versions",
      });
    if (
      variant.id !== `${variant.framework}-${variant.language}` ||
      !Object.hasOwn(variant.files, variant.entry)
    )
      ctx.addIssue({ code: "custom", message: "Variant identity/entry mismatch" });
  });
export type DomVariant = z.infer<typeof domVariantSchema>;
export const domExerciseSchema = publicExerciseSchema
  .omit({ variants: true })
  .extend({
    kind: z.literal("dom"),
    assessment: z.literal("self"),
    runtime: z.literal("browser"),
    checklist: z.array(z.string().min(1).max(1000)).min(1).max(20),
    variants: z.array(domVariantSchema).min(1).max(8),
  })
  .strict()
  .superRefine((exercise, ctx) => {
    if (new Set(exercise.variants.map((v) => v.id)).size !== exercise.variants.length)
      ctx.addIssue({ code: "custom", message: "Duplicate DOM variant" });
  });
export type DomExercise = z.infer<typeof domExerciseSchema>;
export const exerciseDetailSchema = z.union([publicExerciseSchema, domExerciseSchema]);
export type ExerciseDetail = z.infer<typeof exerciseDetailSchema>;
export function isDomExercise(exercise: ExerciseDetail): exercise is DomExercise {
  return "kind" in exercise && exercise.kind === "dom";
}
export const selfAssessmentSchema = z.enum(["solved", "unable"]);
export type SelfAssessment = z.infer<typeof selfAssessmentSchema>;
export const assessmentEvidenceSchema = z.object({
  outcome: selfAssessmentSchema,
  provenance: z.literal("self"),
  assessedAt: z.iso.datetime(),
});
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
/** Catalog list entry: just what a list row needs. Full content comes from the detail endpoint. */
export const problemSummarySchema = z
  .object({
    kind: z.literal("dom").optional(),
    assessment: z.literal("self").optional(),
    id: idSchema,
    slug: idSchema,
    version: versionSchema,
    title: z.string().min(1).max(200),
    difficulty: difficultySchema,
    concepts: z.array(z.string().max(80)).max(20),
  })
  .strict();
export type ProblemSummary = z.infer<typeof problemSummarySchema>;
/** Filters apply before paging; `ids` (comma-separated) looks up specific problems. */
export const problemListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  difficulty: difficultySchema.optional(),
  concept: z.string().max(80).optional(),
  ids: z
    .string()
    .max(8200)
    .transform((value) => value.split(",").filter(Boolean))
    .pipe(z.array(idSchema).max(100))
    .optional(),
});
export type ProblemListQuery = z.infer<typeof problemListQuerySchema>;
export const conceptListSchema = z.object({ items: z.array(z.string()) });
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
    requestId: z.uuid().optional(),
    exerciseId: idSchema,
    exerciseVersion: versionSchema,
    language: languageSchema,
    kind: sessionKindSchema,
    framework: frameworkSchema.optional(),
  })
  .strict();
export type SessionStart = z.infer<typeof sessionStartSchema>;
export const sessionCompleteSchema = z
  .object({ rating: ratingSchema.optional(), selfAssessment: selfAssessmentSchema.optional() })
  .strict();
export type SessionComplete = z.infer<typeof sessionCompleteSchema>;
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
    files: domFilesSchema.optional(),
  })
  .strict();
export type Reveal = {
  session: PracticeSession;
  explanation: string;
  solution: string;
  files?: Record<string, string> | undefined;
};
export const practiceSessionSchema = z.object({
  framework: frameworkSchema.optional(),
  assessment: assessmentEvidenceSchema.nullable().optional(),
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
  framework: frameworkSchema.optional(),
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
