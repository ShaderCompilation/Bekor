import { type ReactNode, useId, useRef } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  content: ReactNode;
}

/** Tabs with automatic activation and a roving tabindex (arrows, Home, End). */
export function Tabs<T extends string>({
  label,
  tabs,
  selected,
  onSelect,
  className = "",
}: {
  label: string;
  tabs: TabItem<T>[];
  selected: T;
  onSelect: (id: T) => void;
  className?: string;
}) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const current = tabs.some((tab) => tab.id === selected) ? selected : tabs[0]?.id;
  const focusTab = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    onSelect(tab.id);
    list.current?.querySelector<HTMLElement>(`[data-tab="${tab.id}"]`)?.focus();
  };
  return (
    <div className={`tabs ${className}`}>
      <div ref={list} role="tablist" aria-label={label} className="tab-list">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab={tab.id}
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === current}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === current ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => {
              const moves: Record<string, number> = {
                ArrowRight: index + 1,
                ArrowLeft: index - 1,
                Home: 0,
                End: tabs.length - 1,
              };
              const target = moves[event.key];
              if (target === undefined) return;
              event.preventDefault();
              focusTab(target);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={tab.id !== current}
          className="tab-panel"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: tab panels are focusable per WAI-ARIA
          tabIndex={0}
        >
          {tab.id === current && tab.content}
        </div>
      ))}
    </div>
  );
}
