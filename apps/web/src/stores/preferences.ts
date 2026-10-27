import type { Language } from "@bekor/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** UI preferences only. Never put credentials or server data here. */
interface PreferenceState {
  language: Language;
  editorFontSize: number;
  setLanguage: (language: Language) => void;
  setEditorFontSize: (size: number) => void;
}

export const usePreferences = create<PreferenceState>()(
  persist(
    (set) => ({
      language: "javascript",
      editorFontSize: 14,
      setLanguage: (language) => set({ language }),
      setEditorFontSize: (editorFontSize) =>
        set({ editorFontSize: Math.min(24, Math.max(10, editorFontSize)) }),
    }),
    {
      name: "bekor.preferences",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: () => ({ language: "javascript", editorFontSize: 14 }),
    },
  ),
);
