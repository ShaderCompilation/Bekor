import {
  type AssistanceKind,
  completionSchema,
  conceptListSchema,
  credentialSchema,
  downloadSchema,
  errorSchema,
  type Language,
  type Pagination,
  type ProblemListQuery,
  pageSchema,
  practiceSessionSchema,
  problemSummarySchema,
  publicExerciseSchema,
  type Rating,
  revealSchema,
  reviewQueueSchema,
  type SessionStart,
  type Settings,
  type SubmissionCreate,
  settingsSchema,
  submissionSchema,
  type TokenCreate,
  tokenCreatedSchema,
} from "@bekor/contracts";
import { z } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

/** Shared browser/CLI transport. The caller controls persistence and polling. */
export function createApiClient(options: ClientOptions) {
  const origin = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Expected an HTTP(S) API origin without credentials, path, query or fragment.");
  }
  const base = `${origin.href.replace(/\/$/, "")}/api/v1`;
  const transport = options.fetch ?? globalThis.fetch;
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await transport(`${base}${path}`, {
      method,
      credentials: "include",
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204 && response.ok) return schema.parse(undefined);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        "The API returned an invalid response.",
      );
    }
    if (!response.ok) {
      const parsed = errorSchema.safeParse(payload);
      if (parsed.success) {
        const { code, message, requestId } = parsed.data.error;
        throw new ApiError(response.status, code, message, requestId);
      }
      throw new ApiError(response.status, "REQUEST_FAILED", "The API request failed.");
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success)
      throw new ApiError(
        response.status,
        "INVALID_RESPONSE",
        "The API returned an incompatible response.",
      );
    return parsed.data;
  }
  function query(values: Record<string, string | number | undefined>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
      if (value !== undefined) params.set(key, String(value));
    return params.size ? `?${params}` : "";
  }
  const segment = encodeURIComponent;
  return {
    problems: ({ ids, ...filters }: Partial<ProblemListQuery> = {}) =>
      request(
        `/problems${query({ ...filters, ids: ids?.join(",") })}`,
        pageSchema(problemSummarySchema),
      ),
    concepts: () => request("/concepts", conceptListSchema),
    problem: (slug: string, version?: string) =>
      request(`/problems/${segment(slug)}${query({ version })}`, publicExerciseSchema),
    download: (slug: string, language: Language, version?: string) =>
      request(`/problems/${segment(slug)}/download${query({ language, version })}`, downloadSchema),
    submit: (input: SubmissionCreate) => request("/submissions", submissionSchema, "POST", input),
    submission: (id: string) => request(`/submissions/${segment(id)}`, submissionSchema),
    submissions: (pagination: Partial<Pagination> = {}) =>
      request(`/me/submissions${query(pagination)}`, pageSchema(submissionSchema)),
    createToken: (input: TokenCreate) => request("/me/tokens", tokenCreatedSchema, "POST", input),
    tokens: () => request("/me/tokens", z.object({ items: z.array(credentialSchema) })),
    revokeToken: (id: string) => request(`/me/tokens/${segment(id)}`, z.undefined(), "DELETE"),
    settings: () => request("/me/settings", settingsSchema),
    updateSettings: (input: Settings) => request("/me/settings", settingsSchema, "PATCH", input),
    reviews: () => request("/me/reviews", reviewQueueSchema),
    startSession: (input: SessionStart) =>
      request("/practice-sessions", practiceSessionSchema, "POST", input),
    assistance: (id: string, kind: AssistanceKind) =>
      request(`/practice-sessions/${segment(id)}/assistance`, practiceSessionSchema, "POST", {
        kind,
      }),
    reveal: (id: string) =>
      request(`/practice-sessions/${segment(id)}/reveal`, revealSchema, "POST", {}),
    completeSession: (id: string, rating: Rating) =>
      request(`/practice-sessions/${segment(id)}/complete`, completionSchema, "POST", { rating }),
  };
}
