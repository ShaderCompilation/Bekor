import type { PracticeSession, ProblemSummary, ReviewCard, ReviewQueue } from "@bekor/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api, errorCode } from "../api";
import { reviewsQuery } from "../queries";

/** Starts (or resumes) a review session for a due card and opens its problem page. */
export function useStartReview(
  userId: string,
  queue: ReviewQueue,
  byId: ReadonlyMap<string, ProblemSummary>,
) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openSession = (session: PracticeSession) => {
    const problem = byId.get(session.exerciseId);
    return navigate({
      to: "/problems/$slug",
      params: { slug: problem?.slug ?? session.exerciseId },
      search: {
        session: session.id,
        language: session.language,
        ...(session.framework ? { framework: session.framework } : {}),
      },
    });
  };
  const start = useMutation({
    mutationFn: async (card: ReviewCard) => {
      const problem = byId.get(card.exerciseId);
      if (!problem) throw new Error("This problem is no longer in the catalog.");
      try {
        return await api.startSession({
          exerciseId: card.exerciseId,
          exerciseVersion: problem.version,
          language: card.language,
          kind: "review",
          ...(card.framework ? { framework: card.framework } : {}),
        });
      } catch (error) {
        // An active session on an older version must be resumed with its own version.
        const active = queue.unfinished.find(
          (session) =>
            session.exerciseId === card.exerciseId &&
            session.language === card.language &&
            session.framework === card.framework &&
            session.kind !== "practice",
        );
        if (errorCode(error) === "SESSION_MISMATCH" && active) return active;
        throw error;
      }
    },
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: reviewsQuery(userId).queryKey });
      await openSession(session);
    },
  });
  return { start, openSession };
}
