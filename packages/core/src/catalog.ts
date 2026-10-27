import type { Language, Pagination } from "@bekor/contracts";
import { type Database, exerciseVersions, problems } from "@bekor/db";
import {
  contentHash,
  createDownload,
  getExercise,
  listExercises,
  toPublicExercise,
} from "@bekor/exercises";
import { and, asc, desc, eq, exists, gt } from "drizzle-orm";
import { ServiceError } from "./errors.js";

export function createCatalogService(database: Database) {
  async function resolve(exerciseId: string, version: string) {
    const [row] = await database.db
      .select()
      .from(exerciseVersions)
      .where(
        and(eq(exerciseVersions.exerciseId, exerciseId), eq(exerciseVersions.version, version)),
      );
    if (!row) throw new ServiceError("NOT_FOUND", "Exercise version not found.", 404);
    if (row.status === "retired")
      throw new ServiceError(
        "VERSION_RETIRED",
        "This version was retired. Download a current exercise version.",
        410,
      );
    const exercise = getExercise(exerciseId, version);
    if (!exercise || contentHash(exercise) !== row.contentHash)
      throw new ServiceError(
        "CONTENT_UNAVAILABLE",
        "Published exercise content is unavailable.",
        503,
      );
    return exercise;
  }
  return {
    resolve,
    async publish() {
      for (const exercise of listExercises()) {
        await database.db.transaction(async (tx) => {
          const { id, slug, version } = exercise.public;
          await tx.insert(problems).values({ id, slug }).onConflictDoNothing();
          await tx
            .insert(exerciseVersions)
            .values({ exerciseId: id, version, contentHash: contentHash(exercise) })
            .onConflictDoNothing();
          const [stored] = await tx
            .select()
            .from(exerciseVersions)
            .where(and(eq(exerciseVersions.exerciseId, id), eq(exerciseVersions.version, version)));
          if (stored?.contentHash !== contentHash(exercise))
            throw new Error(`Published content changed: ${id}@${version}`);
        });
      }
    },
    async list(page: Pagination) {
      if (page.cursor && !/^[a-z][a-z0-9-]{0,79}$/.test(page.cursor))
        throw new ServiceError("INVALID_CURSOR", "Invalid catalog cursor.");
      const rows = await database.db
        .select()
        .from(problems)
        .where(
          and(
            page.cursor ? gt(problems.slug, page.cursor) : undefined,
            exists(
              database.db
                .select({ id: exerciseVersions.exerciseId })
                .from(exerciseVersions)
                .where(
                  and(
                    eq(exerciseVersions.exerciseId, problems.id),
                    eq(exerciseVersions.status, "published"),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(problems.slug))
        .limit(page.limit + 1);
      const items = [];
      for (const row of rows) {
        const versions = await database.db
          .select()
          .from(exerciseVersions)
          .where(
            and(eq(exerciseVersions.exerciseId, row.id), eq(exerciseVersions.status, "published")),
          )
          .orderBy(desc(exerciseVersions.publishedAt), desc(exerciseVersions.version))
          .limit(1);
        const latest = versions[0];
        if (latest) items.push(toPublicExercise(await resolve(row.id, latest.version)));
        if (items.length > page.limit) break;
      }
      const more = items.length > page.limit;
      if (more) items.pop();
      return { items, nextCursor: more ? (items.at(-1)?.slug ?? null) : null };
    },
    async detail(slug: string, version?: string) {
      const [problem] = await database.db.select().from(problems).where(eq(problems.slug, slug));
      if (!problem) throw new ServiceError("NOT_FOUND", "Problem not found.", 404);
      let selected = version;
      if (!selected) {
        const versions = await database.db
          .select()
          .from(exerciseVersions)
          .where(
            and(
              eq(exerciseVersions.exerciseId, problem.id),
              eq(exerciseVersions.status, "published"),
            ),
          )
          .orderBy(desc(exerciseVersions.publishedAt), desc(exerciseVersions.version))
          .limit(1);
        selected = versions[0]?.version;
      }
      if (!selected) throw new ServiceError("NOT_FOUND", "Published version not found.", 404);
      return toPublicExercise(await resolve(problem.id, selected));
    },
    async download(slug: string, language: Language, origin: string, version?: string) {
      const detail = await this.detail(slug, version);
      return createDownload(await resolve(detail.id, detail.version), language, origin);
    },
  };
}
export type CatalogService = ReturnType<typeof createCatalogService>;
