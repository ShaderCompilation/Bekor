import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const user = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});
export const session = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: instant("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_session_user_idx").on(t.userId)],
);
export const account = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: instant("access_token_expires_at"),
    refreshTokenExpiresAt: instant("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("auth_account_provider_idx").on(t.providerId, t.accountId)],
);
export const verification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: instant("expires_at").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});
export const rateLimit = pgTable("auth_rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
export const problems = pgTable("problems", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
});
export const exerciseVersions = pgTable(
  "exercise_versions",
  {
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => problems.id),
    version: text("version").notNull(),
    status: text("status").$type<"published" | "retired">().notNull().default("published"),
    contentHash: text("content_hash").notNull(),
    publishedAt: instant("published_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.exerciseId, t.version] }),
    check("exercise_version_status", sql`${t.status} in ('published','retired')`),
  ],
);
export const cliTokens = pgTable("cli_tokens", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hash: text("hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  expiresAt: instant("expires_at").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
  revokedAt: instant("revoked_at"),
  lastUsedAt: instant("last_used_at"),
});
export const preferences = pgTable(
  "preferences",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    timezone: text("timezone").notNull().default("UTC"),
    dailyReviewLimit: integer("daily_review_limit").notNull().default(20),
  },
  (t) => [check("preferences_daily_limit", sql`${t.dailyReviewLimit} between 1 and 100`)],
);
export const practiceSessions = pgTable(
  "practice_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => problems.id),
    exerciseVersion: text("exercise_version").notNull(),
    language: text("language").$type<"javascript" | "typescript">().notNull(),
    kind: text("kind").$type<"learning" | "review" | "practice">().notNull(),
    status: text("status").$type<"active" | "completed">().notNull().default("active"),
    createdAt: instant("created_at").notNull().defaultNow(),
    completedAt: instant("completed_at"),
    rating: text("rating").$type<"again" | "hard" | "good" | "easy">(),
    completion: jsonb("completion"),
    revision: integer("revision").notNull().default(0),
  },
  (t) => [
    uniqueIndex("one_active_scheduling_session")
      .on(t.userId, t.exerciseId, t.language)
      .where(sql`${t.status} = 'active' and ${t.kind} <> 'practice'`),
    check("session_language", sql`${t.language} in ('javascript','typescript')`),
    check("session_kind", sql`${t.kind} in ('learning','review','practice')`),
    check("session_status", sql`${t.status} in ('active','completed')`),
  ],
);
export const assistanceEvents = pgTable("assistance_events", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => practiceSessions.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"hint" | "solution_reveal" | "external_help">().notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
});
export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => problems.id),
    exerciseVersion: text("exercise_version").notNull(),
    language: text("language").$type<"javascript" | "typescript">().notNull(),
    mode: text("mode").$type<"run" | "submit">().notNull(),
    files: jsonb("files").$type<Record<string, string>>().notNull(),
    practiceSessionId: uuid("practice_session_id").references(() => practiceSessions.id),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status")
      .$type<"queued" | "running" | "completed" | "infrastructure_error">()
      .notNull()
      .default("queued"),
    verdict: text("verdict").$type<
      | "accepted"
      | "wrong_answer"
      | "syntax_error"
      | "compilation_error"
      | "runtime_error"
      | "time_limit_exceeded"
      | "memory_limit_exceeded"
      | "output_limit_exceeded"
    >(),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    completedAt: instant("completed_at"),
    passedCount: integer("passed_count").notNull().default(0),
    totalCount: integer("total_count").notNull(),
    diagnostic: text("diagnostic"),
    publicResults:
      jsonb("public_results").$type<
        Array<{ caseIndex: number; passed: boolean; actual?: unknown; diagnostic?: string }>
      >(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: instant("lease_expires_at"),
    workerAttempts: integer("worker_attempts").notNull().default(0),
  },
  (t) => [
    uniqueIndex("submission_idempotency").on(t.userId, t.idempotencyKey),
    index("submission_history").on(t.userId, t.createdAt, t.id),
    check("submission_language", sql`${t.language} in ('javascript','typescript')`),
    check("submission_mode", sql`${t.mode} in ('run','submit')`),
    check(
      "submission_status",
      sql`${t.status} in ('queued','running','completed','infrastructure_error')`,
    ),
    check(
      "submission_verdict",
      sql`${t.verdict} is null or ${t.verdict} in ('accepted','wrong_answer','syntax_error','compilation_error','runtime_error','time_limit_exceeded','memory_limit_exceeded','output_limit_exceeded')`,
    ),
    check(
      "submission_counts",
      sql`${t.passedCount} >= 0 and ${t.totalCount} between 1 and 100 and ${t.passedCount} <= ${t.totalCount}`,
    ),
  ],
);
export const executionAttempts = pgTable(
  "execution_attempts",
  {
    id: uuid("id").primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    caseIndex: integer("case_index").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").$type<"intent" | "dispatched" | "completed" | "uncertain">().notNull(),
    providerToken: text("provider_token"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
    result: jsonb("result"),
  },
  (t) => [
    uniqueIndex("execution_case_attempt").on(t.submissionId, t.caseIndex, t.attemptNumber),
    check(
      "execution_attempt_bounds",
      sql`${t.caseIndex} >= 0 and ${t.attemptNumber} between 1 and 3`,
    ),
  ],
);
export const caseResults = pgTable(
  "case_results",
  {
    id: uuid("id").primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    caseIndex: integer("case_index").notNull(),
    isPublic: boolean("is_public").notNull(),
    passed: boolean("passed").notNull(),
    verdict: text("verdict").notNull(),
    actual: jsonb("actual"),
    diagnostic: text("diagnostic"),
  },
  (t) => [uniqueIndex("case_result_once").on(t.submissionId, t.caseIndex)],
);
export const problemProgress = pgTable(
  "problem_progress",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => problems.id),
    language: text("language").$type<"javascript" | "typescript">().notNull(),
    firstAcceptedAt: instant("first_accepted_at").notNull(),
    lastAcceptedAt: instant("last_accepted_at").notNull(),
    lastSubmissionId: uuid("last_submission_id")
      .notNull()
      .references(() => submissions.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.exerciseId, t.language] })],
);
export const reviewCards = pgTable(
  "review_cards",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    exerciseId: text("exercise_id")
      .notNull()
      .references(() => problems.id),
    language: text("language").$type<"javascript" | "typescript">().notNull(),
    state: jsonb("state").notNull(),
    dueAt: instant("due_at").notNull(),
    schedulerVersion: text("scheduler_version").notNull(),
    configuration: jsonb("configuration").notNull(),
    revision: integer("revision").notNull().default(0),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("review_card_identity").on(t.userId, t.exerciseId, t.language),
    index("review_due").on(t.userId, t.dueAt),
  ],
);
export const reviewEvents = pgTable("review_events", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .unique()
    .references(() => practiceSessions.id),
  cardId: uuid("card_id")
    .notNull()
    .references(() => reviewCards.id),
  rating: text("rating").$type<"again" | "hard" | "good" | "easy">().notNull(),
  exerciseVersion: text("exercise_version").notNull(),
  createdAt: instant("created_at").notNull().defaultNow(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state").notNull(),
  assistance: jsonb("assistance").notNull(),
  schedulerVersion: text("scheduler_version").notNull(),
  configuration: jsonb("configuration").notNull(),
});
