import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";
import {
  searchConsoleConnections,
  searchConsoleDailyMetrics,
  searchConsoleKeywords,
  searchConsoleOauthStates,
  searchConsoleProperties,
} from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";

const READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SEARCH_CONSOLE_API = "https://www.googleapis.com/webmasters/v3";

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional().default(""),
  token_type: z.string().optional(),
});

const sitesResponseSchema = z.object({
  siteEntry: z.array(
    z.object({
      siteUrl: z.string().min(1),
      permissionLevel: z.string().min(1),
    }),
  ).max(1_000).optional().default([]),
});

const analyticsResponseSchema = z.object({
  rows: z.array(
    z.object({
      keys: z.array(z.string()).min(1),
      clicks: z.number().nonnegative(),
      impressions: z.number().nonnegative(),
      ctr: z.number().nonnegative(),
      position: z.number().nonnegative(),
    }),
  ).max(366).optional().default([]),
});

export interface SearchConsoleSyncMessage {
  type: "search_console_sync";
  workspaceId: string;
  clientId: string;
}

export interface SearchPerformanceSnapshot {
  siteUrl: string;
  lastSyncedAt: string | null;
  keywords: Array<{
    keyword: string;
    clicks: number;
    impressions: number;
    ctr: number | null;
    averagePosition: number | null;
    previousAveragePosition: number | null;
    positionChange: number | null;
  }>;
}

export function isSearchConsoleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

export async function createSearchConsoleAuthorizationUrl(
  env: Env,
  input: { workspaceId: string; userId: string },
): Promise<string> {
  assertConfigured(env);
  const state = randomToken(32);
  const now = new Date();
  const db = drizzle(env.DB);
  await db
    .delete(searchConsoleOauthStates)
    .where(lte(searchConsoleOauthStates.expiresAt, now));
  await db.insert(searchConsoleOauthStates).values({
    stateHash: await sha256(state),
    workspaceId: input.workspaceId,
    userId: input.userId,
    expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
    createdAt: now,
  });

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", READONLY_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function completeSearchConsoleAuthorization(
  env: Env,
  input: { workspaceId: string; userId: string; state: string; code: string },
): Promise<void> {
  assertConfigured(env);
  const db = drizzle(env.DB);
  const stateHash = await sha256(input.state);
  const stateRow = await db
    .select()
    .from(searchConsoleOauthStates)
    .where(
      and(
        eq(searchConsoleOauthStates.stateHash, stateHash),
        eq(searchConsoleOauthStates.workspaceId, input.workspaceId),
        eq(searchConsoleOauthStates.userId, input.userId),
      ),
    )
    .get();
  if (!stateRow || stateRow.consumedAt || stateRow.expiresAt <= new Date()) {
    throw new Error("GOOGLE_OAUTH_STATE_INVALID");
  }
  await db
    .update(searchConsoleOauthStates)
    .set({ consumedAt: new Date() })
    .where(eq(searchConsoleOauthStates.stateHash, stateHash));

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(env),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw new Error("GOOGLE_TOKEN_EXCHANGE_FAILED");
  const token = tokenResponseSchema.parse(await tokenResponse.json());
  if (!token.refresh_token) throw new Error("GOOGLE_REFRESH_TOKEN_MISSING");
  const grantedScope = token.scope || READONLY_SCOPE;
  if (!grantedScope.split(" ").includes(READONLY_SCOPE)) throw new Error("GOOGLE_SCOPE_NOT_GRANTED");

  const existing = await db
    .select({ id: searchConsoleConnections.id })
    .from(searchConsoleConnections)
    .where(eq(searchConsoleConnections.workspaceId, input.workspaceId))
    .get();
  const now = new Date();
  const connectionId = existing?.id ?? crypto.randomUUID();
  const encryptedRefreshToken = await encryptGoogleToken(token.refresh_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  if (existing) {
    await db
      .update(searchConsoleConnections)
      .set({
        connectedByUserId: input.userId,
        encryptedRefreshToken,
        scope: grantedScope,
        connectedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(and(
        eq(searchConsoleConnections.id, connectionId),
        eq(searchConsoleConnections.workspaceId, input.workspaceId),
      ));
  } else {
    await db.insert(searchConsoleConnections).values({
      id: connectionId,
      workspaceId: input.workspaceId,
      connectedByUserId: input.userId,
      encryptedRefreshToken,
      scope: grantedScope,
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function listSearchConsoleSites(
  env: Env,
  workspaceId: string,
): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const accessToken = await accessTokenForWorkspace(env, workspaceId);
  const response = await fetch(`${SEARCH_CONSOLE_API}/sites`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "GOOGLE_REAUTH_REQUIRED" : "GOOGLE_SITES_FAILED");
  return sitesResponseSchema.parse(await response.json()).siteEntry;
}

export async function revokeSearchConsoleConnection(env: Env, workspaceId: string): Promise<void> {
  const db = drizzle(env.DB);
  const connection = await db
    .select()
    .from(searchConsoleConnections)
    .where(eq(searchConsoleConnections.workspaceId, workspaceId))
    .get();
  if (!connection) return;
  if (isSearchConsoleConfigured(env)) {
    try {
      const refreshToken = await decryptGoogleToken(
        connection.encryptedRefreshToken,
        env.GOOGLE_TOKEN_ENCRYPTION_KEY,
      );
      const revokeResponse = await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!revokeResponse.ok) throw new Error("GOOGLE_REVOKE_FAILED");
    } catch {
      console.error(JSON.stringify({ event: "search_console_revoke_failed", workspaceId }));
    }
  }
  await db
    .delete(searchConsoleConnections)
    .where(and(
      eq(searchConsoleConnections.id, connection.id),
      eq(searchConsoleConnections.workspaceId, workspaceId),
    ));
}

export async function syncClientSearchConsole(
  env: Env,
  workspaceId: string,
  clientId: string,
): Promise<{ keywordCount: number; rowCount: number; startDate: string; endDate: string }> {
  const db = drizzle(env.DB);
  const property = await db
    .select({
      id: searchConsoleProperties.id,
      siteUrl: searchConsoleProperties.siteUrl,
    })
    .from(searchConsoleProperties)
    .where(and(
      eq(searchConsoleProperties.workspaceId, workspaceId),
      eq(searchConsoleProperties.clientId, clientId),
    ))
    .get();
  if (!property) throw new Error("SEARCH_CONSOLE_PROPERTY_NOT_FOUND");
  const keywords = await db
    .select()
    .from(searchConsoleKeywords)
    .where(and(
      eq(searchConsoleKeywords.workspaceId, workspaceId),
      eq(searchConsoleKeywords.clientId, clientId),
      eq(searchConsoleKeywords.propertyId, property.id),
      eq(searchConsoleKeywords.enabled, true),
    ))
    .orderBy(asc(searchConsoleKeywords.createdAt));
  const endDate = shiftDate(pacificDateString(new Date()), -2);
  const startDate = shiftDate(endDate, -89);
  if (!keywords.length) {
    await db
      .update(searchConsoleProperties)
      .set({ lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(and(
        eq(searchConsoleProperties.id, property.id),
        eq(searchConsoleProperties.workspaceId, workspaceId),
      ));
    return { keywordCount: 0, rowCount: 0, startDate, endDate };
  }
  const accessToken = await accessTokenForWorkspace(env, workspaceId);
  let rowCount = 0;

  try {
    for (const keyword of keywords) {
      const response = await fetch(
        `${SEARCH_CONSOLE_API}/sites/${encodeURIComponent(property.siteUrl)}/searchAnalytics/query`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            startDate,
            endDate,
            dimensions: ["date"],
            type: "web",
            dataState: "final",
            aggregationType: "byProperty",
            rowLimit: 366,
            dimensionFilterGroups: [{
              groupType: "and",
              filters: [{
                dimension: "query",
                operator: "equals",
                expression: keyword.keyword,
              }],
            }],
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        throw new Error(response.status === 401 ? "GOOGLE_REAUTH_REQUIRED" : "GOOGLE_ANALYTICS_FAILED");
      }
      const rows = analyticsResponseSchema.parse(await response.json()).rows;
      const fetchedAt = new Date();
      await db
        .delete(searchConsoleDailyMetrics)
        .where(and(
          eq(searchConsoleDailyMetrics.workspaceId, workspaceId),
          eq(searchConsoleDailyMetrics.keywordId, keyword.id),
          gte(searchConsoleDailyMetrics.metricDate, startDate),
          lte(searchConsoleDailyMetrics.metricDate, endDate),
        ));
      if (rows.length) {
        await db.insert(searchConsoleDailyMetrics).values(
          rows.map((row) => ({
            id: crypto.randomUUID(),
            workspaceId,
            keywordId: keyword.id,
            metricDate: row.keys[0],
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
            fetchedAt,
          })),
        );
      }
      rowCount += rows.length;
    }
    await db
      .update(searchConsoleProperties)
      .set({ lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(and(
        eq(searchConsoleProperties.id, property.id),
        eq(searchConsoleProperties.workspaceId, workspaceId),
      ));
    return { keywordCount: keywords.length, rowCount, startDate, endDate };
  } catch (error) {
    const code = error instanceof Error ? error.message : "GOOGLE_SYNC_FAILED";
    await db
      .update(searchConsoleProperties)
      .set({ lastError: code, updatedAt: new Date() })
      .where(and(
        eq(searchConsoleProperties.id, property.id),
        eq(searchConsoleProperties.workspaceId, workspaceId),
      ));
    throw error;
  }
}

export async function enqueueDueSearchConsoleSyncs(env: Env): Promise<number> {
  if (!isSearchConsoleConfigured(env)) return 0;
  const db = drizzle(env.DB);
  const dueBefore = new Date(Date.now() - 20 * 60 * 60 * 1_000);
  const properties = await db
    .select({
      workspaceId: searchConsoleProperties.workspaceId,
      clientId: searchConsoleProperties.clientId,
    })
    .from(searchConsoleProperties)
    .where(or(
      isNull(searchConsoleProperties.lastSyncedAt),
      lte(searchConsoleProperties.lastSyncedAt, dueBefore),
    ))
    .limit(100);
  await Promise.all(
    properties.map((property) =>
      env.MONITOR_QUEUE.send({
        type: "search_console_sync",
        workspaceId: property.workspaceId,
        clientId: property.clientId,
      } satisfies SearchConsoleSyncMessage),
    ),
  );
  return properties.length;
}

export async function buildSearchPerformanceSnapshot(
  env: Env,
  input: {
    workspaceId: string;
    clientId: string;
    periodStart: Date;
    periodEnd: Date;
    timeZone: string;
  },
): Promise<SearchPerformanceSnapshot | null> {
  const db = drizzle(env.DB);
  const property = await db
    .select({
      id: searchConsoleProperties.id,
      siteUrl: searchConsoleProperties.siteUrl,
      lastSyncedAt: searchConsoleProperties.lastSyncedAt,
    })
    .from(searchConsoleProperties)
    .where(and(
      eq(searchConsoleProperties.workspaceId, input.workspaceId),
      eq(searchConsoleProperties.clientId, input.clientId),
    ))
    .get();
  if (!property) return null;
  const keywords = await db
    .select()
    .from(searchConsoleKeywords)
    .where(and(
      eq(searchConsoleKeywords.workspaceId, input.workspaceId),
      eq(searchConsoleKeywords.clientId, input.clientId),
      eq(searchConsoleKeywords.propertyId, property.id),
      eq(searchConsoleKeywords.enabled, true),
    ))
    .orderBy(asc(searchConsoleKeywords.createdAt));
  if (!keywords.length) {
    return { siteUrl: property.siteUrl, lastSyncedAt: property.lastSyncedAt?.toISOString() ?? null, keywords: [] };
  }

  const duration = input.periodEnd.getTime() - input.periodStart.getTime() + 1;
  const previousStart = new Date(input.periodStart.getTime() - duration);
  const previousEnd = new Date(input.periodStart.getTime() - 1);
  const currentStartKey = dateStringInTimeZone(input.periodStart, input.timeZone);
  const currentEndKey = dateStringInTimeZone(input.periodEnd, input.timeZone);
  const previousStartKey = dateStringInTimeZone(previousStart, input.timeZone);
  const previousEndKey = dateStringInTimeZone(previousEnd, input.timeZone);
  const rows = await db
    .select()
    .from(searchConsoleDailyMetrics)
    .where(and(
      eq(searchConsoleDailyMetrics.workspaceId, input.workspaceId),
      inArray(searchConsoleDailyMetrics.keywordId, keywords.map((keyword) => keyword.id)),
      gte(searchConsoleDailyMetrics.metricDate, previousStartKey),
      lte(searchConsoleDailyMetrics.metricDate, currentEndKey),
    ));

  return {
    siteUrl: property.siteUrl,
    lastSyncedAt: property.lastSyncedAt?.toISOString() ?? null,
    keywords: keywords.map((keyword) => {
      const keywordRows = rows.filter((row) => row.keywordId === keyword.id);
      const current = aggregateMetrics(
        keywordRows.filter((row) => row.metricDate >= currentStartKey && row.metricDate <= currentEndKey),
      );
      const previous = aggregateMetrics(
        keywordRows.filter((row) => row.metricDate >= previousStartKey && row.metricDate <= previousEndKey),
      );
      return {
        keyword: keyword.keyword,
        ...current,
        previousAveragePosition: previous.averagePosition,
        positionChange:
          current.averagePosition !== null && previous.averagePosition !== null
            ? previous.averagePosition - current.averagePosition
            : null,
      };
    }),
  };
}

export async function encryptGoogleToken(token: string, encodedKey: string): Promise<string> {
  const key = await importEncryptionKey(encodedKey, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(token),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptGoogleToken(value: string, encodedKey: string): Promise<string> {
  const [version, ivValue, ciphertextValue] = value.split(".");
  if (version !== "v1" || !ivValue || !ciphertextValue) throw new Error("GOOGLE_TOKEN_FORMAT_INVALID");
  const key = await importEncryptionKey(encodedKey, ["decrypt"]);
  const iv = fromBase64Url(ivValue);
  const ciphertext = fromBase64Url(ciphertextValue);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

export function normalizeSearchKeyword(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function aggregateMetrics(
  rows: Array<typeof searchConsoleDailyMetrics.$inferSelect>,
): {
  clicks: number;
  impressions: number;
  ctr: number | null;
  averagePosition: number | null;
} {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const positioned = rows.filter((row) => row.position !== null && row.impressions > 0);
  const positionedImpressions = positioned.reduce((sum, row) => sum + row.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    averagePosition:
      positionedImpressions > 0
        ? positioned.reduce((sum, row) => sum + (row.position ?? 0) * row.impressions, 0) / positionedImpressions
        : null,
  };
}

async function accessTokenForWorkspace(env: Env, workspaceId: string): Promise<string> {
  assertConfigured(env);
  const db = drizzle(env.DB);
  const connection = await db
    .select()
    .from(searchConsoleConnections)
    .where(eq(searchConsoleConnections.workspaceId, workspaceId))
    .get();
  if (!connection) throw new Error("SEARCH_CONSOLE_NOT_CONNECTED");
  const refreshToken = await decryptGoogleToken(
    connection.encryptedRefreshToken,
    env.GOOGLE_TOKEN_ENCRYPTION_KEY,
  );
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await db
      .update(searchConsoleConnections)
      .set({ lastError: "GOOGLE_REAUTH_REQUIRED", updatedAt: new Date() })
      .where(and(
        eq(searchConsoleConnections.id, connection.id),
        eq(searchConsoleConnections.workspaceId, workspaceId),
      ));
    throw new Error("GOOGLE_REAUTH_REQUIRED");
  }
  const token = tokenResponseSchema.parse(await response.json());
  await db
    .update(searchConsoleConnections)
    .set({ lastError: null, updatedAt: new Date() })
    .where(and(
      eq(searchConsoleConnections.id, connection.id),
      eq(searchConsoleConnections.workspaceId, workspaceId),
    ));
  return token.access_token;
}

function assertConfigured(
  env: Env,
): asserts env is Env & {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_TOKEN_ENCRYPTION_KEY: string;
} {
  if (!isSearchConsoleConfigured(env)) throw new Error("SEARCH_CONSOLE_NOT_CONFIGURED");
}

function callbackUrl(env: Env): string {
  return new URL("/api/search-console/callback", env.APP_URL).toString();
}

async function importEncryptionKey(
  encodedKey: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const raw = fromBase64Url(encodedKey);
  if (raw.byteLength !== 32) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY_INVALID");
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, usages);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function pacificDateString(date: Date): string {
  return dateStringInTimeZone(date, "America/Los_Angeles");
}

function dateStringInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
