import { randomUUID } from "node:crypto";
import {
  assistanceSchema,
  completionSchema,
  conceptListSchema,
  credentialSchema,
  downloadSchema,
  errorSchema,
  exerciseDetailSchema,
  frameworkSchema,
  languageSchema,
  pageSchema,
  paginationSchema,
  practiceSessionSchema,
  problemListQuerySchema,
  problemSummarySchema,
  revealSchema,
  reviewQueueSchema,
  sessionCompleteSchema,
  sessionStartSchema,
  settingsSchema,
  submissionCreateSchema,
  submissionSchema,
  type TokenScope,
  tokenCreatedSchema,
  tokenCreateSchema,
} from "@bekor/contracts";
import {
  type CatalogService,
  type createSettingsService,
  type createTokenService,
  type ReviewService,
  ServiceError,
  type SubmissionService,
} from "@bekor/core";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { Auth } from "./auth.js";

type Principal = { userId: string; kind: "cookie" | "token"; scopes: string[] };
type Env = { Variables: { requestId: string; principal: Principal } };
export interface AppDependencies {
  origin: string;
  auth: Pick<Auth, "handler" | "api">;
  catalog: CatalogService;
  submissions: SubmissionService;
  tokens: ReturnType<typeof createTokenService>;
  settings: ReturnType<typeof createSettingsService>;
  reviews: ReviewService;
  health: () => Promise<void>;
}
const json = <T extends z.ZodType>(schema: T, description = "Success") => ({
  description,
  content: { "application/json": { schema } },
});
const failures = {
  400: json(errorSchema, "Invalid request"),
  401: json(errorSchema, "Unauthenticated"),
  403: json(errorSchema, "Forbidden"),
  404: json(errorSchema, "Not found"),
  409: json(errorSchema, "Conflict"),
  410: json(errorSchema, "Retired exercise"),
  429: json(errorSchema, "Rate limited"),
  503: json(errorSchema, "Unavailable"),
};
const uuidParam = z.object({ id: z.uuid() });
export function createApp(deps: AppDependencies) {
  const origin = new URL(deps.origin).origin;
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        throw new ServiceError(
          "INVALID_INPUT",
          c.req.path === "/api/v1/submissions"
            ? "Node submissions require solution.js or solution.ts. DOM exercises use browser preview and explicit self-assessment."
            : "Invalid request fields.",
        );
    },
  });
  app.use("*", async (c, next) => {
    const id = randomUUID();
    c.set("requestId", id);
    c.header("X-Request-Id", id);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 100_000,
      onError: () => {
        throw new HTTPException(413);
      },
    }),
  );
  app.onError((error, c) => {
    if (error instanceof ServiceError)
      return c.json(
        { error: { code: error.code, message: error.message, requestId: c.get("requestId") } },
        error.status,
      );
    if (error instanceof HTTPException)
      return c.json(
        {
          error: {
            code: error.status === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
            message: error.status === 413 ? "Request body exceeds the limit." : "Invalid request.",
            requestId: c.get("requestId"),
          },
        },
        error.status,
      );
    return c.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred.",
          requestId: c.get("requestId"),
        },
      },
      500,
    );
  });
  app.notFound((c) =>
    c.json(
      {
        error: { code: "NOT_FOUND", message: "Endpoint not found.", requestId: c.get("requestId") },
      },
      404,
    ),
  );
  app.all("/auth/*", (c) => deps.auth.handler(c.req.raw));
  app.get("/health", async (c) => {
    try {
      await deps.health();
      return c.json({ status: "ok" });
    } catch {
      throw new ServiceError("UNAVAILABLE", "Database unavailable.", 503);
    }
  });
  app.use("/api/v1/*", async (c, next) => {
    if (
      c.req.method === "GET" &&
      (c.req.path === "/api/v1/problems" ||
        c.req.path === "/api/v1/concepts" ||
        c.req.path.startsWith("/api/v1/problems/") ||
        c.req.path === "/api/v1/openapi.json")
    )
      return next();
    const authorization = c.req.header("Authorization");
    let principal: Principal | null = null;
    if (authorization) {
      const secret = /^Bearer (\S+)$/.exec(authorization)?.[1];
      const token = secret ? await deps.tokens.authenticate(secret) : null;
      if (token) principal = { ...token, kind: "token" };
    } else {
      const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
      if (session) principal = { userId: session.user.id, kind: "cookie", scopes: [] };
    }
    if (!principal) throw new ServiceError("UNAUTHENTICATED", "Sign in required.", 401);
    if (
      principal.kind === "cookie" &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      c.req.header("Origin") !== origin
    )
      throw new ServiceError("FORBIDDEN_ORIGIN", "A matching Origin header is required.", 403);
    c.set("principal", principal);
    await next();
  });
  function authorize(principal: Principal, scope?: TokenScope, cookieOnly = false) {
    if (principal.kind === "token" && (cookieOnly || (scope && !principal.scopes.includes(scope))))
      throw new ServiceError("FORBIDDEN", "Credential does not allow this operation.", 403);
    return principal.userId;
  }
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/problems",
      request: { query: problemListQuerySchema },
      responses: { 200: json(pageSchema(problemSummarySchema)), ...failures },
    }),
    async (c) => c.json(await deps.catalog.list(c.req.valid("query")), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/concepts",
      responses: { 200: json(conceptListSchema), ...failures },
    }),
    async (c) => c.json(await deps.catalog.concepts(), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/problems/{slug}",
      request: {
        params: z.object({ slug: z.string().max(80) }),
        query: z.object({ version: z.string().max(40).optional() }),
      },
      responses: { 200: json(exerciseDetailSchema), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.catalog.detail(c.req.valid("param").slug, c.req.valid("query").version),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/problems/{slug}/download",
      request: {
        params: z.object({ slug: z.string().max(80) }),
        query: z.object({
          version: z.string().max(40).optional(),
          language: languageSchema,
          framework: frameworkSchema.optional(),
        }),
      },
      responses: { 200: json(downloadSchema), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.catalog.download(
          c.req.valid("param").slug,
          c.req.valid("query").language,
          origin,
          c.req.valid("query").version,
          c.req.valid("query").framework,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/submissions",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: submissionCreateSchema } },
        },
      },
      responses: { 202: json(submissionSchema, "Queued"), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.submissions.create(
          authorize(c.get("principal"), "submissions:write"),
          c.req.valid("json"),
        ),
        202,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/submissions/{id}",
      request: { params: uuidParam },
      responses: { 200: json(submissionSchema), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.submissions.get(
          authorize(c.get("principal"), "submissions:read"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/me/submissions",
      request: { query: paginationSchema },
      responses: { 200: json(pageSchema(submissionSchema)), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.submissions.history(
          authorize(c.get("principal"), "submissions:read"),
          c.req.valid("query"),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/me/tokens",
      request: {
        body: { required: true, content: { "application/json": { schema: tokenCreateSchema } } },
      },
      responses: { 201: json(tokenCreatedSchema), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.tokens.create(
          authorize(c.get("principal"), undefined, true),
          c.req.valid("json"),
        ),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/me/tokens",
      responses: { 200: json(z.object({ items: z.array(credentialSchema) })), ...failures },
    }),
    async (c) =>
      c.json(await deps.tokens.list(authorize(c.get("principal"), undefined, true)), 200),
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/me/tokens/{id}",
      request: { params: uuidParam },
      responses: { 204: { description: "Revoked" }, ...failures },
    }),
    async (c) => {
      await deps.tokens.revoke(
        authorize(c.get("principal"), undefined, true),
        c.req.valid("param").id,
      );
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/me/settings",
      responses: { 200: json(settingsSchema), ...failures },
    }),
    async (c) =>
      c.json(await deps.settings.get(authorize(c.get("principal"), "reviews:read")), 200),
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/me/settings",
      request: {
        body: { required: true, content: { "application/json": { schema: settingsSchema } } },
      },
      responses: { 200: json(settingsSchema), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.settings.update(
          authorize(c.get("principal"), "reviews:write"),
          c.req.valid("json"),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/me/reviews",
      responses: { 200: json(reviewQueueSchema), ...failures },
    }),
    async (c) =>
      c.json(await deps.reviews.queue(authorize(c.get("principal"), "reviews:read")), 200),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/practice-sessions",
      request: {
        body: { required: true, content: { "application/json": { schema: sessionStartSchema } } },
      },
      responses: { 200: json(practiceSessionSchema, "Started or resumed"), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.reviews.start(
          authorize(c.get("principal"), "reviews:write"),
          c.req.valid("json"),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/practice-sessions/{id}/assistance",
      request: {
        params: uuidParam,
        body: { required: true, content: { "application/json": { schema: assistanceSchema } } },
      },
      responses: { 200: json(practiceSessionSchema), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.reviews.assistance(
          authorize(c.get("principal"), "reviews:write"),
          c.req.valid("param").id,
          c.req.valid("json").kind,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/practice-sessions/{id}/reveal",
      request: {
        params: uuidParam,
        body: {
          required: true,
          content: { "application/json": { schema: z.object({}).strict() } },
        },
      },
      responses: { 200: json(revealSchema), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.reviews.reveal(
          authorize(c.get("principal"), "reviews:write"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/practice-sessions/{id}/complete",
      request: {
        params: uuidParam,
        body: {
          required: true,
          content: { "application/json": { schema: sessionCompleteSchema } },
        },
      },
      responses: { 200: json(completionSchema), ...failures },
    }),
    async (c) =>
      c.json(
        await deps.reviews.complete(
          authorize(c.get("principal"), "reviews:write"),
          c.req.valid("param").id,
          c.req.valid("json").rating,
          c.req.valid("json").selfAssessment,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/me/self-assessments",
      responses: { 200: json(z.object({ items: z.array(practiceSessionSchema) })), ...failures },
    }),
    async (c) =>
      c.json(await deps.reviews.history(authorize(c.get("principal"), "reviews:read")), 200),
  );
  app.doc("/api/v1/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Bekor API", version: "1.0.0" },
  });
  return app;
}
