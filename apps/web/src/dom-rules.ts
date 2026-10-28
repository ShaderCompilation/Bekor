import type { PracticeSession, Rating, SelfAssessment } from "@bekor/contracts";

/** Mirrors server manual-evidence rules; preview messages never participate. */
export function domRatingBlocker(
  session: Pick<PracticeSession, "kind" | "solutionRevealed">,
  outcome: SelfAssessment | undefined,
  rating: Rating,
): string | null {
  if (outcome === undefined) return "Report your self-assessment first.";
  if (session.kind === "practice" && outcome !== "solved")
    return "Confirm that all requirements are satisfied.";
  if (session.solutionRevealed && rating !== "again")
    return "Revealing a solution or using outside help requires Again.";
  if (session.kind === "learning" && outcome !== "solved")
    return "First enrollment requires confirming that all requirements are satisfied.";
  if (rating !== "again" && outcome !== "solved")
    return "Confirm that all requirements are satisfied before choosing this rating.";
  return null;
}
