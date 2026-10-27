import { createServer, type Server } from "node:http";
import { createQueue, JUDGE_QUEUE } from "@bekor/core";
import { createDatabase } from "@bekor/db";
import { Judge0Adapter, PODMAN_RUNNER_IMAGE, PodmanAdapter } from "@bekor/runner";
import { EnvironmentError, loadWorkerEnv } from "./env.js";
import { createProcessor } from "./processor.js";
import { createWorkerRepository } from "./repository.js";

let env: ReturnType<typeof loadWorkerEnv>;
try {
  env = loadWorkerEnv();
} catch (error) {
  if (!(error instanceof EnvironmentError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

const database = createDatabase(env.databaseUrl);
const repository = createWorkerRepository(database);
const runner =
  env.runner.kind === "podman"
    ? new PodmanAdapter(env.runner.image ? { image: env.runner.image } : {})
    : new Judge0Adapter({
        url: env.runner.url,
        ...(env.runner.authToken ? { authToken: env.runner.authToken } : {}),
      });
const runnerSummary =
  env.runner.kind === "podman"
    ? `podman(dev-only) image=${env.runner.image ?? PODMAN_RUNNER_IMAGE}`
    : `${new URL(env.runner.url).origin} runnerToken=${env.runner.authToken ? "set" : "unset"}`;
const boss = await createQueue(env.databaseUrl);
const processSubmission = createProcessor({ repository, runner });
await boss.work<{ submissionId: string }>(
  JUDGE_QUEUE,
  { batchSize: 1, pollingIntervalSeconds: 1 },
  async (jobs) => {
    for (const job of jobs) {
      if (
        typeof job.data?.submissionId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(job.data.submissionId)
      )
        throw new Error("Invalid submission job.");
      await processSubmission(job.data.submissionId);
    }
  },
);
let recovering = false;
async function recover() {
  if (recovering) return;
  recovering = true;
  try {
    for (const submissionId of await repository.recoverable())
      await boss.send(
        JUDGE_QUEUE,
        { submissionId },
        { singletonKey: `recovery:${submissionId}`, singletonSeconds: 60 },
      );
  } catch {
    process.stderr.write("Judging recovery infrastructure error\n");
  } finally {
    recovering = false;
  }
}
await recover();
const recovery = setInterval(() => void recover(), 30_000);

let stopping = false;
// Liveness/readiness only: reports queue process state and database reachability, never config.
let health: Server | undefined;
if (env.healthPort) {
  health = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    database.pool
      .query("select 1")
      .then(() => !stopping)
      .catch(() => false)
      .then((ok) => {
        response
          .writeHead(ok ? 200 : 503, { "Content-Type": "application/json" })
          .end(JSON.stringify({ status: ok ? "ok" : "unavailable" }));
      });
  });
  health.listen(env.healthPort, env.healthHost);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(recovery);
  health?.close();
  await boss.stop({ graceful: true, timeout: 160_000 });
  await database.close();
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

// Only non-secret facts: the runner origin (credentials are rejected by env validation) and whether a token is set.
process.stdout.write(
  `Judging worker started: queue=${JUDGE_QUEUE} runner=${runnerSummary} health=${env.healthPort ? `${env.healthHost}:${env.healthPort}` : "disabled"}\n`,
);
