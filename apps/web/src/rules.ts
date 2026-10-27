import type { PracticeSession, Rating } from "@bekor/contracts";

/**
 * Mirrors the server's completion rules to explain disabled ratings. The server stays
 * authoritative and rejects anything this check misses.
 */
export function ratingBlocker(
  evidence: {
    kind: PracticeSession["kind"];
    accepted: boolean;
    unsuccessful: boolean;
    revealed: boolean;
  },
  rating: Rating,
): string | null {
  if (evidence.revealed && rating !== "again")
    return "A solution reveal or outside help limits this session to Again.";
  if (evidence.kind === "learning" && !evidence.accepted)
    return "Get an accepted Submit in this session to enroll it.";
  if (rating !== "again" && !evidence.accepted) return "Needs an accepted Submit in this session.";
  if (rating === "again" && !evidence.accepted && !evidence.unsuccessful && !evidence.revealed)
    return "Make an attempt (Run or Submit) or reveal the solution first.";
  return null;
}
