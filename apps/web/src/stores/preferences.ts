import type { Language } from "@bekor/contracts";
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ThemePreference = "system" | "light" | "dark";
export const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

/** UI preferences only. Never put credentials or server data here. */
interface PreferenceState {
  language: Language;
  editorFontSize: number;
  theme: ThemePreference;
  wordWrap: boolean;
  /** Workspace pane sizes, as percentages. */
  statementWidth: number;
  consoleHeight: number;
  setLanguage: (language: Language) => void;
  setEditorFontSize: (size: number) => void;
  setTheme: (theme: ThemePreference) => void;
  setWordWrap: (wordWrap: boolean) => void;
  setPaneSizes: (sizes: { statementWidth?: number; consoleHeight?: number }) => void;
}

const defaults = {
  language: "javascript" as Language,
  editorFontSize: 14,
  theme: "system" as const,
  wordWrap: false,
  statementWidth: 40,
  consoleHeight: 35,
};
const clampPercent = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(80, Math.max(15, value))
    : fallback;

export const usePreferences = create<PreferenceState>()(
  persist(
    (set) => ({
      ...defaults,
      setLanguage: (language) => set({ language }),
      setEditorFontSize: (editorFontSize) =>
        set({ editorFontSize: Math.min(24, Math.max(10, editorFontSize)) }),
      setTheme: (theme) => set({ theme }),
      setWordWrap: (wordWrap) => set({ wordWrap }),
      setPaneSizes: (sizes) =>
        set((state) => ({
          statementWidth: clampPercent(sizes.statementWidth, state.statementWidth),
          consoleHeight: clampPercent(sizes.consoleHeight, state.consoleHeight),
        })),
    }),
    {
      name: "bekor.preferences",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // Keep known fields from older versions; anything unexpected falls back to defaults.
      migrate: (persisted) => {
        const old = (persisted ?? {}) as Partial<PreferenceState>;
        return {
          language: old.language === "typescript" ? "typescript" : "javascript",
          editorFontSize:
            typeof old.editorFontSize === "number"
              ? Math.min(24, Math.max(10, old.editorFontSize))
              : defaults.editorFontSize,
          theme: THEMES.includes(old.theme as ThemePreference)
            ? (old.theme as ThemePreference)
            : "system",
          wordWrap: old.wordWrap === true,
          statementWidth: clampPercent(old.statementWidth, defaults.statementWidth),
          consoleHeight: clampPercent(old.consoleHeight, defaults.consoleHeight),
        };
      },
    },
  ),
);

const DARK_QUERY = "(prefers-color-scheme: dark)";
function subscribeSystem(notify: () => void) {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}

export function resolveTheme(theme: ThemePreference, systemDark: boolean): "light" | "dark" {
  return theme === "system" ? (systemDark ? "dark" : "light") : theme;
}

/** The theme actually shown, following the OS when the preference is "system". */
export function useResolvedTheme() {
  const theme = usePreferences((state) => state.theme);
  const systemDark = useSyncExternalStore(
    subscribeSystem,
    () => window.matchMedia(DARK_QUERY).matches,
    () => false,
  );
  return resolveTheme(theme, systemDark);
}
