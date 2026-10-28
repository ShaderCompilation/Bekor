import { type RefObject, useRef } from "react";

const KEY_STEP = 2;

/**
 * A draggable, keyboard-operable separator (WAI-ARIA window splitter). `value` is the size of the
 * first pane as a percentage of `container`; arrows move by 2%, Home/End jump to the limits.
 */
export function Splitter({
  orientation,
  value,
  min,
  max,
  onChange,
  container,
  label,
  controls,
}: {
  /** "vertical" separates left/right panes; "horizontal" separates top/bottom panes. */
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  container: RefObject<HTMLElement | null>;
  label: string;
  controls?: string;
}) {
  const dragging = useRef(false);
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)) * 10) / 10;
  const fromPointer = (event: React.PointerEvent) => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio =
      orientation === "vertical"
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height;
    onChange(clamp(ratio * 100));
  };
  const back = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
  const forward = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot be focusable or draggable
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-controls={controls}
      className={`splitter splitter-${orientation}`}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (dragging.current) fromPointer(event);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        const next =
          event.key === back
            ? value - KEY_STEP
            : event.key === forward
              ? value + KEY_STEP
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : null;
        if (next === null) return;
        event.preventDefault();
        onChange(clamp(next));
      }}
    />
  );
}
