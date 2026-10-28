import { randomUUID } from "node:crypto";
import type { Language, Rating, SessionKind } from "@bekor/contracts";
import { and, eq } from "drizzle-orm";
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
import {
  assistanceEvents,
  createDatabase,
  practiceSessions,
  reviewCards,
  reviewEvents,
  submissions,
  user,
} from "../../../packages/db/src/index.js";
import { migrateDatabase } from "../../../packages/db/src/migrate.js";
import { getExercise } from "../../../packages/exercises/src/index.js";
import { schedule } from "../../../packages/scheduling/src/index.js";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/index.js";

type Credential = { cookie: string } | { token: string };
const adminUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!adminUrl)(
  "real PostgreSQL review sessions/cards/events (judging SIMULATED by direct row updates; no runner)",
  () => {
    const databaseName = `bekor_reviews_${randomUUID().replaceAll("-", "")}`;
    const origin = "http://localhost:3000";
    let admin: pg.Pool;
    let database: ReturnType<typeof createDatabase>;
    let boss: Awaited<ReturnType<typeof createQueue>>;
    let submissionService: ReturnType<typeof createSubmissionService>;
    let reviews: ReturnType<typeof createReviewService>;
    let settings: ReturnType<typeof createSettingsService>;
    let tokens: ReturnType<typeof createTokenService>;
    let app: ReturnType<typeof createApp>;
    let time = Date.parse("2026-10-27T12:00:00.000Z");
    const clock = () => new Date(time);
    const advance = (ms: number) => {
      time += ms;
    };

    async function newUser() {
      const id = randomUUID();
      await database.db.insert(user).values({ id, name: "Reviewer", email: `${id}@example.test` });
      return id;
    }
    async function signUp() {
      const response = await app.request(`${origin}/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          name: "Cookie Reviewer",
          email: `${randomUUID()}@example.test`,
          password: "a-secure-test-password-123",
        }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      return { userId: (await response.json()).user.id as string, cookie };
    }
    /** Token principal for a fresh user (avoids Better Auth sign-up rate limiting). */
    async function tokenUser(
      scopes: ("reviews:read" | "reviews:write")[] = ["reviews:read", "reviews:write"],
    ) {
      const userId = await newUser();
      const { token } = await tokens.create(userId, { name: "CLI", scopes, expiresInDays: 1 });
      return { userId, token };
    }
    async function call(credential: Credential, path: string, method = "GET", body?: unknown) {
      const headers: Record<string, string> =
        "cookie" in credential
          ? { Cookie: credential.cookie, Origin: origin }
          : { Authorization: `Bearer ${credential.token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await app.request(`${origin}/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }
    const start = (
      userId: string,
      kind: SessionKind,
      language: Language = "javascript",
      exerciseId = "cumulative-sums",
    ) => reviews.start(userId, { exerciseId, exerciseVersion: "1.0.0", language, kind });
    /** Creates a real queued submission, then SIMULATES judging by writing the terminal row. */
    async function simulatedJudgedAttempt(
      userId: string,
      sessionId: string,
      mode: "run" | "submit",
      outcome: "accepted" | "wrong_answer" | "infrastructure_error",
    ) {
      const [session] = await database.db
        .select()
        .from(practiceSessions)
        .where(eq(practiceSessions.id, sessionId));
      if (!session) throw new Error("missing session");
      const filename = session.language === "javascript" ? "solution.js" : "solution.ts";
      const created = await submissionService.create(userId, {
        exerciseId: session.exerciseId,
        exerciseVersion: session.exerciseVersion,
        language: session.language,
        files: { [filename]: "SIMULATED: never executed" },
        mode,
        practiceSessionId: sessionId,
        idempotencyKey: randomUUID(),
      });
      await database.db
        .update(submissions)
        .set(
          outcome === "infrastructure_error"
            ? { status: "infrastructure_error", verdict: null, completedAt: new Date() }
            : { status: "completed", verdict: outcome, completedAt: new Date() },
        )
        .where(eq(submissions.id, created.id));
    }
    async function enroll(
      userId: string,
      language: Language = "javascript",
      rating: Rating = "good",
    ) {
      const session = await start(userId, "learning", language);
      await simulatedJudgedAttempt(userId, session.id, "submit", "accepted");
      advance(1000);
      return reviews.complete(userId, session.id, rating);
    }
    async function cardRow(userId: string, language: Language = "javascript") {
      const [card] = await database.db
        .select()
        .from(reviewCards)
        .where(
          and(
            eq(reviewCards.userId, userId),
            eq(reviewCards.exerciseId, "cumulative-sums"),
            eq(reviewCards.language, language),
          ),
        );
      return card;
    }
    async function eventsFor(sessionId: string) {
      return database.db.select().from(reviewEvents).where(eq(reviewEvents.sessionId, sessionId));
    }

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: adminUrl });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(adminUrl as string);
      url.pathname = `/${databaseName}`;
      database = createDatabase(url.toString());
      await migrateDatabase(database);
      boss = await createQueue(url.toString());
      const catalog = createCatalogService(database);
      await catalog.publish();
      submissionService = createSubmissionService(database, boss, catalog);
      reviews = createReviewService(database, catalog, clock);
      settings = createSettingsService(database);
      tokens = createTokenService(database);
      app = createApp({
        origin,
        auth: createAuth(database, {
          origin,
          secret: "integration-only-secret-32-characters-minimum",
          registrationEnabled: true,
        }),
        catalog,
        submissions: submissionService,
        tokens,
        settings,
        reviews,
        progress: createProgressService(database, catalog, settings, clock),
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

    it("enrolls via HTTP only after a simulated accepted Submit; run and infra errors are not evidence", async () => {
      const { userId, cookie } = await signUp();
      const credential = { cookie };
      const started = await call(credential, "/practice-sessions", "POST", {
        exerciseId: "cumulative-sums",
        exerciseVersion: "1.0.0",
        language: "javascript",
        kind: "learning",
      });
      expect(started.status).toBe(200);
      const id = started.body.id as string;
      const complete = (rating: Rating) =>
        call(credential, `/practice-sessions/${id}/complete`, "POST", { rating });

      expect((await complete("good")).body.error.code).toBe("INVALID_RATING_EVIDENCE");
      await simulatedJudgedAttempt(userId, id, "submit", "infrastructure_error");
      expect((await complete("again")).body.error.code).toBe("INVALID_RATING_EVIDENCE");
      await simulatedJudgedAttempt(userId, id, "run", "accepted");
      const runOnly = await complete("good");
      expect(runOnly.status).toBe(409);
      expect(runOnly.body.error.code).toBe("INVALID_RATING_EVIDENCE");
      expect(await cardRow(userId)).toBeUndefined();

      await simulatedJudgedAttempt(userId, id, "submit", "accepted");
      advance(1000);
      const done = await complete("good");
      expect(done.status).toBe(200);
      expect(done.body.session).toMatchObject({ id, status: "completed", rating: "good" });
      const card = await cardRow(userId);
      expect(card).toMatchObject({ id: done.body.card.id, revision: 0 });
      expect(done.body.card.due).toBe(new Date(time + 10 * 60_000).toISOString());
      const [event] = await eventsFor(id);
      expect(event).toMatchObject({ cardId: card?.id, rating: "good", beforeState: null });

      const repeat = await complete("good");
      expect(repeat).toEqual(done);
      const conflict = await complete("easy");
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe("RATING_CONFLICT");
      expect(await eventsFor(id)).toHaveLength(1);
      await expect(start(userId, "learning")).rejects.toMatchObject({ code: "ALREADY_ENROLLED" });
    });

    it("resumes the session of a concurrent writer that committed first (no duplicate, no 500)", async () => {
      const userId = await newUser();
      const competitor = randomUUID();
      const client = await database.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `insert into practice_sessions (id, user_id, exercise_id, exercise_version, language, kind)
           values ($1, $2, 'compact-spaces', '1.0.0', 'javascript', 'learning')`,
          [competitor, userId],
        );
        const pending = start(userId, "learning", "javascript", "compact-spaces");
        // The competitor's FK key-share lock on the user row blocks the service's user lock, so
        // the service sees the committed session; the unique-violation retry is a backstop.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await client.query("COMMIT");
        expect((await pending).id).toBe(competitor);
      } finally {
        client.release();
      }
      const rows = await database.db
        .select()
        .from(practiceSessions)
        .where(eq(practiceSessions.userId, userId));
      expect(rows).toHaveLength(1);
    });

    it("refuses review sessions without a card", async () => {
      const userId = await newUser();
      await expect(start(userId, "review")).rejects.toMatchObject({
        code: "NOT_ENROLLED",
        status: 409,
      });
    });

    it("resumes one scheduling session across cookie and token principals; practice is separate", async () => {
      const { userId, cookie } = await signUp();
      const { token } = await tokens.create(userId, {
        name: "CLI",
        scopes: ["reviews:read", "reviews:write"],
        expiresInDays: 1,
      });
      const body = {
        exerciseId: "cumulative-sums",
        exerciseVersion: "1.0.0",
        language: "typescript",
        kind: "learning",
      };
      const browser = await call({ cookie }, "/practice-sessions", "POST", body);
      const cli = await call({ token }, "/practice-sessions", "POST", body);
      expect(browser.status).toBe(200);
      expect(cli.body).toEqual(browser.body);
      const [a, b] = await Promise.all([start(userId, "learning"), start(userId, "learning")]);
      expect(a.id).toBe(b.id);
      const p1 = await start(userId, "practice");
      const p2 = await start(userId, "practice");
      expect(new Set([browser.body.id, a.id, p1.id, p2.id]).size).toBe(4);
      const queue = await call({ token }, "/me/reviews");
      expect(queue.status).toBe(200);
      expect(queue.body.unfinished.map((s: { id: string }) => s.id).sort()).toEqual(
        [browser.body.id, a.id, p1.id, p2.id].sort(),
      );
    });

    it("reveal returns authored explanation/solution, records one event, and forces Again", async () => {
      const { userId, token } = await tokenUser();
      await enroll(userId);
      advance(86_400_000);
      const session = await start(userId, "review");
      await simulatedJudgedAttempt(userId, session.id, "submit", "accepted");
      const exercise = getExercise("cumulative-sums", "1.0.0");
      const reveal = await call({ token }, `/practice-sessions/${session.id}/reveal`, "POST", {});
      expect(reveal.status).toBe(200);
      expect(reveal.body).toEqual({
        session: expect.objectContaining({
          id: session.id,
          solutionRevealed: true,
          hintUsed: false,
        }),
        explanation: exercise?.explanation,
        solution: exercise?.referenceSolutions.javascript,
      });
      const again = await call({ token }, `/practice-sessions/${session.id}/reveal`, "POST", {});
      expect(again.body).toEqual(reveal.body);
      const recorded = await database.db
        .select()
        .from(assistanceEvents)
        .where(eq(assistanceEvents.sessionId, session.id));
      expect(recorded.map((event) => event.kind)).toEqual(["solution_reveal"]);

      const other = await tokenUser();
      const foreign = await call(
        { token: other.token },
        `/practice-sessions/${session.id}/reveal`,
        "POST",
        {},
      );
      expect(foreign.status).toBe(404);

      advance(1000);
      await expect(reviews.complete(userId, session.id, "good")).rejects.toMatchObject({
        code: "INVALID_RATING_EVIDENCE",
      });
      const completed = await reviews.complete(userId, session.id, "again");
      expect(completed.session.solutionRevealed).toBe(true);
      const [event] = await eventsFor(session.id);
      expect(event?.assistance).toEqual([{ kind: "solution_reveal", at: expect.any(String) }]);
      expect(
        (await call({ token }, `/practice-sessions/${session.id}/reveal`, "POST", {})).status,
      ).toBe(200);

      advance(1000);
      const unrevealed = await start(userId, "practice");
      await simulatedJudgedAttempt(userId, unrevealed.id, "submit", "accepted");
      await reviews.complete(userId, unrevealed.id, "good");
      const late = await call({ token }, `/practice-sessions/${unrevealed.id}/reveal`, "POST", {});
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("SESSION_COMPLETED");
    });

    it("concurrent completion yields exactly one review event and one card revision", async () => {
      const userId = await newUser();
      await enroll(userId, "javascript", "easy");
      const before = await cardRow(userId);
      advance(9 * 86_400_000);
      const session = await start(userId, "review");
      await simulatedJudgedAttempt(userId, session.id, "submit", "accepted");
      const [a, b] = await Promise.all([
        reviews.complete(userId, session.id, "good"),
        reviews.complete(userId, session.id, "good"),
      ]);
      expect(a).toEqual(b);
      expect(await eventsFor(session.id)).toHaveLength(1);
      const after = await cardRow(userId);
      expect(after?.revision).toBe((before?.revision ?? 0) + 1);
      expect(after?.dueAt.getTime()).toBeGreaterThan(before?.dueAt.getTime() ?? 0);
      const [event] = await eventsFor(session.id);
      expect(event?.beforeState).toEqual(before?.state);
      expect(event?.afterState).toEqual(after?.state);
    });

    it("unscheduled practice never alters an existing card", async () => {
      const userId = await newUser();
      await enroll(userId);
      const before = await cardRow(userId);
      advance(1000);
      const practice = await start(userId, "practice");
      await simulatedJudgedAttempt(userId, practice.id, "submit", "accepted");
      const result = await reviews.complete(userId, practice.id, "easy");
      expect(result.card).toBeNull();
      expect(await cardRow(userId)).toEqual(before);
      expect(await eventsFor(practice.id)).toHaveLength(0);
    });

    it("keeps sessions owner-only and enforces reviews:write token scope", async () => {
      const owner = await tokenUser();
      const session = await start(owner.userId, "learning");
      const intruder = await tokenUser();
      for (const path of ["assistance", "complete", "reveal"]) {
        const body =
          path === "assistance" ? { kind: "hint" } : path === "complete" ? { rating: "again" } : {};
        const response = await call(
          { token: intruder.token },
          `/practice-sessions/${session.id}/${path}`,
          "POST",
          body,
        );
        expect(response.status, path).toBe(404);
      }
      const { token } = await tokens.create(owner.userId, {
        name: "Read only",
        scopes: ["reviews:read"],
        expiresInDays: 1,
      });
      expect((await call({ token }, "/me/reviews")).status).toBe(200);
      const denied = await call({ token }, `/practice-sessions/${session.id}/assistance`, "POST", {
        kind: "hint",
      });
      expect(denied.status).toBe(403);
      const deniedStart = await call({ token }, "/practice-sessions", "POST", {
        exerciseId: "cumulative-sums",
        exerciseVersion: "1.0.0",
        language: "javascript",
        kind: "practice",
      });
      expect(deniedStart.status).toBe(403);
      const hint = await call(
        { token: owner.token },
        `/practice-sessions/${session.id}/assistance`,
        "POST",
        { kind: "hint" },
      );
      expect(hint.body).toMatchObject({ hintUsed: true, solutionRevealed: false });
    });

    it("groups the queue by the user's local day, orders overdue first, and limits with hasMore", async () => {
      const userId = await newUser();
      const saved = time;
      time = Date.parse("2026-10-27T12:00:00.000Z");
      const fixture = async (exerciseId: string, language: Language, due: string) => {
        // Fixture card with a valid scheduler state; due time pinned for boundary checks.
        const next = schedule(null, "good", new Date("2024-12-31T00:00:00.000Z"));
        const id = randomUUID();
        await database.db.insert(reviewCards).values({
          id,
          userId,
          exerciseId,
          language,
          state: next.state,
          dueAt: new Date(due),
          schedulerVersion: next.schedulerVersion,
          configuration: next.configuration,
        });
        return id;
      };
      const overdue = await fixture("word-counts", "typescript", "2025-01-01T00:00:00.000Z");
      const lateTonightNy = await fixture(
        "cumulative-sums",
        "javascript",
        "2026-10-28T03:59:59.999Z",
      );
      await fixture("compact-spaces", "javascript", "2026-10-28T04:00:00.000Z");
      const ids = async () => (await reviews.queue(userId)).due.map((card) => card.id);

      expect(await ids()).toEqual([overdue]);
      await settings.update(userId, { timezone: "America/New_York", dailyReviewLimit: 20 });
      expect(await ids()).toEqual([overdue, lateTonightNy]);
      await settings.update(userId, { timezone: "America/New_York", dailyReviewLimit: 1 });
      const limited = await reviews.queue(userId);
      expect(limited).toMatchObject({
        timezone: "America/New_York",
        dailyReviewLimit: 1,
        hasMore: true,
      });
      expect(limited.due.map((card) => card.id)).toEqual([overdue]);
      await settings.update(userId, { timezone: "America/New_York", dailyReviewLimit: 2 });
      expect((await reviews.queue(userId)).hasMore).toBe(false);
      // At the next local midnight every card is due; the limit caps the list, none expire.
      time = Date.parse("2026-10-28T04:00:00.000Z");
      const tomorrow = await reviews.queue(userId);
      expect(tomorrow.due.map((card) => card.id)).toEqual([overdue, lateTonightNy]);
      expect(tomorrow.hasMore).toBe(true);
      time = Math.max(saved, time);
    });

    it("keeps independent JavaScript and TypeScript cards for the same problem", async () => {
      const userId = await newUser();
      await enroll(userId, "javascript", "easy");
      const jsBefore = await cardRow(userId, "javascript");
      await expect(start(userId, "review", "typescript")).rejects.toMatchObject({
        code: "NOT_ENROLLED",
      });
      await enroll(userId, "typescript", "good");
      const ts = await cardRow(userId, "typescript");
      expect(ts?.id).not.toBe(jsBefore?.id);
      advance(9 * 86_400_000);
      const review = await start(userId, "review", "typescript");
      await simulatedJudgedAttempt(userId, review.id, "submit", "wrong_answer");
      await reviews.complete(userId, review.id, "again");
      expect(await cardRow(userId, "javascript")).toEqual(jsBefore);
      expect((await cardRow(userId, "typescript"))?.revision).toBe(1);
    });
  },
);
