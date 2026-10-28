import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  downloadSchema,
  exerciseDetailSchema,
  type Framework,
  isDomExercise,
  type Rating,
} from "@bekor/contracts";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCatalogService,
  createQueue,
  createReviewService,
  createSettingsService,
  createSubmissionService,
  createTokenService,
} from "../../../packages/core/src/index.js";
import { domCompletionViolation } from "../../../packages/core/src/reviews.js";
import {
  createDatabase,
  exerciseVersions,
  practiceSessions,
  reviewCards,
  reviewEvents,
  submissions,
  user,
} from "../../../packages/db/src/index.js";
import { migrateDatabase } from "../../../packages/db/src/migrate.js";
import { getDomExercise } from "../../../packages/exercises/src/index.js";
import { schedule } from "../../../packages/scheduling/src/index.js";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/index.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const exerciseId = "accessible-accordion";
const exerciseVersion = "1.0.0";
const origin = "http://localhost:3000";
const now = new Date("2026-10-28T12:00:00.000Z");

describe.skipIf(!adminUrl)(
  "DOM self-assessment against real PostgreSQL (no learner execution)",
  () => {
    const databaseName = `bekor_dom_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool;
    let database: ReturnType<typeof createDatabase>;
    let boss: Awaited<ReturnType<typeof createQueue>>;
    let catalog: ReturnType<typeof createCatalogService>;
    let reviews: ReturnType<typeof createReviewService>;
    let tokens: ReturnType<typeof createTokenService>;
    let app: ReturnType<typeof createApp>;
    async function newUser() {
      const id = randomUUID();
      await database.db
        .insert(user)
        .values({ id, name: "DOM learner", email: `${id}@example.test` });
      return id;
    }
    const start = (
      userId: string,
      kind: "learning" | "review" | "practice" = "learning",
      framework: Framework = "vanilla",
    ) =>
      reviews.start(userId, {
        exerciseId,
        exerciseVersion,
        language: "javascript",
        framework,
        kind,
      });
    async function row(id: string) {
      return (
        await database.db.select().from(practiceSessions).where(eq(practiceSessions.id, id))
      )[0];
    }
    async function eventCount(id: string) {
      return (await database.db.select().from(reviewEvents).where(eq(reviewEvents.sessionId, id)))
        .length;
    }
    async function call(token: string, path: string, method = "GET", body?: unknown) {
      const response = await app.request(`${origin}/api/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    }
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: adminUrl });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(adminUrl as string);
      url.pathname = `/${databaseName}`;
      database = createDatabase(url.toString());
      await migrateDatabase(database);
      await migrateDatabase(database);
      catalog = createCatalogService(database);
      await catalog.publish();
      boss = await createQueue(url.toString());
      reviews = createReviewService(database, catalog, () => now);
      tokens = createTokenService(database);
      app = createApp({
        origin,
        catalog,
        reviews,
        tokens,
        auth: createAuth(database, {
          origin,
          secret: "dom-integration-only-secret-at-least-32-characters",
          registrationEnabled: false,
        }),
        submissions: createSubmissionService(database, boss, catalog),
        settings: createSettingsService(database),
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

    it("serves immutable public DOM detail/downloads and documents the shared HTTP contracts", async () => {
      const detailResponse = await app.request(`${origin}/api/v1/problems/${exerciseId}`);
      expect(detailResponse.status).toBe(200);
      const detail = exerciseDetailSchema.parse(await detailResponse.json());
      expect(isDomExercise(detail)).toBe(true);
      if (!isDomExercise(detail)) throw new Error("Expected a DOM exercise");
      expect(detail).toMatchObject({
        id: exerciseId,
        version: exerciseVersion,
        kind: "dom",
        assessment: "self",
        runtime: "browser",
      });
      expect(Object.hasOwn(detail, "referenceSolutions")).toBe(false);
      expect(Object.hasOwn(detail, "explanation")).toBe(false);
      const authored = getDomExercise(exerciseId, exerciseVersion);
      if (!authored) throw new Error("Missing authored DOM exercise");
      expect(detail).toEqual(authored.public);
      for (const variant of detail.variants) {
        const response = await app.request(
          `${origin}/api/v1/problems/${exerciseId}/download?language=javascript&framework=${variant.framework}&version=${exerciseVersion}`,
        );
        expect(response.status).toBe(200);
        const bundle = downloadSchema.parse(await response.json());
        const metadata = bundle.files[".bekor/exercise.json"];
        if (!metadata) throw new Error("Missing download manifest");
        expect(JSON.parse(metadata)).toEqual({
          exerciseId,
          exerciseVersion,
          kind: "dom",
          assessment: "self",
          runtime: "browser",
          apiOrigin: origin,
          variantId: variant.id,
          framework: variant.framework,
          language: variant.language,
          entry: variant.entry,
          files: Object.keys(variant.files),
          dependencies: variant.dependencies,
          compilerVersion: variant.compilerVersion,
        });
        expect(Object.keys(bundle.files).sort()).toEqual(
          [...Object.keys(variant.files), "README.md", ".bekor/exercise.json"].sort(),
        );
        for (const [path, starter] of Object.entries(variant.files))
          expect(bundle.files[path]).toBe(starter);
        const packed = JSON.stringify(bundle);
        expect(packed).not.toContain("referenceSolutions");
        expect(packed).not.toContain("privateTests");
        expect(packed).not.toContain(JSON.stringify(authored.explanation));
        for (const [path, source] of Object.entries(authored.referenceSolutions[variant.id] ?? {}))
          if (source !== variant.files[path]) expect(packed).not.toContain(JSON.stringify(source));
      }
      for (const path of [
        `/problems/${exerciseId}/download?language=typescript&framework=react`,
        `/problems/${exerciseId}/download?language=javascript`,
        "/problems/cumulative-sums/download?language=javascript&framework=react",
      ])
        expect((await app.request(`${origin}/api/v1${path}`)).status, path).toBe(400);
      const openApiResponse = await app.request(`${origin}/api/v1/openapi.json`);
      expect(openApiResponse.status).toBe(200);
      const specification = await openApiResponse.json();
      expect(specification.paths).toHaveProperty("/api/v1/me/self-assessments");
      const startProperties =
        specification.paths["/api/v1/practice-sessions"].post.requestBody.content[
          "application/json"
        ].schema.properties;
      expect(startProperties).toHaveProperty("framework");
      expect(startProperties).toHaveProperty("requestId");
      const completionProperties =
        specification.paths["/api/v1/practice-sessions/{id}/complete"].post.requestBody.content[
          "application/json"
        ].schema.properties;
      expect(completionProperties.selfAssessment.enum).toEqual(["solved", "unable"]);
      expect(completionProperties).toHaveProperty("rating");
      const before = await database.db
        .select()
        .from(exerciseVersions)
        .where(eq(exerciseVersions.exerciseId, exerciseId));
      await catalog.publish();
      expect(
        await database.db
          .select()
          .from(exerciseVersions)
          .where(eq(exerciseVersions.exerciseId, exerciseId)),
      ).toEqual(before);
      expect(
        exerciseDetailSchema.parse(
          await (await app.request(`${origin}/api/v1/problems/${exerciseId}`)).json(),
        ),
      ).toEqual(detail);
    });

    it("upgrades existing Node rows without changing card state, identity, evidence or completion JSON", async () => {
      const upgradeName = `bekor_upgrade_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE DATABASE "${upgradeName}"`);
      const url = new URL(adminUrl as string);
      url.pathname = `/${upgradeName}`;
      const upgrade = new pg.Pool({ connectionString: url.toString() });
      try {
        await upgrade.query(
          readFileSync(
            new URL("../../../packages/db/migrations/0000_flashy_cammi.sql", import.meta.url),
            "utf8",
          ),
        );
        const uid = randomUUID(),
          sid = randomUUID(),
          cid = randomUUID();
        const previous = schedule(null, "good", now);
        const snapshot = {
          session: {
            id: sid,
            exerciseId: "old-node",
            exerciseVersion,
            language: "javascript",
            kind: "learning",
            status: "completed",
            createdAt: now.toISOString(),
            completedAt: now.toISOString(),
            rating: "good",
            solutionRevealed: false,
            hintUsed: false,
          },
          card: null,
        };
        await upgrade.query("INSERT INTO auth_user(id,name,email) VALUES ($1,'Old learner',$2)", [
          uid,
          `${uid}@example.test`,
        ]);
        await upgrade.query("INSERT INTO problems(id,slug) VALUES ('old-node','old-node')");
        await upgrade.query(
          "INSERT INTO practice_sessions(id,user_id,exercise_id,exercise_version,language,kind,status,rating,completion) VALUES ($1,$2,'old-node',$3,'javascript','learning','completed','good',$4)",
          [sid, uid, exerciseVersion, snapshot],
        );
        await upgrade.query(
          "INSERT INTO review_cards(id,user_id,exercise_id,language,state,due_at,scheduler_version,configuration) VALUES ($1,$2,'old-node','javascript',$3,$4,$5,$6)",
          [
            cid,
            uid,
            previous.state,
            previous.due,
            previous.schedulerVersion,
            previous.configuration,
          ],
        );
        const beforeSession = (
          await upgrade.query("SELECT * FROM practice_sessions WHERE id=$1", [sid])
        ).rows[0];
        const beforeCard = (await upgrade.query("SELECT * FROM review_cards WHERE id=$1", [cid]))
          .rows[0];
        await upgrade.query(
          readFileSync(
            new URL(
              "../../../packages/db/migrations/0001_dry_radioactive_man.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        expect(
          (await upgrade.query("SELECT * FROM practice_sessions WHERE id=$1", [sid])).rows[0],
        ).toEqual({ ...beforeSession, framework: "node", assessment: null });
        expect(
          (await upgrade.query("SELECT * FROM review_cards WHERE id=$1", [cid])).rows[0],
        ).toEqual({ ...beforeCard, framework: "node" });
        await expect(
          upgrade.query(
            "INSERT INTO review_cards(id,user_id,exercise_id,language,state,due_at,scheduler_version,configuration) SELECT $1,user_id,exercise_id,language,state,due_at,scheduler_version,configuration FROM review_cards WHERE id=$2",
            [randomUUID(), cid],
          ),
        ).rejects.toMatchObject({ code: "23505" });
      } finally {
        await upgrade.end();
        await admin.query(`DROP DATABASE IF EXISTS "${upgradeName}" WITH (FORCE)`);
      }
    });

    it("validates published version and exact variant before creating a session", async () => {
      const uid = await newUser();
      await expect(
        reviews.start(uid, {
          exerciseId,
          exerciseVersion,
          language: "javascript",
          kind: "learning",
        }),
      ).rejects.toMatchObject({ code: "INVALID_VARIANT" });
      await expect(
        reviews.start(uid, {
          exerciseId,
          exerciseVersion,
          language: "typescript",
          framework: "react",
          kind: "learning",
        }),
      ).rejects.toMatchObject({ code: "INVALID_VARIANT" });
      await expect(
        reviews.start(uid, {
          exerciseId: "cumulative-sums",
          exerciseVersion,
          language: "javascript",
          framework: "react",
          kind: "learning",
        }),
      ).rejects.toMatchObject({ code: "INVALID_VARIANT" });
      await expect(
        reviews.start(uid, {
          exerciseId,
          exerciseVersion: "missing",
          language: "javascript",
          framework: "react",
          kind: "learning",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await database.db
        .update(exerciseVersions)
        .set({ status: "retired" })
        .where(eq(exerciseVersions.exerciseId, exerciseId));
      try {
        await expect(start(uid)).rejects.toMatchObject({ code: "VERSION_RETIRED" });
      } finally {
        await database.db
          .update(exerciseVersions)
          .set({ status: "published" })
          .where(eq(exerciseVersions.exerciseId, exerciseId));
      }
      expect(
        await database.db.select().from(practiceSessions).where(eq(practiceSessions.userId, uid)),
      ).toEqual([]);
    });

    it("resumes concurrent starts and keeps all four framework sessions/cards independent", async () => {
      const uid = await newUser();
      const concurrent = await Promise.all(Array.from({ length: 12 }, () => start(uid)));
      expect(new Set(concurrent.map((session) => session.id)).size).toBe(1);
      for (const framework of ["vanilla", "react", "vue", "svelte"] as const) {
        const session = await start(uid, "learning", framework);
        const completion = await reviews.complete(uid, session.id, "good", "solved");
        expect(completion.card?.framework).toBe(framework);
      }
      const cards = await database.db.select().from(reviewCards).where(eq(reviewCards.userId, uid));
      expect(cards).toHaveLength(4);
      expect(new Set(cards.map((card) => card.framework)).size).toBe(4);
      const before = cards.find((card) => card.framework === "vanilla");
      const reactReview = await start(uid, "review", "react");
      await reviews.complete(uid, reactReview.id, "again", "unable");
      expect(
        (
          await database.db
            .select()
            .from(reviewCards)
            .where(and(eq(reviewCards.userId, uid), eq(reviewCards.framework, "vanilla")))
        )[0],
      ).toEqual(before);
      expect((await reviews.queue(uid)).due.every((card) => card.framework !== undefined)).toBe(
        true,
      );
    });

    it("replays a stable practice start after a lost response and after completion", async () => {
      const uid = await newUser();
      const request = {
        exerciseId,
        exerciseVersion,
        framework: "react" as const,
        language: "javascript" as const,
        kind: "practice" as const,
        requestId: randomUUID(),
      };
      const committed = await reviews.start(uid, request); // Original response may be lost.
      const replay = await reviews.start(uid, request);
      expect(replay).toEqual(committed);
      expect(committed.id).toBe(request.requestId);
      const completion = await reviews.complete(uid, replay.id, undefined, "solved");
      const completedReplay = await reviews.start(uid, request);
      expect(completedReplay).toEqual(completion.session);
      expect(await reviews.complete(uid, completedReplay.id, undefined, "solved")).toEqual(
        completion,
      );
      expect(
        await database.db.select().from(practiceSessions).where(eq(practiceSessions.userId, uid)),
      ).toHaveLength(1);
      expect(await eventCount(committed.id)).toBe(0);
    });

    it("uses one row for concurrent stable starts and rejects changed payload/ownership", async () => {
      const uid = await newUser();
      const request = {
        exerciseId,
        exerciseVersion,
        framework: "vanilla" as const,
        language: "javascript" as const,
        kind: "practice" as const,
        requestId: randomUUID(),
      };
      const concurrent = await Promise.all(
        Array.from({ length: 12 }, () => reviews.start(uid, request)),
      );
      expect(new Set(concurrent.map((session) => session.id))).toEqual(
        new Set([request.requestId]),
      );
      for (const change of [
        { exerciseId: "cumulative-sums" },
        { exerciseVersion: "different-version" },
        { framework: "react" as const },
        { language: "typescript" as const },
        { kind: "learning" as const },
      ])
        await expect(reviews.start(uid, { ...request, ...change })).rejects.toMatchObject({
          code: "SESSION_START_CONFLICT",
          status: 409,
        });
      const stranger = await newUser();
      await expect(reviews.start(stranger, request)).rejects.toMatchObject({
        code: "SESSION_START_CONFLICT",
        status: 409,
      });
      expect(
        await database.db
          .select()
          .from(practiceSessions)
          .where(eq(practiceSessions.userId, stranger)),
      ).toEqual([]);
      expect(
        await database.db.select().from(practiceSessions).where(eq(practiceSessions.userId, uid)),
      ).toHaveLength(1);
      const sharedId = randomUUID();
      const race = await Promise.allSettled([
        reviews.start(uid, { ...request, requestId: sharedId }),
        reviews.start(stranger, { ...request, requestId: sharedId }),
      ]);
      expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failure = race.find((result) => result.status === "rejected");
      expect(failure?.status === "rejected" ? failure.reason : undefined).toMatchObject({
        code: "SESSION_START_CONFLICT",
        status: 409,
      });
    });

    it("atomically persists explicit evidence and one FSRS event through concurrent identical retries", async () => {
      const uid = await newUser();
      const session = await start(uid);
      const jobsBefore = (await database.pool.query("select count(*)::int n from pgboss.job"))
        .rows[0].n;
      const results = await Promise.all(
        Array.from({ length: 12 }, () => reviews.complete(uid, session.id, "easy", "solved")),
      );
      expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
        true,
      );
      expect(results[0]?.session.assessment).toEqual({
        outcome: "solved",
        provenance: "self",
        assessedAt: now.toISOString(),
      });
      expect(await eventCount(session.id)).toBe(1);
      expect((await row(session.id))?.assessment).toEqual(results[0]?.session.assessment);
      expect(
        await database.db.select().from(submissions).where(eq(submissions.userId, uid)),
      ).toEqual([]);
      expect((await database.pool.query("select count(*)::int n from pgboss.job")).rows[0].n).toBe(
        jobsBefore,
      );
      await expect(reviews.complete(uid, session.id, "easy", "unable")).rejects.toMatchObject({
        code: "ASSESSMENT_CONFLICT",
      });
      await expect(reviews.complete(uid, session.id, "good", "solved")).rejects.toMatchObject({
        code: "RATING_CONFLICT",
      });
      expect(await eventCount(session.id)).toBe(1);
    });

    it("serializes conflicting concurrent completions and rolls back scheduling failures", async () => {
      const uid = await newUser();
      const session = await start(uid);
      const results = await Promise.allSettled([
        reviews.complete(uid, session.id, "good", "solved"),
        reviews.complete(uid, session.id, "easy", "solved"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await eventCount(session.id)).toBe(1);
      const review = await start(uid, "review");
      await database.db
        .update(reviewCards)
        .set({ schedulerVersion: "unsupported" })
        .where(eq(reviewCards.userId, uid));
      await expect(reviews.complete(uid, review.id, "good", "solved")).rejects.toMatchObject({
        code: "SCHEDULER_VERSION_UNSUPPORTED",
      });
      expect(await row(review.id)).toMatchObject({
        status: "active",
        assessment: null,
        completion: null,
        completedAt: null,
      });
      expect(await eventCount(review.id)).toBe(0);
    });

    it("rejects a retired DOM version at completion while preserving completed retries", async () => {
      const uid = await newUser();
      const first = await start(uid, "practice");
      const completion = await reviews.complete(uid, first.id, undefined, "solved");
      const active = await start(uid);
      await database.db
        .update(exerciseVersions)
        .set({ status: "retired" })
        .where(eq(exerciseVersions.exerciseId, exerciseId));
      try {
        await expect(reviews.complete(uid, active.id, "good", "solved")).rejects.toMatchObject({
          code: "VERSION_RETIRED",
        });
        expect(await reviews.complete(uid, first.id, undefined, "solved")).toEqual(completion);
        expect(await row(active.id)).toMatchObject({ status: "active", assessment: null });
      } finally {
        await database.db
          .update(exerciseVersions)
          .set({ status: "published" })
          .where(eq(exerciseVersions.exerciseId, exerciseId));
      }
    });

    it("rejects absent/unsolved initial evidence and rolls back all completion state", async () => {
      const uid = await newUser();
      const session = await start(uid);
      for (const evidence of [undefined, "unable"] as const)
        await expect(reviews.complete(uid, session.id, "again", evidence)).rejects.toMatchObject({
          code: "INVALID_RATING_EVIDENCE",
        });
      await expect(reviews.complete(uid, session.id, undefined, "solved")).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(await row(session.id)).toMatchObject({
        status: "active",
        assessment: null,
        completion: null,
        rating: null,
        revision: 0,
      });
      expect(await eventCount(session.id)).toBe(0);
      expect(
        await database.db.select().from(reviewCards).where(eq(reviewCards.userId, uid)),
      ).toEqual([]);
    });

    it("supports unable/Again reviews, restricts reveal/help and records hints without forcing Again", async () => {
      const uid = await newUser();
      const initial = await start(uid);
      await reviews.assistance(uid, initial.id, "hint");
      const enrolled = await reviews.complete(uid, initial.id, "good", "solved");
      expect(enrolled.session.hintUsed).toBe(true);
      const unable = await start(uid, "review");
      await expect(reviews.complete(uid, unable.id, "hard", "unable")).rejects.toMatchObject({
        code: "INVALID_RATING_EVIDENCE",
      });
      await reviews.complete(uid, unable.id, "again", "unable");
      const revealed = await start(uid, "review");
      const reference = await reviews.reveal(uid, revealed.id);
      expect(reference.files).toBeDefined();
      expect(reference.session.solutionRevealed).toBe(true);
      expect(await reviews.reveal(uid, revealed.id)).toEqual(reference);
      await expect(reviews.complete(uid, revealed.id, "good", "solved")).rejects.toMatchObject({
        code: "INVALID_RATING_EVIDENCE",
      });
      await expect(reviews.complete(uid, revealed.id, "again")).rejects.toMatchObject({
        code: "INVALID_RATING_EVIDENCE",
      });
      await reviews.complete(uid, revealed.id, "again", "unable");
      const helped = await start(uid, "review");
      await reviews.assistance(uid, helped.id, "external_help");
      await expect(reviews.complete(uid, helped.id, "easy", "solved")).rejects.toMatchObject({
        code: "INVALID_RATING_EVIDENCE",
      });
      await reviews.complete(uid, helped.id, "again", "solved");
    });

    it("marks free practice solved without scheduling, and exposes owner-only self-assessed history", async () => {
      const uid = await newUser();
      const initial = await start(uid);
      await reviews.complete(uid, initial.id, "good", "solved");
      const before = await database.db
        .select()
        .from(reviewCards)
        .where(eq(reviewCards.userId, uid));
      const practice = await start(uid, "practice");
      const completion = await reviews.complete(uid, practice.id, undefined, "solved");
      expect(completion).toMatchObject({
        card: null,
        session: { rating: null, assessment: { outcome: "solved", provenance: "self" } },
      });
      expect(await eventCount(practice.id)).toBe(0);
      expect(
        await database.db.select().from(reviewCards).where(eq(reviewCards.userId, uid)),
      ).toEqual(before);
      expect(await reviews.complete(uid, practice.id, undefined, "solved")).toEqual(completion);
      expect((await reviews.history(uid)).items).toHaveLength(2);
      expect((await reviews.history(await newUser())).items).toEqual([]);
      const token = (
        await tokens.create(uid, { name: "read", scopes: ["reviews:read"], expiresInDays: 1 })
      ).token;
      expect((await call(token, "/me/self-assessments")).body.items).toHaveLength(2);
    });

    it("keeps completion/reveal owner-only and enforces token write scope through HTTP", async () => {
      const uid = await newUser();
      const session = await start(uid);
      const foreign = await newUser();
      const foreignToken = (
        await tokens.create(foreign, { name: "write", scopes: ["reviews:write"], expiresInDays: 1 })
      ).token;
      expect(
        (
          await call(foreignToken, `/practice-sessions/${session.id}/complete`, "POST", {
            rating: "good",
            selfAssessment: "solved",
          })
        ).status,
      ).toBe(404);
      expect(
        (await call(foreignToken, `/practice-sessions/${session.id}/reveal`, "POST", {})).status,
      ).toBe(404);
      const readOnly = (
        await tokens.create(uid, { name: "read", scopes: ["reviews:read"], expiresInDays: 1 })
      ).token;
      expect(
        (
          await call(readOnly, `/practice-sessions/${session.id}/complete`, "POST", {
            rating: "good",
            selfAssessment: "solved",
          })
        ).status,
      ).toBe(403);
      const write = (
        await tokens.create(uid, { name: "write", scopes: ["reviews:write"], expiresInDays: 1 })
      ).token;
      const result = await call(write, `/practice-sessions/${session.id}/complete`, "POST", {
        rating: "good",
        selfAssessment: "solved",
      });
      expect(result.status).toBe(200);
      expect(result.body.session.assessment.provenance).toBe("self");
      expect(
        (
          await call(write, `/practice-sessions/${session.id}/complete`, "POST", {
            rating: "good",
            selfAssessment: "solved",
            files: { "main.js": "never executed" },
          })
        ).status,
      ).toBe(400);
    });

    it("preserves Node accepted-submit requirements and rejects browser submissions before queueing", async () => {
      const uid = await newUser();
      const node = await reviews.start(uid, {
        exerciseId: "cumulative-sums",
        exerciseVersion,
        language: "javascript",
        kind: "learning",
      });
      await expect(reviews.complete(uid, node.id, "good", "solved")).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(reviews.complete(uid, node.id, "good")).rejects.toMatchObject({
        code: "INVALID_RATING_EVIDENCE",
      });
      const token = (
        await tokens.create(uid, {
          name: "submit",
          scopes: ["submissions:write"],
          expiresInDays: 1,
        })
      ).token;
      const response = await call(token, "/submissions", "POST", {
        exerciseId,
        exerciseVersion,
        language: "javascript",
        mode: "submit",
        idempotencyKey: randomUUID(),
        files: { "solution.js": "never executed" },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("SELF_ASSESSED_EXERCISE");
      expect(
        await database.db.select().from(submissions).where(eq(submissions.userId, uid)),
      ).toEqual([]);
    });

    it("uses the same manual rating acceptance as the exported rule for every review outcome and assistance state", async () => {
      for (const revealed of [false, true]) {
        for (const outcome of [undefined, "solved", "unable"] as const) {
          for (const rating of ["again", "hard", "good", "easy"] as Rating[]) {
            const uid = await newUser();
            const initial = await start(uid);
            await reviews.complete(uid, initial.id, "good", "solved");
            const session = await start(uid, "review");
            if (revealed) await reviews.assistance(uid, session.id, "external_help");
            const expected = domCompletionViolation(
              {
                kind: "review",
                enrolled: true,
                selfAssessment: outcome,
                solutionRevealed: revealed,
              },
              rating,
            );
            const result = await reviews.complete(uid, session.id, rating, outcome).then(
              () => true,
              () => false,
            );
            expect(result, JSON.stringify({ revealed, outcome, rating })).toBe(expected === null);
          }
        }
      }
    });
  },
);
