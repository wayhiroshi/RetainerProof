import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "./db/schema";
import { escapeHtml, sendTransactionalEmail } from "./lib/email";

export function createAuth(env: Env) {
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    appName: env.APP_NAME,
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    verification: {
      storeInDatabase: true,
    },
    plugins: [
      magicLink({
        expiresIn: 60 * 15,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await sendTransactionalEmail(env, {
            to: email,
            subject: `Sign in to ${env.APP_NAME}`,
            html: `<p>Use this secure link to sign in to ${escapeHtml(env.APP_NAME)}.</p><p><a href="${escapeHtml(url)}">Sign in</a></p><p>This link expires in 15 minutes and can only be used once.</p>`,
            text: `Sign in to ${env.APP_NAME}: ${url}\n\nThis link expires in 15 minutes and can only be used once.`,
          });
        },
      }),
    ],
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        secure: env.ENVIRONMENT === "production",
        sameSite: "lax",
      },
    },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
