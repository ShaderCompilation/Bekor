import {
  createCatalogService,
  createProgressService,
  createQueue,
  createReviewService,
  createSettingsService,
  createSubmissionService,
  createTokenService,
} from "@bekor/core";
import { createDatabase } from "@bekor/db";
import { serve } from "@hono/node-server";
import { createAuth } from "./auth.js";
import { type ApiEnv, EnvironmentError, loadApiEnv } from "./env.js";
import { createApp } from "./index.js";

let env: ApiEnv;
try {
  env = loadApiEnv();
} catch (error) {
  if (!(error instanceof EnvironmentError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const origin = env.apiOrigin;
const database = createDatabase(env.databaseUrl);
const auth = createAuth(database, {
  origin,
  secret: env.betterAuthSecret,
  registrationEnabled: env.registrationEnabled,
});
const boss = await createQueue(env.databaseUrl);
const catalog = createCatalogService(database);
await catalog.publish();
const settings = createSettingsService(database);
const app = createApp({
  origin,
  auth,
  catalog,
  submissions: createSubmissionService(database, boss, catalog),
  tokens: createTokenService(database),
  settings,
  reviews: createReviewService(database, catalog),
  progress: createProgressService(database, catalog, settings),
  health: async () => {
    await database.pool.query("select 1");
  },
});
const server = serve({ fetch: app.fetch, port: env.port });
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await boss.stop();
  await database.close();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
