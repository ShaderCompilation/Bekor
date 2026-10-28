import { create } from "zustand";

export type GlobalDialog = "palette" | "help" | null;

/** Which app-wide modal is open; only one at a time. */
export const useDialogs = create<{ open: GlobalDialog; show: (dialog: GlobalDialog) => void }>()(
  (set) => ({ open: null, show: (open) => set({ open }) }),
);
