import { expect, it } from "vitest";
import { domRatingBlocker } from "../../apps/web/src/dom-rules";
import { domCompletionViolation } from "../../packages/core/src/reviews";

it("manual rating controls agree with server evidence rules for all reachable sessions", () => {
  for (const kind of ["learning", "review", "practice"] as const)
    for (const outcome of [undefined, "solved", "unable"] as const)
      for (const solutionRevealed of [false, true])
        for (const rating of ["again", "hard", "good", "easy"] as const) {
          const server = domCompletionViolation(
            { kind, enrolled: kind === "review", selfAssessment: outcome, solutionRevealed },
            rating,
          );
          const browser = domRatingBlocker({ kind, solutionRevealed }, outcome, rating);
          expect(browser === null, `${kind}/${outcome}/${solutionRevealed}/${rating}`).toBe(
            server === null,
          );
        }
});
