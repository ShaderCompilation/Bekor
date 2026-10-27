import type { Language } from "@bekor/contracts";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import type { SessionUser } from "./api";
import { ErrorNotice, PageLoading } from "./components/ui";
import { SignInPage, SignUpPage } from "./pages/Auth";
import { CatalogPage } from "./pages/Catalog";
import { HistoryPage, SubmissionPage } from "./pages/History";
import { Layout, NotFound } from "./pages/Layout";
import { ProblemPage } from "./pages/Problem";
import { ReviewsPage } from "./pages/Reviews";
import { SettingsPage } from "./pages/Settings";
import {
  problemQuery,
  problemsQuery,
  reviewsQuery,
  sessionQuery,
  settingsQuery,
  tokensQuery,
} from "./queries";

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  // Every route knows the (possibly anonymous) user; the session itself is server state.
  beforeLoad: async ({ context }) => ({
    user: await context.queryClient.ensureQueryData(sessionQuery),
  }),
  component: Layout,
  notFoundComponent: NotFound,
  errorComponent: ({ error }) => <ErrorNotice error={error} />,
  pendingComponent: PageLoading,
});

/** Only same-site relative paths are accepted as post-login destinations. */
export function safeRedirect(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    return { user: context.user as SessionUser };
  },
});

const difficulties = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof difficulties)[number];
export interface CatalogSearch {
  q?: string;
  difficulty?: Difficulty;
  concept?: string;
}

const catalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search: Record<string, unknown>): CatalogSearch => ({
    ...(typeof search.q === "string" && search.q ? { q: search.q.slice(0, 100) } : {}),
    ...(difficulties.includes(search.difficulty as Difficulty)
      ? { difficulty: search.difficulty as Difficulty }
      : {}),
    ...(typeof search.concept === "string" && search.concept
      ? { concept: search.concept.slice(0, 80) }
      : {}),
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(problemsQuery),
  component: CatalogPage,
});

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: safeRedirect(search.redirect) } : {},
  beforeLoad: ({ context, search }) => {
    if (context.user) throw redirect({ to: safeRedirect(search.redirect) });
  },
  component: SignInPage,
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-up",
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: "/" });
  },
  component: SignUpPage,
});

export interface ProblemSearch {
  language?: Language;
  session?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const problemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/problems/$slug",
  validateSearch: (search: Record<string, unknown>): ProblemSearch => ({
    ...(search.language === "javascript" || search.language === "typescript"
      ? { language: search.language }
      : {}),
    ...(typeof search.session === "string" && UUID.test(search.session)
      ? { session: search.session.toLowerCase() }
      : {}),
  }),
  loaderDeps: ({ search }) => ({ session: search.session }),
  loader: async ({ context, params, deps }) => {
    const user = context.user;
    await Promise.all([
      context.queryClient.ensureQueryData(problemQuery(params.slug)),
      user && deps.session ? context.queryClient.ensureQueryData(reviewsQuery(user.id)) : null,
    ]);
  },
  component: ProblemPage,
});

const reviewsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/reviews",
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(reviewsQuery(context.user.id)),
      context.queryClient.ensureQueryData(problemsQuery),
    ]),
  component: ReviewsPage,
});

const historyRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/history",
  component: HistoryPage,
});

const submissionRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/submissions/$id",
  params: {
    parse: (params) => {
      if (!UUID.test(params.id)) throw new Error("Invalid submission id");
      return { id: params.id.toLowerCase() };
    },
    stringify: (params) => params,
  },
  component: SubmissionPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "/settings",
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(settingsQuery(context.user.id)),
      context.queryClient.ensureQueryData(tokensQuery(context.user.id)),
    ]),
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  catalogRoute,
  signInRoute,
  signUpRoute,
  problemRoute,
  authedRoute.addChildren([reviewsRoute, historyRoute, submissionRoute, settingsRoute]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Query owns caching; let loaders run every navigation and rely on staleTime.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
