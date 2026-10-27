import type { Language } from "@bekor/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Editor buffers. A draft belongs to one user, exercise version, language and session, so a
 * review session (new session id) always starts from the starter instead of earlier code.
 * Free practice outside any session uses the "free" slot.
 */
export interface DraftScope {
  userId: string;
  exerciseId: string;
  version: string;
  language: Language;
  sessionId: string | null;
}

export function draftKey(scope: DraftScope): string {
  return [
    scope.userId,
    `${scope.exerciseId}@${scope.version}`,
    scope.language,
    scope.sessionId ?? "free",
  ].join("|");
}

interface Draft {
  source: string;
  updatedAt: number;
}

interface DraftState {
  drafts: Record<string, Draft>;
  save: (key: string, source: string) => void;
  discard: (key: string) => void;
}

const MAX_DRAFTS = 200;

export const useDrafts = create<DraftState>()(
  persist(
    (set) => ({
      drafts: {},
      save: (key, source) =>
        set((state) => {
          const drafts = { ...state.drafts, [key]: { source, updatedAt: Date.now() } };
          const keys = Object.keys(drafts);
          if (keys.length > MAX_DRAFTS) {
            // Drop the least recently edited drafts; localStorage is bounded.
            const oldest = keys
              .sort((a, b) => (drafts[a]?.updatedAt ?? 0) - (drafts[b]?.updatedAt ?? 0))
              .slice(0, keys.length - MAX_DRAFTS);
            for (const stale of oldest) delete drafts[stale];
          }
          return { drafts };
        }),
      discard: (key) =>
        set((state) => {
          const drafts = { ...state.drafts };
          delete drafts[key];
          return { drafts };
        }),
    }),
    {
      name: "bekor.drafts",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // Unknown future/past shapes are dropped rather than loaded into the editor.
      migrate: () => ({ drafts: {} }),
    },
  ),
);

export function readDraft(key: string): string | undefined {
  return useDrafts.getState().drafts[key]?.source;
}
