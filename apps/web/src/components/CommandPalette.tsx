import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { type GlobalDialog, useDialogs } from "../stores/dialogs";
import { usePreferences } from "../stores/preferences";
import { Badge } from "./ui";

const SEARCH_DELAY_MS = 150;
const RESULT_LIMIT = 8;

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
    Boolean(element.closest(".monaco-editor"))
  );
}

/** Global Ctrl/Cmd+K problem search and `?` shortcut help. Both use native modal dialogs. */
export function GlobalDialogs({ signedIn }: { signedIn: boolean }) {
  const palette = useRef<HTMLDialogElement>(null);
  const help = useRef<HTMLDialogElement>(null);
  const open = useDialogs((state) => state.open);
  const show = useDialogs((state) => state.show);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = useDialogs.getState().open;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        show(current === "palette" ? null : "palette");
      } else if (event.key === "?" && !isTyping(event.target) && current === null) {
        event.preventDefault();
        show("help");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show]);

  // Keep the native dialogs in step with the store (showModal gives focus trapping and Esc).
  useEffect(() => {
    for (const [name, element] of [
      ["palette", palette.current],
      ["help", help.current],
    ] as const) {
      if (!element) continue;
      if (open === name && !element.open) element.showModal();
      if (open !== name && element.open) element.close();
    }
  }, [open]);
  const onClose = (name: GlobalDialog) => () => {
    if (useDialogs.getState().open === name) show(null);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click; Esc closes natively */}
      <dialog
        ref={palette}
        className="dialog palette-dialog"
        aria-label="Search problems and pages"
        onClose={onClose("palette")}
        onClick={(event) => {
          if (event.target === palette.current) show(null);
        }}
      >
        {open === "palette" && <Palette signedIn={signedIn} onDone={() => show(null)} />}
      </dialog>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click; Esc closes natively */}
      <dialog
        ref={help}
        className="dialog"
        aria-labelledby="shortcuts-title"
        onClose={onClose("help")}
        onClick={(event) => {
          if (event.target === help.current) show(null);
        }}
      >
        <div className="dialog-body">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <dl className="shortcuts">
            <dt>
              <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd>
            </dt>
            <dd>Search problems and pages</dd>
            <dt>
              <kbd>?</kbd>
            </dt>
            <dd>Show this help</dd>
            <dt>
              <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Enter</kbd>
            </dt>
            <dd>Run public tests (in the editor)</dd>
            <dt>
              <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd>
            </dt>
            <dd>Submit solution (in the editor)</dd>
            <dt>
              <kbd>Ctrl</kbd> + <kbd>M</kbd>
            </dt>
            <dd>Toggle whether Tab moves focus out of the editor</dd>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>Close dialogs and menus</dd>
          </dl>
          <form method="dialog">
            <button type="submit">Close</button>
          </form>
        </div>
      </dialog>
    </>
  );
}

function Palette({ signedIn, onDone }: { signedIn: boolean; onDone: () => void }) {
  const navigate = useNavigate();
  const setTheme = usePreferences((state) => state.setTheme);
  const listId = useId();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const problems = useQuery({
    queryKey: ["problems", "palette", query],
    queryFn: async () => (await api.problems({ q: query, limit: RESULT_LIMIT })).items,
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  const go = (to: string) => () => {
    onDone();
    void navigate({ to });
  };
  const pages: Command[] = [
    { id: "problems", label: "Go to Problems", run: go("/problems") },
    ...(signedIn ? [{ id: "home", label: "Go to Dashboard", run: go("/") }] : []),
    ...(signedIn
      ? [
          { id: "reviews", label: "Go to Reviews", run: go("/reviews") },
          { id: "history", label: "Go to History", run: go("/history") },
          { id: "settings", label: "Go to Settings", run: go("/settings") },
        ]
      : [{ id: "sign-in", label: "Sign in", run: go("/sign-in") }]),
    ...(["light", "dark", "system"] as const).map((theme) => ({
      id: `theme-${theme}`,
      label: `Use ${theme} theme`,
      run: () => {
        setTheme(theme);
        onDone();
      },
    })),
  ];
  const lower = query.toLowerCase();
  const commands: Command[] = [
    ...(query ? (problems.data ?? []) : []).map((problem) => ({
      id: `problem-${problem.id}`,
      label: problem.title,
      hint: problem.difficulty,
      run: () => {
        onDone();
        void navigate({ to: "/problems/$slug", params: { slug: problem.slug } });
      },
    })),
    ...pages.filter((command) => !lower || command.label.toLowerCase().includes(lower)),
  ];
  const optionId = (index: number) => `${listId}-${index}`;
  const current = Math.min(active, commands.length - 1);

  return (
    <div className="palette">
      <input
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={current >= 0 ? optionId(current) : undefined}
        aria-label="Search problems and pages"
        placeholder="Search problems or jump to a page…"
        value={text}
        // biome-ignore lint/a11y/noAutofocus: the dialog exists to type into this field
        autoFocus
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current + step + commands.length) % Math.max(commands.length, 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            commands[current]?.run();
          }
        }}
      />
      <div id={listId} role="listbox" className="palette-list" aria-label="Results">
        {commands.map((command, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: options are keyboard-operated from the combobox input
          <div
            key={command.id}
            id={optionId(index)}
            role="option"
            tabIndex={-1}
            aria-selected={index === current}
            className="palette-option"
            onPointerMove={() => setActive(index)}
            onClick={command.run}
          >
            <span>{command.label}</span>
            {command.hint && <Badge tone={command.hint}>{command.hint}</Badge>}
          </div>
        ))}
        {commands.length === 0 && (
          <p className="palette-empty muted">{problems.isFetching ? "Searching…" : "No matches"}</p>
        )}
      </div>
      <p className="palette-footer muted small">
        <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
      </p>
    </div>
  );
}
