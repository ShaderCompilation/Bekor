import { randomUUID } from "node:crypto";
import type { ProblemListQuery, SubmissionCreate } from "@bekor/contracts";
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
import {
  createDatabase,
  exerciseVersions,
  practiceSessions,
  submissions,
  user,
} from "../../../packages/db/src/index.js";
import { migrateDatabase } from "../../../packages/db/src/migrate.js";
import { listExercises } from "../../../packages/exercises/src/index.js";
import { createAuth } from "../src/auth.js";
import { createApp } from "../src/index.js";

const adminUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!adminUrl)(
  "real PostgreSQL + Better Auth + pg-boss backend (no runner execution)",
  () => {
    const databaseName = `bekor_it_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool;
    let database: ReturnType<typeof createDatabase>;
    let boss: Awaited<ReturnType<typeof createQueue>>;
    let catalog: ReturnType<typeof createCatalogService>;
    let service: ReturnType<typeof createSubmissionService>;
    let tokens: ReturnType<typeof createTokenService>;
    let app: ReturnType<typeof createApp>;
    const origin = "http://localhost:3000";
    let cookie = "";
    let authUserId = "";
    async function newUser() {
      const id = randomUUID();
      await database.db.insert(user).values({ id, name: "Test", email: `${id}@example.test` });
      return id;
    }
    const input = (key = randomUUID()): SubmissionCreate => ({
      exerciseId: "cumulative-sums",
      exerciseVersion: "1.0.0",
      language: "javascript",
      files: { "solution.js": "export function cumulativeSums(xs) { return xs; }" },
      mode: "submit",
      idempotencyKey: key,
    });
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: adminUrl });
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(adminUrl as string);
      url.pathname = `/${databaseName}`;
      database = createDatabase(url.toString());
      await migrateDatabase(database);
      await migrateDatabase(database);
      boss = await createQueue(url.toString());
      catalog = createCatalogService(database);
      await catalog.publish();
      service = createSubmissionService(database, boss, catalog);
      tokens = createTokenService(database);
      const auth = createAuth(database, {
        origin,
        secret: "integration-only-secret-32-characters-minimum",
        registrationEnabled: true,
      });
      app = createApp({
        origin,
        auth,
        catalog,
        submissions: service,
        tokens,
        settings: createSettingsService(database),
        reviews: createReviewService(database, catalog),
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
    it("migrates cleanly twice and preserves immutable publication", async () => {
      expect(
        (await database.pool.query("select count(*)::int count from drizzle.__drizzle_migrations"))
          .rows[0].count,
      ).toBeGreaterThan(0);
      await catalog.publish();
      const published: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await catalog.list({ limit: 7, ...(cursor ? { cursor } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(7);
        published.push(...page.items.map((item) => item.id));
        expect(new Set(published).size).toBe(published.length);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(published.sort()).toEqual(
        listExercises()
          .map((item) => item.public.id)
          .sort(),
      );
      const downloaded = await catalog.download("cumulative-sums", "typescript", origin, "1.0.0");
      expect(Object.keys(downloaded.files)).toContain("solution.ts");
      expect(JSON.stringify(downloaded)).not.toContain("referenceSolutions");
      const first = await catalog.list({ limit: 1 });
      const second = await catalog.list({ limit: 1, cursor: first.nextCursor as string });
      expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
      expect(Object.keys(first.items[0] ?? {}).sort()).toEqual(
        ["concepts", "difficulty", "id", "slug", "title", "version"].sort(),
      );
    });
    it("filters the catalog on the server before paging", async () => {
      await catalog.publish();
      const all = listExercises().map((item) => item.public);
      const collect = async (filters: Omit<ProblemListQuery, "limit">) => {
        const slugs: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await catalog.list({ ...filters, limit: 9, ...(cursor ? { cursor } : {}) });
          slugs.push(...page.items.map((item) => item.slug));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return slugs;
      };
      const expected = (keep: (item: (typeof all)[number]) => boolean) =>
        all
          .filter(keep)
          .map((item) => item.slug)
          .sort();
      expect(await collect({ difficulty: "hard" })).toEqual(
        expected((item) => item.difficulty === "hard"),
      );
      const concept = all[0]?.concepts[0] as string;
      expect(await collect({ concept })).toEqual(
        expected((item) => item.concepts.includes(concept)),
      );
      expect(await collect({ q: "WORD", difficulty: "easy" })).toEqual(
        expected(
          (item) =>
            item.difficulty === "easy" &&
            `${item.title}\n${item.description}`.toLowerCase().includes("word"),
        ),
      );
      const ids = all.slice(0, 3).map((item) => item.id);
      expect(
        (await catalog.list({ ids: [...ids, "missing-id"], limit: 100 })).items
          .map((item) => item.id)
          .sort(),
      ).toEqual([...ids].sort());
      const http = await app.request(
        `${origin}/api/v1/problems?difficulty=easy&limit=2&ids=${ids.join(",")}`,
      );
      expect(http.status).toBe(200);
      const body = (await http.json()) as { items: { id: string; difficulty: string }[] };
      expect(body.items.length).toBeLessThanOrEqual(2);
      expect(body.items.every((item) => ids.includes(item.id) && item.difficulty === "easy")).toBe(
        true,
      );
      expect((await app.request(`${origin}/api/v1/problems?difficulty=impossible`)).status).toBe(
        400,
      );
      expect((await app.request(`${origin}/api/v1/concepts`)).status).toBe(200);
      expect((await catalog.concepts()).items).toEqual(
        [...new Set(all.flatMap((item) => item.concepts))].sort(),
      );
    });
    it("atomically enqueues concurrent idempotent submissions and rejects key reuse", async () => {
      const id = await newUser();
      const request = input();
      const [a, b] = await Promise.all([service.create(id, request), service.create(id, request)]);
      expect(a.id).toBe(b.id);
      expect(
        (
          await database.pool.query(
            "select count(*)::int count from pgboss.job where data->>'submissionId'=$1",
            [a.id],
          )
        ).rows[0].count,
      ).toBe(1);
      await expect(service.create(id, { ...request, mode: "run" })).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });
      await expect(service.get(await newUser(), a.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it("rolls back submission AND inserted queue job if enqueue transaction fails", async () => {
      const id = await newUser();
      let queuedId = "";
      const failing = createSubmissionService(
        database,
        {
          send: async (...args: Parameters<typeof boss.send>) => {
            queuedId = (await boss.send(...args)) ?? "";
            throw new Error("Injected failure after queue INSERT");
          },
        },
        catalog,
      );
      await expect(failing.create(id, input())).rejects.toThrow("Injected failure");
      expect(
        await database.db.select().from(submissions).where(eq(submissions.userId, id)),
      ).toHaveLength(0);
      expect(
        (
          await database.pool.query("select count(*)::int count from pgboss.job where id=$1", [
            queuedId,
          ])
        ).rows[0].count,
      ).toBe(0);
    });
    it("rejects illegal filenames before enqueue and serializes active-user quota", async () => {
      const id = await newUser();
      await expect(
        service.create(id, { ...input(), files: { "../secret": "bad" } }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const result = await Promise.allSettled(
        Array.from({ length: 4 }, () => service.create(id, input())),
      );
      expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
    });
    it("validates session owner, version/language, and completed state", async () => {
      const id = await newUser();
      const sessionId = randomUUID();
      await database.db.insert(practiceSessions).values({
        id: sessionId,
        userId: id,
        exerciseId: "cumulative-sums",
        exerciseVersion: "1.0.0",
        language: "typescript",
        kind: "learning",
      });
      await expect(
        service.create(await newUser(), { ...input(), practiceSessionId: sessionId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        service.create(id, { ...input(), practiceSessionId: sessionId }),
      ).rejects.toMatchObject({ code: "SESSION_MISMATCH" });
      await expect(
        database.db.insert(practiceSessions).values({
          id: randomUUID(),
          userId: id,
          exerciseId: "cumulative-sums",
          exerciseVersion: "1.0.0",
          language: "typescript",
          kind: "review",
        }),
      ).rejects.toThrow();
    });
    it("supports real cookie signup, persisted session and browser-only token creation", async () => {
      const response = await app.request(`${origin}/auth/sign-up/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          name: "Auth User",
          email: "auth@example.test",
          password: "a-secure-test-password-123",
        }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      cookie = response.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
      expect(cookie).toContain("session_token");
      const data = await response.json();
      authUserId = data.user.id;
      const missingOrigin = await app.request(`${origin}/api/v1/me/tokens`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "CLI", scopes: ["submissions:read"], expiresInDays: 1 }),
      });
      expect(missingOrigin.status).toBe(403);
      const valid = await app.request(`${origin}/api/v1/me/tokens`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "CLI", scopes: ["submissions:read"], expiresInDays: 1 }),
      });
      expect(valid.status).toBe(201);
      const token = await valid.json();
      expect(token.token).toMatch(/^bk_/);
      const read = await app.request(`${origin}/api/v1/me/submissions`, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      expect(read.status).toBe(200);
      const denied = await app.request(`${origin}/api/v1/me/tokens`, {
        headers: { Authorization: `Bearer ${token.token}` },
      });
      expect(denied.status).toBe(403);
      const deniedWrite = await app.request(`${origin}/api/v1/submissions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(input()),
      });
      expect(deniedWrite.status).toBe(403);
      await tokens.revoke(authUserId, token.credential.id);
      expect(await tokens.authenticate(token.token)).toBeNull();
      const [first] = (await tokens.list(authUserId)).items.filter(
        (item) => item.id === token.credential.id,
      );
      await tokens.revoke(authUserId, token.credential.id);
      const [again] = (await tokens.list(authUserId)).items.filter(
        (item) => item.id === token.credential.id,
      );
      expect(again?.revokedAt).toBe(first?.revokedAt);
    });
    it("enforces token expiry, stores only hash and hides other owners credentials", async () => {
      const id = await newUser();
      const created = await tokens.create(id, {
        name: "Temporary",
        scopes: ["reviews:read"],
        expiresInDays: 1,
      });
      expect(
        (
          await database.pool.query("select hash from cli_tokens where id=$1", [
            created.credential.id,
          ])
        ).rows[0].hash,
      ).not.toBe(created.token);
      await expect(tokens.revoke(await newUser(), created.credential.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const future = createTokenService(database, () => new Date(Date.now() + 2 * 86400000));
      expect(await future.authenticate(created.token)).toBeNull();
    });
    it("throttles repeated failed sign-ins", async () => {
      const attempt = () =>
        app.request(`${origin}/auth/sign-in/email`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify({ email: "nobody@example.test", password: "wrong-password-123" }),
        });
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await attempt()).status);
      expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });
    it("returns stable API errors, enforces payload bound and generates OpenAPI", async () => {
      const unauth = await app.request(`${origin}/api/v1/me/submissions`);
      expect(unauth.status).toBe(401);
      expect((await unauth.json()).error.requestId).toBe(unauth.headers.get("x-request-id"));
      const invalid = await app.request(`${origin}/api/v1/submissions`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: "{bad",
      });
      expect(invalid.status).toBe(400);
      const huge = await app.request(`${origin}/api/v1/submissions`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ source: "x".repeat(100001) }),
      });
      expect(huge.status).toBe(413);
      const spec = await app.request(`${origin}/api/v1/openapi.json`);
      expect(spec.status, await spec.clone().text()).toBe(200);
      expect((await spec.json()).paths["/api/v1/submissions"]).toBeDefined();
    });
    it("rejects retired exercise versions and preserves owner-only paginated history", async () => {
      const id = await newUser();
      await service.create(id, input());
      await service.create(id, input());
      const first = await service.history(id, { limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      const second = await service.history(id, { limit: 1, cursor: first.nextCursor as string });
      expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
      await database.db
        .update(exerciseVersions)
        .set({ status: "retired" })
        .where(
          and(
            eq(exerciseVersions.exerciseId, "cumulative-sums"),
            eq(exerciseVersions.version, "1.0.0"),
          ),
        );
      await expect(service.create(id, input())).rejects.toMatchObject({ code: "VERSION_RETIRED" });
      await database.db
        .update(exerciseVersions)
        .set({ status: "published" })
        .where(eq(exerciseVersions.exerciseId, "cumulative-sums"));
    });
  },
);
