import { type Settings, settingsSchema } from "@bekor/contracts";
import { type Database, preferences } from "@bekor/db";
import { eq } from "drizzle-orm";
import { ServiceError } from "./errors.js";
export function createSettingsService(database: Database) {
  return {
    async get(userId: string): Promise<Settings> {
      const [row] = await database.db
        .select()
        .from(preferences)
        .where(eq(preferences.userId, userId));
      return { timezone: row?.timezone ?? "UTC", dailyReviewLimit: row?.dailyReviewLimit ?? 20 };
    },
    async update(userId: string, input: Settings) {
      const parsed = settingsSchema.safeParse(input);
      if (!parsed.success) throw new ServiceError("INVALID_INPUT", "Invalid review settings.");
      await database.db
        .insert(preferences)
        .values({ userId, ...parsed.data })
        .onConflictDoUpdate({ target: preferences.userId, set: parsed.data });
      return parsed.data;
    },
  };
}
