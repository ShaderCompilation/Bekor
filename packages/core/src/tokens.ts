import { createHash, randomBytes, randomUUID } from "node:crypto";
import { credentialSchema } from "@bekor/contracts";
import { cliTokens, type Database } from "@bekor/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { ServiceError } from "./errors.js";

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
export const tokenScopes = [
  "submissions:read",
  "submissions:write",
  "reviews:read",
  "reviews:write",
] as const;
export type TokenScope = (typeof tokenScopes)[number];
function publicToken(row: typeof cliTokens.$inferSelect) {
  return credentialSchema.parse({
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  });
}
export function createTokenService(database: Database, clock = () => new Date()) {
  return {
    async create(userId: string, input: { name: string; scopes: string[]; expiresInDays: number }) {
      if (
        !input.name.trim() ||
        input.name.length > 80 ||
        !input.scopes.length ||
        input.scopes.some((s) => !tokenScopes.includes(s as TokenScope)) ||
        !Number.isInteger(input.expiresInDays) ||
        input.expiresInDays < 1 ||
        input.expiresInDays > 90
      )
        throw new ServiceError("INVALID_INPUT", "Invalid token name, scope or expiry.");
      const secret = `bk_${randomBytes(32).toString("base64url")}`,
        now = clock();
      const [row] = await database.db
        .insert(cliTokens)
        .values({
          id: randomUUID(),
          userId,
          name: input.name,
          hash: hash(secret),
          scopes: [...new Set(input.scopes)],
          expiresAt: new Date(now.getTime() + input.expiresInDays * 86400000),
          createdAt: now,
        })
        .returning();
      if (!row) throw new Error("Token insertion failed");
      return { token: secret, credential: publicToken(row) };
    },
    async list(userId: string) {
      return {
        items: (
          await database.db
            .select()
            .from(cliTokens)
            .where(eq(cliTokens.userId, userId))
            .orderBy(desc(cliTokens.createdAt))
            .limit(100)
        ).map(publicToken),
      };
    },
    async revoke(userId: string, id: string) {
      const owned = and(eq(cliTokens.id, id), eq(cliTokens.userId, userId));
      // Revocation is idempotent and keeps the first revocation time.
      const rows = await database.db
        .update(cliTokens)
        .set({ revokedAt: clock() })
        .where(and(owned, isNull(cliTokens.revokedAt)))
        .returning({ id: cliTokens.id });
      if (rows.length) return;
      const [existing] = await database.db
        .select({ id: cliTokens.id })
        .from(cliTokens)
        .where(owned);
      if (!existing) throw new ServiceError("NOT_FOUND", "Token not found.", 404);
    },
    async authenticate(secret: string) {
      if (!/^bk_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
      const now = clock();
      const [row] = await database.db
        .update(cliTokens)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(cliTokens.hash, hash(secret)),
            isNull(cliTokens.revokedAt),
            gt(cliTokens.expiresAt, now),
          ),
        )
        .returning();
      return row ? { userId: row.userId, scopes: row.scopes } : null;
    },
  };
}
