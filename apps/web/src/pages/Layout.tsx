import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { auth } from "../api";
import { GlobalDialogs } from "../components/CommandPalette";
import { ThemeToggle } from "../components/ThemeToggle";
import { Toaster } from "../components/Toaster";
import { UserMenu } from "../components/UserMenu";
import { reviewsQuery } from "../queries";
import { useDialogs } from "../stores/dialogs";
import { usePreferences } from "../stores/preferences";

const root = getRouteApi("__root__");

/** Applies an explicit theme choice to <html>; "system" leaves CSS to follow the OS. */
function useThemeAttribute() {
  const theme = usePreferences((state) => state.theme);
  useEffect(() => {
    const html = document.documentElement;
    if (theme === "system") delete html.dataset.theme;
    else html.dataset.theme = theme;
  }, [theme]);
}

export function Layout() {
  const { user } = root.useRouteContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  useThemeAttribute();
  const showDialog = useDialogs((state) => state.show);
  const reviews = useQuery({ ...reviewsQuery(user?.id ?? ""), enabled: Boolean(user) });
  const dueCount = reviews.data
    ? reviews.data.due.filter((card) => Date.parse(card.due) <= Date.now()).length
    : 0;

  const signOut = useMutation({
    mutationFn: () => auth.signOut(),
    onSettled: async () => {
      // Drop every cached private response before the next render.
      queryClient.clear();
      await router.invalidate();
      await navigate({ to: "/" });
    },
  });

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            b
          </span>
          Bekor
        </Link>
        <nav aria-label="Main">
          {user && (
            <Link to="/" activeOptions={{ exact: true, includeSearch: false }}>
              Dashboard
            </Link>
          )}
          <Link to="/problems" activeOptions={{ includeSearch: false }}>
            Problems
          </Link>
          {user && (
            <Link to="/reviews">
              Reviews
              {dueCount > 0 && (
                <span className="count">
                  {dueCount}
                  <span className="visually-hidden"> due</span>
                </span>
              )}
            </Link>
          )}
        </nav>
        <div className="account">
          <button
            type="button"
            className="search-trigger"
            onClick={() => showDialog("palette")}
            aria-label="Search problems (Ctrl+K)"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <span className="search-trigger-text">Search</span>
            <kbd>Ctrl K</kbd>
          </button>
          <ThemeToggle />
          {user ? (
            <UserMenu
              user={user}
              onSignOut={() => signOut.mutate()}
              signingOut={signOut.isPending}
            />
          ) : (
            <>
              <Link to="/sign-in">Sign in</Link>
              <Link to="/sign-up" className="button primary">
                Sign up
              </Link>
            </>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="site-footer">
        <span>Bekor · practice, then remember with spaced repetition</span>
        <nav aria-label="Footer">
          <Link to="/problems">Problems</Link>
          {user && <Link to="/reviews">Reviews</Link>}
          <button type="button" className="link-button" onClick={() => showDialog("help")}>
            Keyboard shortcuts
          </button>
        </nav>
      </footer>
      <Toaster />
      <GlobalDialogs signedIn={Boolean(user)} />
    </div>
  );
}

export function NotFound() {
  return (
    <div className="page not-found">
      <p className="not-found-code" aria-hidden="true">
        404
      </p>
      <h1>Page not found</h1>
      <p className="muted">The page may have moved, or the link is mistyped.</p>
      <div className="button-row">
        <Link to="/problems" className="button primary">
          Browse problems
        </Link>
      </div>
    </div>
  );
}
