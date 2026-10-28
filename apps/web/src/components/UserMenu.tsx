import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import type { SessionUser } from "../api";

const menuItems = (menu: HTMLElement | null) => [
  ...(menu?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
];

function initials(user: SessionUser) {
  const source = (user.name || user.email).trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Menu button pattern: Enter/Space/ArrowDown open, arrows move, Escape closes and returns focus. */
export function UserMenu({
  user,
  onSignOut,
  signingOut,
}: {
  user: SessionUser;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuItems(menu.current)[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const onMenuKey = (event: React.KeyboardEvent) => {
    const list = menuItems(menu.current);
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? list[0] : list.at(-1))?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className="user-menu">
      <button
        ref={button}
        type="button"
        className="user-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="avatar" aria-hidden="true">
          {initials(user)}
        </span>
        <span className="user-menu-name">{user.name || user.email}</span>
        <span className="visually-hidden"> account menu</span>
      </button>
      {open && (
        <div ref={menu} id={id} role="menu" className="menu" onKeyDown={onMenuKey} tabIndex={-1}>
          <p className="menu-caption muted" title={user.email}>
            {user.email}
          </p>
          <Link to="/history" role="menuitem" tabIndex={-1} onClick={() => close(false)}>
            History
          </Link>
          <Link to="/settings" role="menuitem" tabIndex={-1} onClick={() => close(false)}>
            Settings
          </Link>
          <hr />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={signingOut}
            onClick={() => {
              close(false);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
