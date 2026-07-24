import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

test("magic links expire, reject tampering, and can be consumed only once", async ({ request, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Database mutation runs once.");
  const suffix = randomUUID();
  const token = `valid-token-${suffix}`;
  insertVerification(token, `magic-${suffix}@example.com`, Math.floor(Date.now() / 1_000) + 15 * 60);

  const verifyUrl = magicLinkUrl(baseURL!, token);
  const first = await request.get(verifyUrl, { maxRedirects: 0 });
  expect(first.status()).toBe(302);
  expect(first.headers().location).toBe(`${baseURL}/app`);
  expect(first.headers()["set-cookie"]).toContain("better-auth.session_token=");

  const reused = await request.get(verifyUrl, { maxRedirects: 0 });
  expect(reused.status()).toBe(302);
  expect(reused.headers().location).toContain("/login?error=INVALID_TOKEN");

  const tampered = await request.get(magicLinkUrl(baseURL!, `${token}-changed`), { maxRedirects: 0 });
  expect(tampered.status()).toBe(302);
  expect(tampered.headers().location).toContain("/login?error=INVALID_TOKEN");

  const expiredToken = `expired-token-${suffix}`;
  insertVerification(expiredToken, `expired-${suffix}@example.com`, Math.floor(Date.now() / 1_000) - 1);
  const expired = await request.get(magicLinkUrl(baseURL!, expiredToken), { maxRedirects: 0 });
  expect(expired.status()).toBe(302);
  expect(expired.headers().location).toContain("/login?error=INVALID_TOKEN");
});

function magicLinkUrl(baseURL: string, token: string): string {
  const url = new URL("/api/auth/magic-link/verify", baseURL);
  url.searchParams.set("token", token);
  url.searchParams.set("callbackURL", "/app");
  url.searchParams.set("errorCallbackURL", "/login");
  return url.toString();
}

function insertVerification(token: string, email: string, expiresAt: number): void {
  const identifier = createHash("sha256").update(token).digest("base64url");
  const now = Math.floor(Date.now() / 1_000);
  const value = JSON.stringify({ email, name: "Magic Link Test" }).replaceAll("'", "''");
  const sql = `INSERT INTO verification (id,identifier,value,expires_at,created_at,updated_at) VALUES ('${randomUUID()}','${identifier}','${value}',${expiresAt},${now},${now})`;
  execFileSync("npx", ["wrangler", "d1", "execute", "retainerproof-local", "--local", "--command", sql], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
}
