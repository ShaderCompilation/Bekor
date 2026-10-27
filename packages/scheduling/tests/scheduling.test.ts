import type { Rating } from "@bekor/contracts";
import { describe, expect, it } from "vitest";
import {
  type CompletionEvidence,
  completionViolation,
  localDay,
  nextLocalDayStart,
  SCHEDULER_VERSION,
  schedule,
} from "../src/index.js";

const now = new Date("2026-01-05T09:00:00.000Z");

describe("schedule", () => {
  it("schedules all four ratings from a new card deterministically", () => {
    const expected: Record<Rating, [string, number]> = {
      again: ["2026-01-05T09:01:00.000Z", 1],
      hard: ["2026-01-05T09:06:00.000Z", 1],
      good: ["2026-01-05T09:10:00.000Z", 1],
      easy: ["2026-01-13T09:00:00.000Z", 2],
    };
    for (const [rating, [due, state]] of Object.entries(expected) as [Rating, [string, number]][]) {
      const first = schedule(null, rating, now);
      const second = schedule(null, rating, new Date(now));
      expect(first).toEqual(second);
      expect(first.due.toISOString()).toBe(due);
      expect(first.state).toMatchObject({ due, state, reps: 1, last_review: now.toISOString() });
      expect(first.schedulerVersion).toBe(SCHEDULER_VERSION);
      expect(first.configuration).toMatchObject({ enable_fuzz: false, request_retention: 0.9 });
    }
  });

  it("reviews an enrolled card from its stored JSON state", () => {
    const enrolled = schedule(null, "easy", now);
    const reviewAt = new Date(enrolled.due);
    const stored = JSON.parse(JSON.stringify(enrolled.state));
    const good = schedule(stored, "good", reviewAt);
    expect(good.state.reps).toBe(2);
    expect(good.state.last_review).toBe(reviewAt.toISOString());
    expect(good.due.getTime()).toBeGreaterThan(reviewAt.getTime() + 8 * 86_400_000);
    const again = schedule(stored, "again", reviewAt);
    expect(again.state.lapses).toBe(1);
    expect(again.due.getTime()).toBeLessThan(good.due.getTime());
    expect(schedule(stored, "good", reviewAt)).toEqual(good);
  });

  it("rejects corrupt stored state and invalid input", () => {
    const valid = schedule(null, "good", now).state;
    for (const corrupt of [
      "card",
      { ...valid, due: "not-a-date" },
      { ...valid, last_review: "nope" },
      { ...valid, stability: -1 },
      { ...valid, reps: Number.NaN },
      { ...valid, state: 7 },
      { ...valid, difficulty: "2" },
    ]) {
      expect(() => schedule(corrupt, "good", now)).toThrow();
    }
    expect(() => schedule(42, "good", now)).toThrow("Invalid stored scheduler state");
    expect(() => schedule(null, "perfect" as Rating, now)).toThrow("Invalid scheduling input");
    expect(() => schedule(null, "good", new Date(Number.NaN))).toThrow("Invalid scheduling input");
  });

  it("refuses a review time preceding the previous review", () => {
    const state = schedule(null, "good", now).state;
    expect(() => schedule(state, "good", new Date(now.getTime() - 1))).toThrow(
      "Review time precedes the previous review",
    );
  });
});

describe("completionViolation", () => {
  const base: CompletionEvidence = {
    kind: "learning",
    enrolled: false,
    accepted: false,
    unsuccessful: false,
    solutionRevealed: false,
  };
  const ratings: Rating[] = ["again", "hard", "good", "easy"];
  const allowed = (evidence: Partial<CompletionEvidence>) =>
    ratings.filter((rating) => completionViolation({ ...base, ...evidence }, rating) === null);

  it("requires an accepted Submit for first enrollment", () => {
    expect(allowed({})).toEqual([]);
    expect(allowed({ unsuccessful: true })).toEqual([]);
    expect(allowed({ solutionRevealed: true })).toEqual([]);
    expect(allowed({ accepted: true })).toEqual(ratings);
    expect(allowed({ accepted: true, solutionRevealed: true })).toEqual(["again"]);
  });

  it("permits Again for enrolled reviews after a failed attempt or reveal only", () => {
    const review = { kind: "review" as const, enrolled: true };
    expect(allowed(review)).toEqual([]);
    expect(allowed({ ...review, unsuccessful: true })).toEqual(["again"]);
    expect(allowed({ ...review, solutionRevealed: true })).toEqual(["again"]);
    expect(allowed({ ...review, accepted: true })).toEqual(ratings);
    expect(allowed({ ...review, accepted: true, unsuccessful: true })).toEqual(ratings);
    expect(allowed({ ...review, accepted: true, solutionRevealed: true })).toEqual(["again"]);
    expect(completionViolation({ ...base, ...review, unsuccessful: true }, "good")).toBe(
      "This rating requires an accepted Submit from this session.",
    );
  });

  it("applies the same evidence rules to unscheduled practice without enrollment", () => {
    const practice = { kind: "practice" as const };
    expect(allowed(practice)).toEqual([]);
    expect(allowed({ ...practice, unsuccessful: true })).toEqual(["again"]);
    expect(allowed({ ...practice, accepted: true })).toEqual(ratings);
    expect(allowed({ ...practice, accepted: true, solutionRevealed: true })).toEqual(["again"]);
  });
});

describe("local day grouping", () => {
  it("groups instants around UTC midnight by timezone", () => {
    expect(localDay(new Date("2026-10-27T23:59:59.999Z"), "UTC")).toBe("2026-10-27");
    expect(localDay(new Date("2026-10-28T00:00:00.000Z"), "UTC")).toBe("2026-10-28");
    expect(localDay(new Date("2026-10-28T00:30:00.000Z"), "America/New_York")).toBe("2026-10-27");
    expect(localDay(new Date("2026-10-27T15:30:00.000Z"), "Asia/Tokyo")).toBe("2026-10-28");
    expect(nextLocalDayStart(new Date("2026-10-27T00:00:00.000Z"), "UTC").toISOString()).toBe(
      "2026-10-28T00:00:00.000Z",
    );
    expect(nextLocalDayStart(new Date("2026-10-27T23:59:59.999Z"), "UTC").toISOString()).toBe(
      "2026-10-28T00:00:00.000Z",
    );
    expect(() => localDay(new Date(Number.NaN), "UTC")).toThrow();
  });

  it("handles the America/New_York spring-forward day (23 hours)", () => {
    const start = nextLocalDayStart(new Date("2026-03-07T12:00:00.000Z"), "America/New_York");
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    const end = nextLocalDayStart(new Date("2026-03-08T12:00:00.000Z"), "America/New_York");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000);
    expect(localDay(new Date("2026-03-09T03:59:59.999Z"), "America/New_York")).toBe("2026-03-08");
    expect(localDay(new Date("2026-03-09T04:00:00.000Z"), "America/New_York")).toBe("2026-03-09");
  });

  it("handles the America/New_York fall-back day (25 hours)", () => {
    const start = nextLocalDayStart(new Date("2026-10-31T12:00:00.000Z"), "America/New_York");
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    const end = nextLocalDayStart(new Date("2026-11-01T12:00:00.000Z"), "America/New_York");
    expect(end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
    // 01:30 occurs twice locally; both instants belong to the same local day.
    expect(localDay(new Date("2026-11-01T05:30:00.000Z"), "America/New_York")).toBe("2026-11-01");
    expect(localDay(new Date("2026-11-01T06:30:00.000Z"), "America/New_York")).toBe("2026-11-01");
  });
});
