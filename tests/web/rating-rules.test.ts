import { describe, expect, it } from "vitest";
import { ratingBlocker } from "../../apps/web/src/rules";
import { completionViolation } from "../../packages/scheduling/src/index";

// The web UI disables ratings the server would reject. Check both agree on every combination
// a browser session can reach (learning sessions are never enrolled; reviews always are).
describe("web rating rules match the server", () => {
  const kinds = ["learning", "review", "practice"] as const;
  const ratings = ["again", "hard", "good", "easy"] as const;
  const flags = [false, true];
  for (const kind of kinds)
    for (const accepted of flags)
      for (const unsuccessful of flags)
        for (const revealed of flags)
          for (const rating of ratings)
            it(`${kind} accepted=${accepted} unsuccessful=${unsuccessful} revealed=${revealed} ${rating}`, () => {
              const server = completionViolation(
                {
                  kind,
                  enrolled: kind === "review",
                  accepted,
                  unsuccessful,
                  solutionRevealed: revealed,
                },
                rating,
              );
              const client = ratingBlocker({ kind, accepted, unsuccessful, revealed }, rating);
              expect(client === null).toBe(server === null);
            });
});
