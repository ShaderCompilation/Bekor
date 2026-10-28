import { useToasts } from "../stores/toasts";

export function Toaster() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  return (
    <section className="toaster" aria-live="polite" aria-label="Notifications">
      {toasts.map((item) => (
        <div key={item.id} className={`toast toast-${item.tone}`} role="status">
          <span>{item.message}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => dismiss(item.id)}
          >
            ×
          </button>
        </div>
      ))}
    </section>
  );
}
