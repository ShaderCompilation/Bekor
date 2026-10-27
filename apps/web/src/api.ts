import { ApiError, createApiClient } from "@bekor/api-client";

// Same-origin: Vite proxies /api and /auth in development; production serves both from one origin.
export const api = createApiClient({ baseUrl: window.location.origin });
export type Api = typeof api;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** Better Auth is browser-only (cookie sessions), so its few calls live here, not in the shared client. */
async function authRequest<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the server. Check your connection.");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = (payload ?? {}) as { code?: unknown; message?: unknown };
    const message =
      response.status === 429
        ? "Too many attempts. Wait a minute and try again."
        : typeof details.message === "string"
          ? details.message
          : "The request failed.";
    throw new ApiError(
      response.status,
      typeof details.code === "string" ? details.code : "AUTH_FAILED",
      message,
    );
  }
  return payload as T;
}

export const auth = {
  async session(): Promise<SessionUser | null> {
    const data = await authRequest<{ user?: SessionUser } | null>("/get-session");
    const user = data?.user;
    return user ? { id: user.id, email: user.email, name: user.name } : null;
  },
  signIn: (email: string, password: string) =>
    authRequest<unknown>("/sign-in/email", { email, password }),
  signUp: (name: string, email: string, password: string) =>
    authRequest<unknown>("/sign-up/email", { name, email, password }),
  signOut: () => authRequest<unknown>("/sign-out", {}),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Cannot reach the server. Check your connection.";
  return "Something went wrong.";
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiError ? error.code : undefined;
}

export { ApiError };
