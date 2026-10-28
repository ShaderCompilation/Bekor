import type { Framework, Language, ProblemListQuery, ProblemSummary } from "@bekor/contracts";

interface CatalogEntry {
  summary: ProblemSummary;
  /** Lower-cased title and description for search. */
  search: string;
}

import { type Database, exerciseVersions, problems } from "@bekor/db";
import {
  contentHash,
  createDomDownload,
  createDownload,
  domContentHash,
  getDomExercise,
  getExercise,
  listDomExercises,
  listExercises,
  toPublicDomExercise,
  toPublicExercise,
} from "@bekor/exercises";
import { and, asc, desc, eq } from "drizzle-orm";
import { ServiceError } from "./errors.js";

type AnyAuthored =
  | ReturnType<typeof listExercises>[number]
  | ReturnType<typeof listDomExercises>[number];
function contentHashValue(exercise: AnyAuthored) {
  return "privateTests" in exercise ? contentHash(exercise) : domContentHash(exercise);
}
const hash = contentHashValue;
function publicDetail(exercise: AnyAuthored) {
  return "privateTests" in exercise ? toPublicExercise(exercise) : toPublicDomExercise(exercise);
}
export function createCatalogService(database: Database) {
  async function resolveAny(
    exerciseId: string,
    version: string,
    executor: Pick<Database["db"], "select"> = database.db,
  ) {
    const [row] = await executor
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
    const exercise = getExercise(exerciseId, version) ?? getDomExercise(exerciseId, version);
    if (!exercise || hash(exercise) !== row.contentHash)
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
      const exercise = getExercise(exerciseId, version) ?? getDomExercise(exerciseId, version);
      if (!exercise || contentHashValue(exercise) !== hash)
        throw new ServiceError(
          "CONTENT_UNAVAILABLE",
          "Published exercise content is unavailable.",
          503,
        );
      const { id, slug, title, difficulty, concepts, description } = exercise.public;
      cached = {
        summary: {
          id,
          slug,
          version,
          title,
          difficulty,
          concepts,
          ...("kind" in exercise.public
            ? { kind: "dom" as const, assessment: "self" as const }
            : {}),
        },
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
    resolveAny,
    async resolve(exerciseId: string, version: string) {
      const exercise = await resolveAny(exerciseId, version);
      if (!("privateTests" in exercise))
        throw new ServiceError(
          "SELF_ASSESSED_EXERCISE",
          "DOM exercises use the browser preview and explicit self-assessment; they cannot be submitted to the Node runner.",
        );
      return exercise;
    },
    async publish() {
      for (const exercise of [...listExercises(), ...listDomExercises()]) {
        await database.db.transaction(async (tx) => {
          const { id, slug, version } = exercise.public;
          await tx.insert(problems).values({ id, slug }).onConflictDoNothing();
          await tx
            .insert(exerciseVersions)
            .values({ exerciseId: id, version, contentHash: hash(exercise) })
            .onConflictDoNothing();
          const [stored] = await tx
            .select()
            .from(exerciseVersions)
            .where(and(eq(exerciseVersions.exerciseId, id), eq(exerciseVersions.version, version)));
          if (stored?.contentHash !== hash(exercise))
            throw new Error(`Published content changed: ${id}@${version}`);
        });
      }
    },
    /**
     * `progress` maps the caller's exercise ids to their status and is required when the query
     * filters by status; problems missing from it are "todo".
     */
    async list(query: ProblemListQuery, progress?: ReadonlyMap<string, "solved" | "attempted">) {
      if (query.cursor && !/^[a-z][a-z0-9-]{0,79}$/.test(query.cursor))
        throw new ServiceError("INVALID_CURSOR", "Invalid catalog cursor.");
      if (query.status && !progress)
        throw new ServiceError("UNAUTHENTICATED", "Sign in to filter by progress.", 401);
      const random = query.order === "random";
      const ids = query.ids && new Set(query.ids);
      const text = query.q?.toLowerCase();
      const items: ProblemSummary[] = [];
      for (const { summary, search } of await published()) {
        if (!random && query.cursor && summary.slug <= query.cursor) continue;
        if (ids && !ids.has(summary.id)) continue;
        if (query.difficulty && summary.difficulty !== query.difficulty) continue;
        if (query.concept && !summary.concepts.includes(query.concept)) continue;
        if (query.status && (progress?.get(summary.id) ?? "todo") !== query.status) continue;
        if (text && !search.includes(text)) continue;
        items.push(summary);
        if (!random && items.length > query.limit) break;
      }
      if (random) {
        // Partial Fisher–Yates: the first `limit` entries become a uniform random sample.
        const count = Math.min(query.limit, items.length);
        for (let index = 0; index < count; index += 1) {
          const pick = index + Math.floor(Math.random() * (items.length - index));
          [items[index], items[pick]] = [
            items[pick] as ProblemSummary,
            items[index] as ProblemSummary,
          ];
        }
        return { items: items.slice(0, count), nextCursor: null };
      }
      const more = items.length > query.limit;
      if (more) items.pop();
      return { items, nextCursor: more ? (items.at(-1)?.slug ?? null) : null };
    },
    /** Every published problem's summary, ordered by slug. */
    async summaries(): Promise<ProblemSummary[]> {
      return (await published()).map(({ summary }) => summary);
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
      return publicDetail(await resolveAny(problem.id, selected));
    },
    async download(
      slug: string,
      language: Language,
      origin: string,
      version?: string,
      framework?: Framework,
    ) {
      const detail = await this.detail(slug, version);
      const authored = await resolveAny(detail.id, detail.version);
      if (!("privateTests" in authored)) {
        if (
          !framework ||
          !authored.public.variants.some(
            (v) => v.framework === framework && v.language === language,
          )
        )
          throw new ServiceError(
            "UNSUPPORTED_VARIANT",
            "Select an available DOM framework and language.",
          );
        return createDomDownload(authored, framework, language, origin);
      }
      if (framework)
        throw new ServiceError("UNSUPPORTED_VARIANT", "Node exercises have no browser framework.");
      return createDownload(authored, language, origin);
    },
  };
}
export type CatalogService = ReturnType<typeof createCatalogService>;
