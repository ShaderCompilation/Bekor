import type { Rating, SessionKind } from "@bekor/contracts";
import {
  type Card,
  createEmptyCard,
  Rating as FsrsRating,
  fsrs,
  generatorParameters,
} from "ts-fsrs";

export const SCHEDULER_VERSION = "ts-fsrs@5.4.2/bekor-v1";
const parameters = generatorParameters({
  enable_fuzz: false,
  request_retention: 0.9,
  maximum_interval: 36500,
  enable_short_term: true,
  learning_steps: ["1m", "10m"],
  relearning_steps: ["10m"],
});
const engine = fsrs(parameters);
export function schedulerConfiguration(): Record<string, unknown> {
  return structuredClone(parameters) as unknown as Record<string, unknown>;
}
const grades = {
  again: FsrsRating.Again,
  hard: FsrsRating.Hard,
  good: FsrsRating.Good,
  easy: FsrsRating.Easy,
} as const;
export type StoredCard = Omit<Card, "due" | "last_review"> & { due: string; last_review?: string };

function hydrate(value: unknown): Card {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid stored scheduler state");
  const card = value as StoredCard;
  const due = new Date(card.due);
  const lastReview = card.last_review === undefined ? undefined : new Date(card.last_review);
  if (!Number.isFinite(due.getTime()) || (lastReview && !Number.isFinite(lastReview.getTime())))
    throw new Error("Invalid scheduler timestamp");
  for (const key of [
    "stability",
    "difficulty",
    "elapsed_days",
    "scheduled_days",
    "learning_steps",
    "reps",
    "lapses",
    "state",
  ] as const)
    if (!Number.isFinite(card[key]) || card[key] < 0) throw new Error("Invalid scheduler state");
  if (![0, 1, 2, 3].includes(card.state)) throw new Error("Invalid scheduler state");
  return { ...card, due, ...(lastReview ? { last_review: lastReview } : {}) } as Card;
}

export function schedule(
  previous: unknown | null,
  rating: Rating,
  now: Date,
): {
  state: StoredCard;
  due: Date;
  schedulerVersion: string;
  configuration: Record<string, unknown>;
} {
  if (!Number.isFinite(now.getTime()) || !Object.hasOwn(grades, rating))
    throw new Error("Invalid scheduling input");
  const card = previous === null ? createEmptyCard(now) : hydrate(previous);
  if (card.last_review && now < card.last_review)
    throw new Error("Review time precedes the previous review");
  const next = engine.next(card, now, grades[rating]).card;
  const state = JSON.parse(JSON.stringify(next)) as StoredCard;
  return {
    state,
    due: next.due,
    schedulerVersion: SCHEDULER_VERSION,
    configuration: schedulerConfiguration(),
  };
}

export interface CompletionEvidence {
  kind: SessionKind;
  enrolled: boolean;
  accepted: boolean;
  unsuccessful: boolean;
  solutionRevealed: boolean;
}
export function completionViolation(evidence: CompletionEvidence, rating: Rating): string | null {
  if (evidence.solutionRevealed && rating !== "again")
    return "A solution reveal or external help requires an Again rating.";
  if (evidence.kind !== "practice" && !evidence.enrolled && !evidence.accepted)
    return "Initial enrollment requires an accepted Submit from this session.";
  if (rating !== "again" && !evidence.accepted)
    return "This rating requires an accepted Submit from this session.";
  if (
    rating === "again" &&
    !evidence.accepted &&
    !evidence.unsuccessful &&
    !evidence.solutionRevealed
  )
    return "Again requires a completed attempt or recorded solution reveal.";
  return null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timezone, value);
  }
  return value;
}

/** Calendar day (YYYY-MM-DD) of an instant in an IANA timezone. */
export function localDay(instant: Date, timezone: string): string {
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid instant");
  const parts = formatter(timezone).formatToParts(instant);
  return ["year", "month", "day"]
    .map((kind) => parts.find((part) => part.type === kind)?.value)
    .join("-");
}

/**
 * First instant (millisecond precision) that belongs to the local day after `instant`'s local day.
 * Uses a search over real instants rather than offset arithmetic so DST transitions (including
 * zones whose transition skips midnight) remain correct. Local days never exceed 27 hours.
 */
export function nextLocalDayStart(instant: Date, timezone: string): Date {
  const today = localDay(instant, timezone);
  let low = instant.getTime();
  let high = low + 48 * 3_600_000;
  if (localDay(new Date(high), timezone) <= today) throw new Error("Unsupported timezone offset");
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDay(new Date(middle), timezone) > today) high = middle;
    else low = middle;
  }
  return new Date(high);
}
