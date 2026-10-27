import { type Database, schema } from "@bekor/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
export function createAuth(
  database: Database,
  options: { origin: string; secret: string; registrationEnabled?: boolean },
) {
  if (options.secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const origin = new URL(options.origin).origin;
  return betterAuth({
    baseURL: origin,
    basePath: "/auth",
    secret: options.secret,
    database: drizzleAdapter(database.db, { provider: "pg", schema }),
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.registrationEnabled,
      minPasswordLength: 12,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
      },
    },
    advanced: {
      useSecureCookies: origin.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
  });
}
export type Auth = ReturnType<typeof createAuth>;
