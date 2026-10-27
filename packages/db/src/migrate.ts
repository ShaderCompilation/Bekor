import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./index.js";
export async function migrateDatabase(database: ReturnType<typeof createDatabase>) {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const database = createDatabase(url);
  try {
    await migrateDatabase(database);
  } finally {
    await database.close();
  }
}
