import { create } from "zustand";

export type ToastTone = "ok" | "bad" | "warn" | "info";
export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

const LIFETIME_MS = 5000;
const MAX_TOASTS = 4;
let nextId = 1;

interface ToastState {
  toasts: Toast[];
  push: (message: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

/** Transient notices only; anything the user must act on stays on the page. */
export const useToasts = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (message, tone = "info") => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts, { id, tone, message }].slice(-MAX_TOASTS) }));
    setTimeout(() => get().dismiss(id), LIFETIME_MS);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export const toast = (message: string, tone?: ToastTone) =>
  useToasts.getState().push(message, tone);
