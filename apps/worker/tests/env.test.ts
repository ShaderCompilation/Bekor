import { describe, expect, it } from "vitest";
import { EnvironmentError as ApiEnvironmentError, loadApiEnv } from "../../api/src/env.js";
import { EnvironmentError, loadWorkerEnv } from "../src/env.js";

const secret = "s".repeat(32);
const api = {
  DATABASE_URL: "postgresql://bekor:pw@127.0.0.1:5432/bekor",
  API_ORIGIN: "http://localhost:3000",
  BETTER_AUTH_SECRET: secret,
};

function problems(load: () => unknown): string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ApiEnvironmentError || error instanceof EnvironmentError)
      return error.problems;
    throw error;
  }
  throw new Error("expected environment validation to fail");
}

describe("API environment validation", () => {
  it("parses a valid development environment with defaults", () => {
    expect(loadApiEnv(api)).toEqual({
      nodeEnv: "development",
      port: 3000,
      apiOrigin: "http://localhost:3000",
      databaseUrl: api.DATABASE_URL,
      betterAuthSecret: secret,
      registrationEnabled: false,
    });
    expect(loadApiEnv({ ...api, PORT: "8080", REGISTRATION_ENABLED: "true" })).toMatchObject({
      port: 8080,
      registrationEnabled: true,
    });
  });

  it("lists every missing or invalid variable in one error, treating empty values as unset", () => {
    const list = problems(() =>
      loadApiEnv({ BETTER_AUTH_SECRET: "", PORT: "70000", REGISTRATION_ENABLED: "yes" }),
    );
    expect(list).toEqual(
      expect.arrayContaining([
        "DATABASE_URL is required",
        "API_ORIGIN is required",
        "BETTER_AUTH_SECRET is required",
        "PORT must be an integer between 1 and 65535",
        "REGISTRATION_ENABLED must be true or false",
      ]),
    );
    expect(list).toHaveLength(5);
  });

  it("rejects short secrets, non-postgres URLs and origins with paths, without echoing values", () => {
    let message = "";
    try {
      loadApiEnv({
        ...api,
        BETTER_AUTH_SECRET: "short-secret-value",
        DATABASE_URL: "mysql://x/y",
        API_ORIGIN: "http://localhost:3000/app",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("BETTER_AUTH_SECRET must be at least 32 characters");
    expect(message).toContain("DATABASE_URL must be a postgres:// or postgresql:// URL");
    expect(message).toContain("API_ORIGIN must be an http(s) origin");
    expect(message).not.toContain("short-secret-value");
    expect(message).not.toContain("mysql://");
  });

  it("requires an https origin in production", () => {
    expect(problems(() => loadApiEnv({ ...api, NODE_ENV: "production" }))).toEqual([
      "API_ORIGIN must use https:// when NODE_ENV=production",
    ]);
    expect(
      loadApiEnv({ ...api, NODE_ENV: "production", API_ORIGIN: "https://bekor.example" }).apiOrigin,
    ).toBe("https://bekor.example");
  });
});

describe("worker environment validation", () => {
  const worker = { DATABASE_URL: api.DATABASE_URL, JUDGE0_URL: "http://judge0-server:2358" };

  it("parses required and optional variables", () => {
    expect(loadWorkerEnv(worker)).toEqual({
      nodeEnv: "development",
      databaseUrl: api.DATABASE_URL,
      runner: { kind: "judge0", url: worker.JUDGE0_URL },
      healthHost: "127.0.0.1",
    });
    expect(
      loadWorkerEnv({ ...worker, JUDGE0_AUTH_TOKEN: "t", WORKER_HEALTH_PORT: "3001" }),
    ).toMatchObject({ runner: { authToken: "t" }, healthPort: 3001 });
  });

  it("selects the development Podman runner without JUDGE0_URL, never in production", () => {
    expect(loadWorkerEnv({ DATABASE_URL: api.DATABASE_URL, RUNNER: "podman" }).runner).toEqual({
      kind: "podman",
    });
    expect(
      loadWorkerEnv({ DATABASE_URL: api.DATABASE_URL, RUNNER: "podman", PODMAN_RUNNER_IMAGE: "x" })
        .runner,
    ).toEqual({ kind: "podman", image: "x" });
    expect(
      problems(() =>
        loadWorkerEnv({ DATABASE_URL: api.DATABASE_URL, RUNNER: "podman", NODE_ENV: "production" }),
      ),
    ).toEqual(["RUNNER=podman is development-only and not allowed when NODE_ENV=production"]);
    expect(problems(() => loadWorkerEnv({ ...worker, RUNNER: "docker" }))).toEqual([
      "RUNNER must be judge0 or podman",
    ]);
  });

  it("fails clearly when the runner or database is missing", () => {
    const list = problems(() => loadWorkerEnv({ JUDGE0_URL: "", WORKER_HEALTH_PORT: "0" }));
    expect(list).toHaveLength(3);
    expect(list[0]).toBe("DATABASE_URL is required");
    expect(list.join("\n")).toContain("JUDGE0_URL is required");
    expect(list).toContain("WORKER_HEALTH_PORT must be an integer between 1 and 65535");
  });

  it("rejects runner URLs with credentials, queries or non-http schemes", () => {
    for (const JUDGE0_URL of [
      "http://user:pass@judge0:2358",
      "http://judge0:2358/?token=x",
      "ftp://judge0",
      "not a url",
    ]) {
      const list = problems(() => loadWorkerEnv({ ...worker, JUDGE0_URL }));
      expect(list).toEqual([
        "JUDGE0_URL must be an http(s) URL without credentials, query or fragment",
      ]);
    }
  });
});
