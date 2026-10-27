import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
import { auth } from "../api";
import { reviewsQuery } from "../queries";

const root = getRouteApi("__root__");

export function Layout() {
  const { user } = root.useRouteContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
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
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link to="/" className="brand">
          Bekor
        </Link>
        <nav aria-label="Main">
          <Link to="/" activeOptions={{ exact: true, includeSearch: false }}>
            Problems
          </Link>
          {user && (
            <>
              <Link to="/reviews">
                Reviews
                {dueCount > 0 && (
                  <span className="count">
                    {dueCount}
                    <span className="visually-hidden"> due</span>
                  </span>
                )}
              </Link>
              <Link to="/history">History</Link>
              <Link to="/settings">Settings</Link>
            </>
          )}
        </nav>
        <div className="account">
          {user ? (
            <>
              <span className="muted" title={user.email}>
                {user.name || user.email}
              </span>
              <button
                type="button"
                className="link-button"
                onClick={() => signOut.mutate()}
                disabled={signOut.isPending}
              >
                Sign out
              </button>
            </>
          ) : (
            <Link to="/sign-in">Sign in</Link>
          )}
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}

export function NotFound() {
  return (
    <div className="empty">
      <h1>Page not found</h1>
      <Link to="/">Back to problems</Link>
    </div>
  );
}
