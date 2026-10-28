import { randomUUID } from "node:crypto";
import {
  type AssistanceKind,
  assistanceSchema,
  type Completion,
  completionSchema,
  type PracticeSession,
  practiceSessionSchema,
  type Rating,
  type Reveal,
  reviewCardSchema,
  type SelfAssessment,
  type SessionStart,
  sessionCompleteSchema,
  sessionStartSchema,
} from "@bekor/contracts";
import {
  assistanceEvents,
  type Database,
  practiceSessions,
  preferences,
  reviewCards,
  reviewEvents,
  submissions,
  user,
} from "@bekor/db";
import {
  completionViolation,
  nextLocalDayStart,
  SCHEDULER_VERSION,
  schedule,
} from "@bekor/scheduling";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { CatalogService } from "./catalog.js";
import { ServiceError } from "./errors.js";

type SessionRow = typeof practiceSessions.$inferSelect;
type AssistanceRow = typeof assistanceEvents.$inferSelect;
type Transaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];
function sessionDto(row: SessionRow, assistance: AssistanceRow[]): PracticeSession {
  return practiceSessionSchema.parse({
    ...row,
    framework: row.framework === "node" ? undefined : row.framework,
    assessment: row.framework === "node" ? undefined : row.assessment,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    solutionRevealed: assistance.some((event) => event.kind !== "hint"),
    hintUsed: assistance.some((event) => event.kind === "hint"),
  });
}
function cardDto(row: typeof reviewCards.$inferSelect) {
  return reviewCardSchema.parse({
    id: row.id,
    exerciseId: row.exerciseId,
    language: row.language,
    framework: row.framework === "node" ? undefined : row.framework,
    due: row.dueAt.toISOString(),
    state: row.state,
    schedulerVersion: row.schedulerVersion,
  });
}
function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let item: unknown = error; item instanceof Error; item = item.cause) {
    const details = item as Error & { code?: unknown; constraint?: unknown };
    if (details.code === "23505" && details.constraint === constraint) return true;
  }
  return false;
}
async function sessionAssistance(tx: Transaction, sessionId: string) {
  return tx.select().from(assistanceEvents).where(eq(assistanceEvents.sessionId, sessionId));
}
async function lockUser(tx: Transaction, userId: string) {
  const [owner] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .for("update");
  if (!owner) throw new ServiceError("UNAUTHENTICATED", "Sign in required.", 401);
}
async function ownedSession(tx: Transaction, userId: string, id: string) {
  const [session] = await tx
    .select()
    .from(practiceSessions)
    .where(and(eq(practiceSessions.id, id), eq(practiceSessions.userId, userId)))
    .for("update");
  if (!session) throw new ServiceError("NOT_FOUND", "Practice session not found.", 404);
  return session;
}

export function domCompletionViolation(
  evidence: {
    kind: "learning" | "review" | "practice";
    enrolled: boolean;
    selfAssessment?: SelfAssessment | undefined;
    solutionRevealed: boolean;
  },
  rating: Rating | undefined,
): string | null {
  if (evidence.selfAssessment === undefined)
    return "Explicitly confirm that you solved the requirements or attempted but were unable to solve them.";
  if (evidence.kind !== "practice" && rating === undefined)
    return "Choose a recall rating to finish this session.";
  if (evidence.solutionRevealed && rating !== "again")
    return "A solution reveal or external help requires an Again rating.";
  if (evidence.kind === "practice" && evidence.selfAssessment !== "solved")
    return "Mark complete requires confirmation that the requirements are satisfied.";
  if (evidence.kind !== "practice" && !evidence.enrolled && evidence.selfAssessment !== "solved")
    return "Initial enrollment requires a solved confirmation from this session.";
  if (rating !== undefined && rating !== "again" && evidence.selfAssessment !== "solved")
    return "This rating requires a solved confirmation from this session.";
  return null;
}

export function createReviewService(
  database: Database,
  catalog: Pick<CatalogService, "resolveAny">,
  clock = () => new Date(),
) {
  return {
    async start(userId: string, raw: SessionStart): Promise<PracticeSession> {
      const parsed = sessionStartSchema.safeParse(raw);
      if (!parsed.success) throw new ServiceError("INVALID_INPUT", "Invalid practice session.");
      const { requestId, ...input } = parsed.data;
      const framework = input.framework ?? "node";
      const attempt = () =>
        database.db.transaction(async (tx) => {
          await lockUser(tx, userId);
          if (requestId) {
            const [previous] = await tx
              .select()
              .from(practiceSessions)
              .where(eq(practiceSessions.id, requestId));
            if (previous) {
              if (
                previous.userId !== userId ||
                previous.exerciseId !== input.exerciseId ||
                previous.exerciseVersion !== input.exerciseVersion ||
                previous.framework !== framework ||
                previous.language !== input.language ||
                previous.kind !== input.kind
              )
                throw new ServiceError(
                  "SESSION_START_CONFLICT",
                  "Session start identity was already used for another request.",
                  409,
                );
              return sessionDto(previous, await sessionAssistance(tx, previous.id));
            }
          }
          const exercise = await catalog.resolveAny(input.exerciseId, input.exerciseVersion, tx);
          if (Array.isArray(exercise.public.variants)) {
            if (
              !exercise.public.variants.some(
                (variant) => variant.framework === framework && variant.language === input.language,
              )
            )
              throw new ServiceError(
                "INVALID_VARIANT",
                "Select an available framework and language for this DOM exercise.",
              );
          } else if (framework !== "node") {
            throw new ServiceError(
              "INVALID_VARIANT",
              "Node exercises do not support browser frameworks.",
            );
          }
          if (input.kind !== "practice") {
            const [active] = await tx
              .select()
              .from(practiceSessions)
              .where(
                and(
                  eq(practiceSessions.userId, userId),
                  eq(practiceSessions.exerciseId, input.exerciseId),
                  eq(practiceSessions.language, input.language),
                  eq(practiceSessions.framework, framework),
                  eq(practiceSessions.status, "active"),
                  ne(practiceSessions.kind, "practice"),
                ),
              );
            if (active) {
              if (active.exerciseVersion !== input.exerciseVersion)
                throw new ServiceError(
                  "SESSION_MISMATCH",
                  "Resume the active session using its exercise version.",
                  409,
                );
              return sessionDto(active, await sessionAssistance(tx, active.id));
            }
            const [card] = await tx
              .select()
              .from(reviewCards)
              .where(
                and(
                  eq(reviewCards.userId, userId),
                  eq(reviewCards.exerciseId, input.exerciseId),
                  eq(reviewCards.language, input.language),
                  eq(reviewCards.framework, framework),
                ),
              );
            if (input.kind === "review" && !card)
              throw new ServiceError(
                "NOT_ENROLLED",
                "Complete a learning session before starting reviews.",
                409,
              );
            if (input.kind === "learning" && card)
              throw new ServiceError(
                "ALREADY_ENROLLED",
                "Start a review or unscheduled practice session.",
                409,
              );
          }
          const [row] = await tx
            .insert(practiceSessions)
            .values({
              id: requestId ?? randomUUID(),
              userId,
              ...input,
              framework,
              createdAt: clock(),
            })
            .returning();
          if (!row) throw new Error("Session insertion failed");
          return sessionDto(row, []);
        });
      try {
        return await attempt();
      } catch (error) {
        if (isUniqueViolation(error, "practice_sessions_pkey"))
          throw new ServiceError(
            "SESSION_START_CONFLICT",
            "Session start identity was already used for another request.",
            409,
          );
        // The user lock serializes starts made through this service; a concurrent writer that
        // bypasses it still loses to the partial unique index, so resume the winner's session.
        if (!isUniqueViolation(error, "one_active_scheduling_session")) throw error;
        return attempt();
      }
    },
    async assistance(userId: string, id: string, kind: AssistanceKind): Promise<PracticeSession> {
      if (!assistanceSchema.safeParse({ kind }).success)
        throw new ServiceError("INVALID_INPUT", "Invalid assistance kind.");
      return database.db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const row = await ownedSession(tx, userId, id);
        if (row.status !== "active")
          throw new ServiceError("SESSION_COMPLETED", "Practice session already completed.", 409);
        const events = await sessionAssistance(tx, id);
        // Each assistance signal is monotonic; retries do not create unbounded duplicate events.
        if (!events.some((event) => event.kind === kind)) {
          const [event] = await tx
            .insert(assistanceEvents)
            .values({ id: randomUUID(), sessionId: id, kind, createdAt: clock() })
            .returning();
          if (event) events.push(event);
        }
        return sessionDto(row, events);
      });
    },
    async reveal(userId: string, id: string): Promise<Reveal> {
      return database.db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const row = await ownedSession(tx, userId, id);
        const events = await sessionAssistance(tx, id);
        const revealed = events.some((event) => event.kind === "solution_reveal");
        if (row.status !== "active" && !revealed)
          throw new ServiceError("SESSION_COMPLETED", "Practice session already completed.", 409);
        // Resolve before recording so unavailable content never restricts the rating unseen.
        const exercise = await catalog.resolveAny(row.exerciseId, row.exerciseVersion, tx);
        let solution: string;
        let files: Record<string, string> | undefined;
        if (Array.isArray(exercise.public.variants)) {
          const variant = exercise.public.variants.find(
            (v) => v.framework === row.framework && v.language === row.language,
          );
          if (!variant)
            throw new ServiceError("INVALID_VARIANT", "The session variant is unavailable.", 503);
          files = (exercise.referenceSolutions as Record<string, Record<string, string>>)[
            variant.id
          ];
          if (!files)
            throw new ServiceError("CONTENT_UNAVAILABLE", "Reference files are unavailable.", 503);
          solution = Object.entries(files)
            .map(([path, code]) => `// ${path}\n${code}`)
            .join("\n\n");
        } else {
          solution = (exercise.referenceSolutions as Record<string, string>)[row.language] ?? "";
        }
        if (!revealed) {
          const [event] = await tx
            .insert(assistanceEvents)
            .values({
              id: randomUUID(),
              sessionId: id,
              kind: "solution_reveal",
              createdAt: clock(),
            })
            .returning();
          if (event) events.push(event);
        }
        return {
          session: sessionDto(row, events),
          explanation: exercise.explanation,
          solution,
          ...(files ? { files } : {}),
        };
      });
    },
    async complete(
      userId: string,
      id: string,
      rating: Rating | undefined,
      selfAssessment?: SelfAssessment,
    ): Promise<Completion> {
      if (!sessionCompleteSchema.safeParse({ rating, selfAssessment }).success)
        throw new ServiceError("INVALID_INPUT", "Invalid rating.");
      return database.db.transaction(async (tx) => {
        await lockUser(tx, userId);
        const session = await ownedSession(tx, userId, id);
        const dom = session.framework !== "node";
        if (!dom && (selfAssessment !== undefined || rating === undefined))
          throw new ServiceError(
            "INVALID_INPUT",
            "Node completion requires a rating and judged evidence.",
          );
        if (dom && session.kind !== "practice" && rating === undefined)
          throw new ServiceError("INVALID_INPUT", "Choose a recall rating to finish this session.");
        if (session.status === "completed") {
          if (session.rating !== (rating ?? null))
            throw new ServiceError(
              "RATING_CONFLICT",
              "Session was completed with another rating.",
              409,
            );
          if (dom && session.assessment?.outcome !== selfAssessment)
            throw new ServiceError(
              "ASSESSMENT_CONFLICT",
              "Session was completed with different self-assessment evidence.",
              409,
            );
          return completionSchema.parse(session.completion);
        }
        if (dom) {
          const exercise = await catalog.resolveAny(
            session.exerciseId,
            session.exerciseVersion,
            tx,
          );
          if (
            !Array.isArray(exercise.public.variants) ||
            !exercise.public.variants.some(
              (variant) =>
                variant.framework === session.framework && variant.language === session.language,
            )
          )
            throw new ServiceError("INVALID_VARIANT", "The session variant is unavailable.", 503);
        }
        const events = await sessionAssistance(tx, id);
        const [card] = await tx
          .select()
          .from(reviewCards)
          .where(
            and(
              eq(reviewCards.userId, userId),
              eq(reviewCards.exerciseId, session.exerciseId),
              eq(reviewCards.language, session.language),
              eq(reviewCards.framework, session.framework),
            ),
          )
          .for("update");
        const revealed = events.some((event) => event.kind !== "hint");
        if (dom) {
          const violation = domCompletionViolation(
            {
              kind: session.kind,
              enrolled: Boolean(card),
              selfAssessment,
              solutionRevealed: revealed,
            },
            rating,
          );
          if (violation) throw new ServiceError("INVALID_RATING_EVIDENCE", violation, 409);
        } else {
          // Only terminal judged attempts from this session count; Run never satisfies Submit.
          const attempts = await tx
            .select({ mode: submissions.mode, verdict: submissions.verdict })
            .from(submissions)
            .where(
              and(
                eq(submissions.userId, userId),
                eq(submissions.practiceSessionId, id),
                eq(submissions.exerciseId, session.exerciseId),
                eq(submissions.exerciseVersion, session.exerciseVersion),
                eq(submissions.language, session.language),
                eq(submissions.status, "completed"),
              ),
            );
          const violation = completionViolation(
            {
              kind: session.kind,
              enrolled: Boolean(card),
              accepted: attempts.some(
                (attempt) => attempt.mode === "submit" && attempt.verdict === "accepted",
              ),
              unsuccessful: attempts.some(
                (attempt) => attempt.verdict !== null && attempt.verdict !== "accepted",
              ),
              solutionRevealed: revealed,
            },
            rating as Rating,
          );
          if (violation) throw new ServiceError("INVALID_RATING_EVIDENCE", violation, 409);
        }
        const now = clock();
        const assessment =
          dom && selfAssessment !== undefined
            ? {
                outcome: selfAssessment,
                provenance: "self" as const,
                assessedAt: now.toISOString(),
              }
            : null;
        let completedCard = card;
        if (session.kind !== "practice") {
          if (card && card.schedulerVersion !== SCHEDULER_VERSION)
            throw new ServiceError(
              "SCHEDULER_VERSION_UNSUPPORTED",
              "Stored review scheduling version requires migration.",
              503,
            );
          const next = schedule(card?.state ?? null, rating as Rating, now);
          if (card) {
            [completedCard] = await tx
              .update(reviewCards)
              .set({
                state: next.state,
                dueAt: next.due,
                configuration: next.configuration,
                schedulerVersion: next.schedulerVersion,
                revision: sql`${reviewCards.revision} + 1`,
                updatedAt: now,
              })
              .where(eq(reviewCards.id, card.id))
              .returning();
          } else {
            [completedCard] = await tx
              .insert(reviewCards)
              .values({
                id: randomUUID(),
                userId,
                exerciseId: session.exerciseId,
                language: session.language,
                framework: session.framework,
                state: next.state,
                dueAt: next.due,
                schedulerVersion: next.schedulerVersion,
                configuration: next.configuration,
                createdAt: now,
                updatedAt: now,
              })
              .returning();
          }
          if (!completedCard) throw new Error("Card update failed");
          await tx.insert(reviewEvents).values({
            id: randomUUID(),
            sessionId: id,
            cardId: completedCard.id,
            rating: rating as Rating,
            exerciseVersion: session.exerciseVersion,
            createdAt: now,
            beforeState: card?.state ?? null,
            afterState: next.state,
            assistance: events.map((event) => ({
              kind: event.kind,
              at: event.createdAt.toISOString(),
            })),
            schedulerVersion: next.schedulerVersion,
            configuration: next.configuration,
          });
        }
        const complete = completionSchema.parse({
          session: sessionDto(
            {
              ...session,
              status: "completed",
              rating: rating ?? null,
              assessment,
              completedAt: now,
            },
            events,
          ),
          card: session.kind === "practice" ? null : completedCard ? cardDto(completedCard) : null,
        });
        await tx
          .update(practiceSessions)
          .set({
            status: "completed",
            rating: rating ?? null,
            assessment,
            completedAt: now,
            completion: complete,
            revision: sql`${practiceSessions.revision} + 1`,
          })
          .where(eq(practiceSessions.id, id));
        return complete;
      });
    },
    async history(userId: string) {
      return database.db.transaction(
        async (tx) => {
          const completed = await tx
            .select()
            .from(practiceSessions)
            .where(
              and(
                eq(practiceSessions.userId, userId),
                ne(practiceSessions.framework, "node"),
                eq(practiceSessions.status, "completed"),
              ),
            )
            .orderBy(desc(practiceSessions.completedAt), desc(practiceSessions.id))
            .limit(100);
          // Completion snapshots retain the assistance state from the authoritative completion.
          return { items: completed.map((row) => completionSchema.parse(row.completion).session) };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
    async queue(userId: string) {
      return database.db.transaction(
        async (tx) => {
          const [settings] = await tx
            .select()
            .from(preferences)
            .where(eq(preferences.userId, userId));
          const dailyReviewLimit = settings?.dailyReviewLimit ?? 20;
          const timezone = settings?.timezone ?? "UTC";
          // Everything due before the user's next local midnight is "today"; overdue cards stay.
          const dayEnd = nextLocalDayStart(clock(), timezone);
          const due = await tx
            .select()
            .from(reviewCards)
            .where(and(eq(reviewCards.userId, userId), lt(reviewCards.dueAt, dayEnd)))
            .orderBy(asc(reviewCards.dueAt), asc(reviewCards.id))
            .limit(dailyReviewLimit + 1);
          const unfinished = await tx
            .select()
            .from(practiceSessions)
            .where(and(eq(practiceSessions.userId, userId), eq(practiceSessions.status, "active")))
            .orderBy(asc(practiceSessions.createdAt), asc(practiceSessions.id))
            .limit(100);
          const signals = unfinished.length
            ? await tx
                .select()
                .from(assistanceEvents)
                .where(
                  inArray(
                    assistanceEvents.sessionId,
                    unfinished.map((row) => row.id),
                  ),
                )
            : [];
          return {
            due: due.slice(0, dailyReviewLimit).map(cardDto),
            unfinished: unfinished.map((row) =>
              sessionDto(
                row,
                signals.filter((event) => event.sessionId === row.id),
              ),
            ),
            timezone,
            dailyReviewLimit,
            hasMore: due.length > dailyReviewLimit,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
export type ReviewService = ReturnType<typeof createReviewService>;
