import type { Language, ProblemListQuery, ProblemSummary } from "@bekor/contracts";

interface CatalogEntry {
  summary: ProblemSummary;
  /** Lower-cased title and description for search. */
  search: string;
}

import { type Database, exerciseVersions, problems } from "@bekor/db";
import {
  contentHash,
  createDownload,
  getExercise,
  listExercises,
  toPublicExercise,
} from "@bekor/exercises";
import { and, asc, desc, eq } from "drizzle-orm";
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
  // Published content is immutable per id@version, so its verified summary is cached.
  const summaries = new Map<string, CatalogEntry>();
  function entry(exerciseId: string, version: string, hash: string): CatalogEntry {
    const key = `${exerciseId}@${version}`;
    let cached = summaries.get(key);
    if (!cached) {
      const exercise = getExercise(exerciseId, version);
      if (!exercise || contentHash(exercise) !== hash)
        throw new ServiceError(
          "CONTENT_UNAVAILABLE",
          "Published exercise content is unavailable.",
          503,
        );
      const { id, slug, title, difficulty, concepts, description } = exercise.public;
      cached = {
        summary: { id, slug, version, title, difficulty, concepts },
        search: `${title}\n${description}`.toLowerCase(),
      };
      summaries.set(key, cached);
    }
    return cached;
  }
  /** Latest published version of every problem, ordered by slug, in one query. */
  async function published() {
    const rows = await database.db
      .selectDistinctOn([problems.slug], {
        slug: problems.slug,
        exerciseId: exerciseVersions.exerciseId,
        version: exerciseVersions.version,
        contentHash: exerciseVersions.contentHash,
      })
      .from(problems)
      .innerJoin(exerciseVersions, eq(exerciseVersions.exerciseId, problems.id))
      .where(eq(exerciseVersions.status, "published"))
      .orderBy(
        asc(problems.slug),
        desc(exerciseVersions.publishedAt),
        desc(exerciseVersions.version),
      );
    return rows.map((row) => entry(row.exerciseId, row.version, row.contentHash));
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
    async list(query: ProblemListQuery) {
      if (query.cursor && !/^[a-z][a-z0-9-]{0,79}$/.test(query.cursor))
        throw new ServiceError("INVALID_CURSOR", "Invalid catalog cursor.");
      const ids = query.ids && new Set(query.ids);
      const text = query.q?.toLowerCase();
      const items: ProblemSummary[] = [];
      for (const { summary, search } of await published()) {
        if (query.cursor && summary.slug <= query.cursor) continue;
        if (ids && !ids.has(summary.id)) continue;
        if (query.difficulty && summary.difficulty !== query.difficulty) continue;
        if (query.concept && !summary.concepts.includes(query.concept)) continue;
        if (text && !search.includes(text)) continue;
        items.push(summary);
        if (items.length > query.limit) break;
      }
      const more = items.length > query.limit;
      if (more) items.pop();
      return { items, nextCursor: more ? (items.at(-1)?.slug ?? null) : null };
    },
    async concepts() {
      const all = new Set((await published()).flatMap(({ summary }) => summary.concepts));
      return { items: [...all].sort() };
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
