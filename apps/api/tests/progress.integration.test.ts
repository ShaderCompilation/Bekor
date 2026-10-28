import { randomUUID } from "node:crypto";
import { progressSchema } from "@bekor/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCatalogService,
  createProgressService,
  createQueue,
  createReviewService,
  createSettingsService,
  createSubmissionService,
  createTokenService,
} from "../../../packages/core/src/index.js";
import { createDatabase, problemProgress, user } from "../../../packages/db/src/index.js";
import { migrateDatabase } from "../../../packages/db/src/migrate.js";
import { listDomExercises, listExercises } from "../../../packages/exercises/src/index.js";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/index.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const origin = "http://localhost:3000";
const now = new Date("2026-10-28T12:00:00.000Z");

describe.skipIf(!adminUrl)("GET /me/progress against real PostgreSQL", () => {
  const databaseName = `bekor_progress_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let database: ReturnType<typeof createDatabase>;
  let boss: Awaited<ReturnType<typeof createQueue>>;
  let reviews: ReturnType<typeof createReviewService>;
  let settings: ReturnType<typeof createSettingsService>;
  let progress: ReturnType<typeof createProgressService>;
  let tokens: ReturnType<typeof createTokenService>;
  let app: ReturnType<typeof createApp>;
  const [solvedNode, attemptedNode] = listExercises().map((exercise) => exercise.public);
  const dom = listDomExercises()[0]?.public;
  if (!solvedNode || !attemptedNode || !dom) throw new Error("Expected catalog content");

  async function newUser() {
    const id = randomUUID();
    await database.db.insert(user).values({ id, name: "Learner", email: `${id}@example.test` });
    return id;
  }
  async function submission(
    userId: string,
    exercise: { id: string; version: string },
    createdAt: Date,
    mode: "run" | "submit",
    verdict: string,
  ) {
    const id = randomUUID();
    await database.pool.query(
      `insert into submissions (id, user_id, exercise_id, exercise_version, language, mode, files,
         idempotency_key, payload_hash, status, verdict, total_count, created_at, completed_at)
       values ($1::uuid, $2, $3, $4, 'javascript', $5, '{}', $1::text, 'hash', 'completed', $6, 1, $7, $7)`,
      [id, userId, exercise.id, exercise.version, mode, verdict, createdAt],
    );
    return id;
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${databaseName}`;
    database = createDatabase(url.toString());
    await migrateDatabase(database);
    const catalog = createCatalogService(database);
    await catalog.publish();
    boss = await createQueue(url.toString());
    reviews = createReviewService(database, catalog, () => now);
    settings = createSettingsService(database);
    progress = createProgressService(database, catalog, settings, () => now);
    tokens = createTokenService(database);
    app = createApp({
      origin,
      catalog,
      reviews,
      tokens,
      settings,
      progress,
      auth: createAuth(database, {
        origin,
        secret: "progress-integration-only-secret-32-characters",
        registrationEnabled: false,
      }),
      submissions: createSubmissionService(database, boss, catalog),
      health: async () => {
        await database.pool.query("select 1");
      },
    });
  }, 30000);
  afterAll(async () => {
    await boss?.stop();
    await database?.close();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("returns an empty progress with catalog totals for a new user", async () => {
    const result = await progress.get(await newUser());
    expect(result.items).toEqual([]);
    expect(result.activity).toEqual([]);
    expect(result.totals.solved).toEqual({ easy: 0, medium: 0, hard: 0 });
    const all = [...listExercises(), ...listDomExercises()];
    expect(
      result.totals.catalog.easy + result.totals.catalog.medium + result.totals.catalog.hard,
    ).toBe(all.length);
  });

  it("combines judged solves, attempts and DOM self-assessments, bucketed by local day", async () => {
    const uid = await newUser();
    await settings.update(uid, { timezone: "America/Los_Angeles", dailyReviewLimit: 20 });
    // 2026-10-28T03:00Z is still 2026-10-27 in Los Angeles.
    const lateEvening = new Date("2026-10-28T03:00:00.000Z");
    await submission(uid, solvedNode, lateEvening, "run", "wrong_answer");
    const accepted = await submission(uid, solvedNode, lateEvening, "submit", "accepted");
    await database.db.insert(problemProgress).values({
      userId: uid,
      exerciseId: solvedNode.id,
      language: "javascript",
      firstAcceptedAt: lateEvening,
      lastAcceptedAt: lateEvening,
      lastSubmissionId: accepted,
    });
    await submission(uid, attemptedNode, now, "submit", "wrong_answer");
    // Activity older than a year is excluded from the heatmap but still counts for status.
    await submission(uid, attemptedNode, new Date("2025-06-01T12:00:00.000Z"), "run", "accepted");
    const session = await reviews.start(uid, {
      exerciseId: dom.id,
      exerciseVersion: dom.version,
      framework: "vanilla",
      language: "javascript",
      kind: "practice",
    });
    await reviews.complete(uid, session.id, undefined, "solved");

    const result = progressSchema.parse(await progress.get(uid));
    const status = Object.fromEntries(result.items.map((item) => [item.exerciseId, item.status]));
    expect(status).toEqual({
      [solvedNode.id]: "solved",
      [attemptedNode.id]: "attempted",
      [dom.id]: "solved",
    });
    expect(result.timezone).toBe("America/Los_Angeles");
    expect(result.activity).toEqual([
      { date: "2026-10-27", attempts: 2, solved: 1 },
      { date: "2026-10-28", attempts: 2, solved: 1 },
    ]);
    const solvedTotal =
      result.totals.solved.easy + result.totals.solved.medium + result.totals.solved.hard;
    expect(solvedTotal).toBe(2);
    expect(result.totals.solved[solvedNode.difficulty]).toBeGreaterThanOrEqual(1);
  });

  it("serves only the caller's progress over HTTP and requires a read scope", async () => {
    const uid = await newUser();
    await submission(await newUser(), solvedNode, now, "run", "wrong_answer");
    const call = async (token: string) => {
      const response = await app.request(`${origin}/api/v1/me/progress`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    };
    const read = (
      await tokens.create(uid, { name: "read", scopes: ["submissions:read"], expiresInDays: 1 })
    ).token;
    const ok = await call(read);
    expect(ok.status).toBe(200);
    expect(progressSchema.parse(ok.body).items).toEqual([]);
    const wrongScope = (
      await tokens.create(uid, { name: "reviews", scopes: ["reviews:read"], expiresInDays: 1 })
    ).token;
    expect((await call(wrongScope)).status).toBe(403);
    expect((await app.request(`${origin}/api/v1/me/progress`)).status).toBe(401);
  });
  it("filters the catalog by the caller's status with correct paging, and samples randomly", async () => {
    const uid = await newUser();
    await submission(uid, attemptedNode, now, "run", "wrong_answer");
    const read = (
      await tokens.create(uid, { name: "read", scopes: ["submissions:read"], expiresInDays: 1 })
    ).token;
    const list = async (query: string, token?: string) => {
      const response = await app.request(`${origin}/api/v1/problems?${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return { status: response.status, body: await response.json() };
    };
    expect((await list("status=solved")).status).toBe(401);
    const attempted = await list("status=attempted", read);
    expect(attempted.status).toBe(200);
    expect(attempted.body.items.map((item: { id: string }) => item.id)).toEqual([attemptedNode.id]);
    expect((await list("status=solved", read)).body.items).toEqual([]);

    // "todo" pages through everything except the attempted problem.
    const total = listExercises().length + listDomExercises().length;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(`status=todo&limit=100${cursor ? `&cursor=${cursor}` : ""}`, read);
      seen.push(...page.body.items.map((item: { id: string }) => item.id));
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(total - 1);
    expect(seen).not.toContain(attemptedNode.id);

    const sample = await list("order=random&limit=5&difficulty=easy");
    expect(sample.status).toBe(200);
    expect(sample.body.nextCursor).toBeNull();
    expect(sample.body.items).toHaveLength(5);
    expect(new Set(sample.body.items.map((item: { id: string }) => item.id)).size).toBe(5);
    for (const item of sample.body.items) expect(item.difficulty).toBe("easy");
    const none = await list("order=random&limit=1&q=no-such-problem-text");
    expect(none.body.items).toEqual([]);
  });
});
