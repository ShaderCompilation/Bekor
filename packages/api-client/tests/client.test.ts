import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "../src/index.js";

describe("shared HTTP client", () => {
  it("uses the versioned API, cookie credentials and scoped token without following redirects", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    const client = createApiClient({
      baseUrl: "https://bekor.test",
      token: "test-secret",
      fetch: transport,
    });
    expect(await client.problems({ limit: 5, cursor: "a&b" })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(transport).toHaveBeenCalledWith(
      "https://bekor.test/api/v1/problems?limit=5&cursor=a%26b",
      expect.objectContaining({
        credentials: "include",
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer test-secret" }),
      }),
    );
  });
  it("preserves stable API errors without reflecting an HTML response", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "NOT_FOUND", message: "Submission not found.", requestId: "req-1" } },
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(new Response("<secret>", { status: 502 }));
    const client = createApiClient({ baseUrl: "https://bekor.test", fetch: transport });
    await expect(client.submission("id")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      requestId: "req-1",
    });
    await expect(client.submission("id")).rejects.toThrow("The API returned an invalid response.");
  });
  it("rejects incompatible success DTOs", async () => {
    const client = createApiClient({
      baseUrl: "https://bekor.test",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: "wrong" })),
    });
    await expect(client.problems()).rejects.toBeInstanceOf(ApiError);
  });
  it("handles token revocation with an empty 204 response", async () => {
    const client = createApiClient({
      baseUrl: "https://bekor.test",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })),
    });
    expect(await client.revokeToken("id")).toBeUndefined();
  });
});
