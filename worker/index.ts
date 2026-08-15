import { and, asc, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "./auth";
import {
  activities,
  aiRewrites,
  clients,
  formCheckRuns,
  formMonitors,
  maintenanceItems,
  managedAssets,
  reportDeliveries,
  reportRevisions,
  reports,
  searchConsoleConnections,
  searchConsoleKeywords,
  searchConsoleProperties,
  services,
  subscriptions,
  workspaces,
} from "./db/schema";
import { randomToken, sha256 } from "./lib/crypto";
import { escapeHtml, sendTransactionalEmail } from "./lib/email";
import { localized, normalizeLocale } from "./lib/locale";
import { isValidTimeZone, reportPeriod } from "./lib/report-period";
import { assertPublicHttpUrl, UnsafeUrlError } from "./lib/url-security";
import { assertClientBelongsToWorkspace, ensureWorkspace } from "./lib/workspace";
import { rewriteForClient } from "./services/ai";
import {
  cancelWorkspaceSubscription,
  clientLimitForWorkspace,
  createCheckout,
  createReservationCheckout,
  handleStripeWebhook,
} from "./services/billing";
import { enqueueDueChecks, type MonitorMessage, processMonitorMessage } from "./services/monitoring";
import {
  createDueSubmissionTasks,
  enqueueDueFormPresenceChecks,
  type FormPresenceMessage,
  processFormPresenceMessage,
  sendSubmissionFailureAlert,
} from "./services/form-monitoring";
import {
  buildReportSnapshot,
  renderReportHtml,
  saveCorrectionDraft,
  saveDraft,
  type ReportSnapshot,
} from "./services/reports";
import { purgeDueWorkspaceData } from "./services/deletion";
import {
  completeSearchConsoleAuthorization,
  createSearchConsoleAuthorizationUrl,
  enqueueDueSearchConsoleSyncs,
  isSearchConsoleConfigured,
  listSearchConsoleSites,
  normalizeSearchKeyword,
  revokeSearchConsoleConnection,
  type SearchConsoleSyncMessage,
  syncClientSearchConsole,
} from "./services/search-console";

type AppUser = { id: string; name: string; email: string };
type AppVariables = {
  user: AppUser;
  workspace: { id: string; name: string; timezone: string; uiLocale: "en" | "ja"; plan: string };
  subscription: typeof subscriptions.$inferSelect;
};

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/billing/webhook" || c.req.path.startsWith("/api/auth/")) {
    await next();
    return;
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.env.APP_URL).origin) {
      return c.json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
    }
  }
  await next();
});

app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.post("/api/billing/webhook", async (c) => {
  await handleStripeWebhook(c.env, c.req.raw);
  return c.json({ received: true });
});

app.get("/api/public/reports/:token", async (c) => {
  const token = c.req.param("token");
  const publicReport = await findPublicReport(c.env, token);
  if (!publicReport) return c.json({ error: "REPORT_NOT_FOUND" }, 404);
  if (!publicReport.firstViewedAt) {
    const db = drizzle(c.env.DB);
    c.executionCtx.waitUntil(
      db
        .update(reports)
        .set({ firstViewedAt: new Date(), updatedAt: new Date() })
        .where(eq(reports.id, publicReport.id)),
    );
  }
  const snapshot = publicReport.snapshot;
  const locale = normalizeLocale(snapshot.locale);
  return c.json({
    locale,
    appName: snapshot.appName,
    clientName: snapshot.client.name,
    periodLabel: snapshot.period.label,
    generatedAt: snapshot.generatedAt,
    pdfUrl: publicReport.pdfKey ? `/api/public/reports/${token}/pdf` : null,
    snapshot: {
      executiveSummary: snapshot.executiveSummary,
      currentHealth: {
        scheduled: snapshot.currentHealth.total,
        passed: snapshot.currentHealth.passed,
        failed: snapshot.currentHealth.total - snapshot.currentHealth.passed,
        message: localized(locale, {
          en: `${snapshot.currentHealth.passed} of ${snapshot.currentHealth.total} scheduled checks passed`,
          ja: `${snapshot.currentHealth.total}回中${snapshot.currentHealth.passed}回の定期確認に成功`,
        }),
        targets: snapshot.currentHealth.targets ?? [],
      },
      maintenanceCoverage: snapshot.maintenanceCoverage ?? [],
      searchPerformance: snapshot.searchPerformance ?? null,
      workCompleted: snapshot.workCompleted.map((item) => ({
        category: item.category,
        description: item.summary,
        date: item.occurredAt,
        target: item.target ?? "",
        outcomeType: item.outcomeType ?? "work_completed",
        resultSummary: item.resultSummary ?? "",
        verificationMethod: item.verificationMethod ?? "",
        clientValue: item.clientValue ?? "",
      })),
      problemsPrevented: snapshot.problemsPrevented.map((item) => ({
        summary: item.summary,
        outcomeType: item.outcomeType ?? "routine_verification",
      })),
      recommendations: snapshot.recommendations.map((item) => ({
        summary: item.summary,
        priority: item.priority ?? "medium",
        nextAction: item.nextAction ?? "",
      })),
      nextMonthPlan: snapshot.nextMonthPlan ?? localized(locale, {
        en: "Continue the configured care schedule and public-site observations next month.",
        ja: "翌月も設定済みの保守予定と公開サイトの定期確認を継続します。",
      }),
      closingMessage: snapshot.closingMessage,
    },
  });
});

app.get("/api/public/reports/:token/pdf", async (c) => {
  const publicReport = await findPublicReport(c.env, c.req.param("token"));
  if (!publicReport?.pdfKey) return c.json({ error: "PDF_NOT_FOUND" }, 404);
  const object = await c.env.REPORTS.get(publicReport.pdfKey);
  if (!object) return c.json({ error: "PDF_NOT_FOUND" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${safeFilename(publicReport.snapshot.client.name)}-${publicReport.snapshot.period.label}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
});

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "retainerproof",
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  }),
);

app.use("/api/*", async (c, next) => {
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return c.json({ error: "UNAUTHORIZED" }, 401);
  const user: AppUser = {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  };
  const workspace = await ensureWorkspace(c.env, user);
  const db = drizzle(c.env.DB);
  const subscription = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspace.id)).get();
  if (!subscription) return c.json({ error: "SUBSCRIPTION_NOT_FOUND" }, 500);
  c.set("user", user);
  c.set("workspace", workspace);
  c.set("subscription", subscription);
  const canUseProduct = ["trialing", "active", "past_due"].includes(subscription.status);
  const billingPath = c.req.path.startsWith("/api/billing/");
  if (!canUseProduct && !billingPath && c.req.path !== "/api/me") {
    return c.json({ error: "PAYMENT_REQUIRED" }, 402);
  }
  await next();
});

app.get("/api/me", async (c) => {
  const workspace = c.get("workspace");
  const subscription = c.get("subscription");
  return c.json({
    user: c.get("user"),
    workspace,
    subscription: {
      ...subscription,
      clientLimit: subscription.plan === "freelancer" ? 15 : 3,
    },
  });
});

app.patch("/api/me/locale", async (c) => {
  const input = z.object({ locale: z.enum(["en", "ja"]) }).parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  await db
    .update(workspaces)
    .set({ uiLocale: input.locale, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
  return c.json({ locale: input.locale });
});

app.get("/api/search-console", async (c) => {
  const workspaceId = c.get("workspace").id;
  const db = drizzle(c.env.DB);
  const [connection, properties, keywords] = await Promise.all([
    db
      .select({
        connectedAt: searchConsoleConnections.connectedAt,
        lastError: searchConsoleConnections.lastError,
      })
      .from(searchConsoleConnections)
      .where(eq(searchConsoleConnections.workspaceId, workspaceId))
      .get(),
    db
      .select({
        id: searchConsoleProperties.id,
        clientId: searchConsoleProperties.clientId,
        clientName: clients.name,
        siteUrl: searchConsoleProperties.siteUrl,
        permissionLevel: searchConsoleProperties.permissionLevel,
        lastSyncedAt: searchConsoleProperties.lastSyncedAt,
        lastError: searchConsoleProperties.lastError,
      })
      .from(searchConsoleProperties)
      .innerJoin(clients, eq(clients.id, searchConsoleProperties.clientId))
      .where(eq(searchConsoleProperties.workspaceId, workspaceId))
      .orderBy(asc(clients.name)),
    db
      .select({
        id: searchConsoleKeywords.id,
        clientId: searchConsoleKeywords.clientId,
        propertyId: searchConsoleKeywords.propertyId,
        keyword: searchConsoleKeywords.keyword,
        enabled: searchConsoleKeywords.enabled,
      })
      .from(searchConsoleKeywords)
      .where(eq(searchConsoleKeywords.workspaceId, workspaceId))
      .orderBy(asc(searchConsoleKeywords.createdAt)),
  ]);
  return c.json({
    configured: isSearchConsoleConfigured(c.env),
    connection: connection
      ? {
          connectedAt: connection.connectedAt,
          lastError: connection.lastError,
        }
      : null,
    properties,
    keywords,
  });
});

app.post("/api/search-console/connect", async (c) => {
  const url = await createSearchConsoleAuthorizationUrl(c.env, {
    workspaceId: c.get("workspace").id,
    userId: c.get("user").id,
  });
  return c.json({ url });
});

app.get("/api/search-console/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const denied = c.req.query("error");
  if (denied || !state || !code) {
    return c.redirect(`${c.env.APP_URL}/app/search?google=denied`);
  }
  try {
    await completeSearchConsoleAuthorization(c.env, {
      workspaceId: c.get("workspace").id,
      userId: c.get("user").id,
      state,
      code,
    });
    return c.redirect(`${c.env.APP_URL}/app/search?google=connected`);
  } catch (error) {
    console.error(JSON.stringify({
      event: "search_console_oauth_failed",
      code: error instanceof Error ? error.message : "GOOGLE_OAUTH_FAILED",
    }));
    return c.redirect(`${c.env.APP_URL}/app/search?google=failed`);
  }
});

app.get("/api/search-console/sites", async (c) => {
  const sites = await listSearchConsoleSites(c.env, c.get("workspace").id);
  return c.json({ sites });
});

app.post("/api/search-console/properties", async (c) => {
  const input = searchConsolePropertySchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  await assertClientBelongsToWorkspace(c.env, workspaceId, input.clientId);
  const db = drizzle(c.env.DB);
  const connection = await db
    .select({ id: searchConsoleConnections.id })
    .from(searchConsoleConnections)
    .where(eq(searchConsoleConnections.workspaceId, workspaceId))
    .get();
  if (!connection) return c.json({ error: "SEARCH_CONSOLE_NOT_CONNECTED" }, 404);
  const sites = await listSearchConsoleSites(c.env, workspaceId);
  const site = sites.find((candidate) => candidate.siteUrl === input.siteUrl);
  if (!site || site.permissionLevel === "siteUnverifiedUser") {
    return c.json({ error: "SEARCH_CONSOLE_SITE_NOT_AVAILABLE" }, 404);
  }
  const existing = await db
    .select({ id: searchConsoleProperties.id, siteUrl: searchConsoleProperties.siteUrl })
    .from(searchConsoleProperties)
    .where(and(
      eq(searchConsoleProperties.workspaceId, workspaceId),
      eq(searchConsoleProperties.clientId, input.clientId),
    ))
    .get();
  const now = new Date();
  if (existing?.siteUrl === site.siteUrl) {
    await db
      .update(searchConsoleProperties)
      .set({ permissionLevel: site.permissionLevel, lastError: null, updatedAt: now })
      .where(and(
        eq(searchConsoleProperties.id, existing.id),
        eq(searchConsoleProperties.workspaceId, workspaceId),
      ));
    return c.json({ id: existing.id });
  }
  if (existing) {
    await db
      .delete(searchConsoleProperties)
      .where(and(
        eq(searchConsoleProperties.id, existing.id),
        eq(searchConsoleProperties.workspaceId, workspaceId),
      ));
  }
  const id = crypto.randomUUID();
  await db.insert(searchConsoleProperties).values({
    id,
    workspaceId,
    connectionId: connection.id,
    clientId: input.clientId,
    siteUrl: site.siteUrl,
    permissionLevel: site.permissionLevel,
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id }, 201);
});

app.delete("/api/search-console/properties/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const result = await db
    .delete(searchConsoleProperties)
    .where(and(
      eq(searchConsoleProperties.id, c.req.param("id")),
      eq(searchConsoleProperties.workspaceId, c.get("workspace").id),
    ));
  if (!result.meta.changes) return c.json({ error: "SEARCH_CONSOLE_PROPERTY_NOT_FOUND" }, 404);
  return c.json({ deleted: true });
});

app.post("/api/search-console/keywords", async (c) => {
  const input = searchConsoleKeywordSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  await assertClientBelongsToWorkspace(c.env, workspaceId, input.clientId);
  const db = drizzle(c.env.DB);
  const property = await db
    .select({ id: searchConsoleProperties.id })
    .from(searchConsoleProperties)
    .where(and(
      eq(searchConsoleProperties.id, input.propertyId),
      eq(searchConsoleProperties.workspaceId, workspaceId),
      eq(searchConsoleProperties.clientId, input.clientId),
    ))
    .get();
  if (!property) return c.json({ error: "SEARCH_CONSOLE_PROPERTY_NOT_FOUND" }, 404);
  const existingKeywords = await db
    .select({ id: searchConsoleKeywords.id })
    .from(searchConsoleKeywords)
    .where(and(
      eq(searchConsoleKeywords.workspaceId, workspaceId),
      eq(searchConsoleKeywords.clientId, input.clientId),
      eq(searchConsoleKeywords.enabled, true),
    ));
  if (existingKeywords.length >= 10) {
    return c.json({ error: "SEARCH_CONSOLE_KEYWORD_LIMIT_REACHED", limit: 10 }, 409);
  }
  const normalizedKeyword = normalizeSearchKeyword(input.keyword);
  const duplicate = await db
    .select({ id: searchConsoleKeywords.id })
    .from(searchConsoleKeywords)
    .where(and(
      eq(searchConsoleKeywords.propertyId, property.id),
      eq(searchConsoleKeywords.normalizedKeyword, normalizedKeyword),
    ))
    .get();
  if (duplicate) return c.json({ error: "SEARCH_CONSOLE_KEYWORD_EXISTS" }, 409);
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(searchConsoleKeywords).values({
    id,
    workspaceId,
    clientId: input.clientId,
    propertyId: property.id,
    keyword: input.keyword,
    normalizedKeyword,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id }, 201);
});

app.delete("/api/search-console/keywords/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const result = await db
    .delete(searchConsoleKeywords)
    .where(and(
      eq(searchConsoleKeywords.id, c.req.param("id")),
      eq(searchConsoleKeywords.workspaceId, c.get("workspace").id),
    ));
  if (!result.meta.changes) return c.json({ error: "SEARCH_CONSOLE_KEYWORD_NOT_FOUND" }, 404);
  return c.json({ deleted: true });
});

app.post("/api/search-console/sync", async (c) => {
  const input = z.object({ clientId: z.string().min(1) }).parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  await assertClientBelongsToWorkspace(c.env, workspaceId, input.clientId);
  return c.json(await syncClientSearchConsole(c.env, workspaceId, input.clientId));
});

app.delete("/api/search-console/connection", async (c) => {
  await revokeSearchConsoleConnection(c.env, c.get("workspace").id);
  return c.json({ disconnected: true });
});

app.get("/api/form-monitors", async (c) => {
  const workspaceId = c.get("workspace").id;
  const db = drizzle(c.env.DB);
  const [monitors, runs] = await Promise.all([
    db
      .select({
        id: formMonitors.id,
        clientId: formMonitors.clientId,
        clientName: clients.name,
        assetId: formMonitors.assetId,
        name: formMonitors.name,
        url: formMonitors.url,
        formType: formMonitors.formType,
        turnstileWidgetName: formMonitors.turnstileWidgetName,
        requireTurnstile: formMonitors.requireTurnstile,
        enabled: formMonitors.enabled,
        intervalHours: formMonitors.intervalHours,
        nextPresenceCheckAt: formMonitors.nextPresenceCheckAt,
        nextSubmissionCheckAt: formMonitors.nextSubmissionCheckAt,
        lastPresencePassedAt: formMonitors.lastPresencePassedAt,
        lastSubmissionPassedAt: formMonitors.lastSubmissionPassedAt,
        incidentOpenedAt: formMonitors.incidentOpenedAt,
        lastRecoveredAt: formMonitors.lastRecoveredAt,
      })
      .from(formMonitors)
      .innerJoin(clients, eq(clients.id, formMonitors.clientId))
      .where(eq(formMonitors.workspaceId, workspaceId))
      .orderBy(asc(clients.name), asc(formMonitors.name)),
    db
      .select()
      .from(formCheckRuns)
      .where(eq(formCheckRuns.workspaceId, workspaceId))
      .orderBy(desc(formCheckRuns.createdAt))
      .limit(200),
  ]);
  return c.json({ monitors, runs });
});

app.post("/api/form-monitors", async (c) => {
  const input = formMonitorInputSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  await assertClientBelongsToWorkspace(c.env, workspaceId, input.clientId);
  const db = drizzle(c.env.DB);
  const asset = await db
    .select({ id: managedAssets.id })
    .from(managedAssets)
    .where(and(
      eq(managedAssets.id, input.assetId),
      eq(managedAssets.clientId, input.clientId),
      eq(managedAssets.workspaceId, workspaceId),
    ))
    .get();
  if (!asset) return c.json({ error: "ASSET_NOT_FOUND" }, 404);
  const [{ value: monitorCount }] = await db
    .select({ value: count() })
    .from(formMonitors)
    .where(and(eq(formMonitors.workspaceId, workspaceId), eq(formMonitors.clientId, input.clientId)));
  if (monitorCount >= 10) return c.json({ error: "FORM_MONITOR_LIMIT_REACHED", limit: 10 }, 409);
  const url = await assertPublicHttpUrl(input.url);
  const now = new Date();
  const nextSubmissionCheckAt = new Date(now);
  nextSubmissionCheckAt.setUTCMonth(nextSubmissionCheckAt.getUTCMonth() + 1);
  const id = crypto.randomUUID();
  await db.insert(formMonitors).values({
    id,
    workspaceId,
    clientId: input.clientId,
    assetId: asset.id,
    name: input.name,
    url: url.toString(),
    formType: input.formType,
    turnstileWidgetName: input.turnstileWidgetName || null,
    requireTurnstile: input.requireTurnstile,
    intervalHours: input.intervalHours,
    enabled: true,
    nextPresenceCheckAt: now,
    nextSubmissionCheckAt,
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id }, 201);
});

app.patch("/api/form-monitors/:id", async (c) => {
  const input = formMonitorUpdateSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  const db = drizzle(c.env.DB);
  const existing = await db
    .select()
    .from(formMonitors)
    .where(and(eq(formMonitors.id, c.req.param("id")), eq(formMonitors.workspaceId, workspaceId)))
    .get();
  if (!existing) return c.json({ error: "FORM_MONITOR_NOT_FOUND" }, 404);
  const nextUrl = input.url ? (await assertPublicHttpUrl(input.url)).toString() : undefined;
  await db
    .update(formMonitors)
    .set({
      ...input,
      ...(nextUrl ? { url: nextUrl } : {}),
      turnstileWidgetName: input.turnstileWidgetName === "" ? null : input.turnstileWidgetName,
      ...(input.enabled === true && !existing.enabled ? { nextPresenceCheckAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(formMonitors.id, existing.id), eq(formMonitors.workspaceId, workspaceId)));
  return c.json({ updated: true });
});

app.post("/api/form-monitors/:id/presence-checks", async (c) => {
  const workspaceId = c.get("workspace").id;
  const db = drizzle(c.env.DB);
  const monitor = await db
    .select({ id: formMonitors.id, intervalHours: formMonitors.intervalHours })
    .from(formMonitors)
    .where(and(eq(formMonitors.id, c.req.param("id")), eq(formMonitors.workspaceId, workspaceId)))
    .get();
  if (!monitor) return c.json({ error: "FORM_MONITOR_NOT_FOUND" }, 404);
  await c.env.MONITOR_QUEUE.send({
    type: "form_presence_check",
    workspaceId,
    monitorId: monitor.id,
    attempt: 1,
    trigger: "manual",
  } satisfies FormPresenceMessage);
  const now = new Date();
  await db
    .update(formMonitors)
    .set({
      nextPresenceCheckAt: new Date(now.getTime() + monitor.intervalHours * 60 * 60 * 1_000),
      updatedAt: now,
    })
    .where(and(eq(formMonitors.id, monitor.id), eq(formMonitors.workspaceId, workspaceId)));
  return c.json({ queued: true }, 202);
});

app.post("/api/form-monitors/:id/submission-checks", async (c) => {
  const input = submissionCheckCreateSchema.parse(await c.req.json().catch(() => ({})));
  const workspaceId = c.get("workspace").id;
  const db = drizzle(c.env.DB);
  const monitor = await db
    .select({ id: formMonitors.id })
    .from(formMonitors)
    .where(and(eq(formMonitors.id, c.req.param("id")), eq(formMonitors.workspaceId, workspaceId)))
    .get();
  if (!monitor) return c.json({ error: "FORM_MONITOR_NOT_FOUND" }, 404);
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(formCheckRuns).values({
    id,
    workspaceId,
    monitorId: monitor.id,
    mode: "submission",
    trigger: input.trigger,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id, status: "pending" }, 201);
});

app.patch("/api/form-check-runs/:id", async (c) => {
  const input = submissionCheckUpdateSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  const db = drizzle(c.env.DB);
  const row = await db
    .select({ run: formCheckRuns, monitorName: formMonitors.name })
    .from(formCheckRuns)
    .innerJoin(formMonitors, eq(formMonitors.id, formCheckRuns.monitorId))
    .where(and(
      eq(formCheckRuns.id, c.req.param("id")),
      eq(formCheckRuns.workspaceId, workspaceId),
      eq(formMonitors.workspaceId, workspaceId),
    ))
    .get();
  if (!row || row.run.mode !== "submission") return c.json({ error: "FORM_CHECK_NOT_FOUND" }, 404);
  const statuses = [
    input.websiteSubmissionStatus,
    input.wordpressReceiptStatus,
    input.adminNotificationStatus,
    input.autoReplyStatus,
  ];
  const status = statuses.includes("manual_required")
    ? "manual_required"
    : statuses.includes("failed")
      ? "failed"
      : statuses.every((value) => value === "passed")
        ? "passed"
        : "pending";
  const now = new Date();
  const checkpointTime = (checkpointStatus: typeof statuses[number], value?: string) =>
    checkpointStatus === "not_checked" ? null : value ? new Date(value) : now;
  await db
    .update(formCheckRuns)
    .set({
      websiteSubmissionStatus: input.websiteSubmissionStatus,
      websiteSubmittedAt: checkpointTime(input.websiteSubmissionStatus, input.websiteSubmittedAt),
      wordpressReceiptStatus: input.wordpressReceiptStatus,
      wordpressReceivedAt: checkpointTime(input.wordpressReceiptStatus, input.wordpressReceivedAt),
      adminNotificationStatus: input.adminNotificationStatus,
      adminNotificationAt: checkpointTime(input.adminNotificationStatus, input.adminNotificationAt),
      autoReplyStatus: input.autoReplyStatus,
      autoReplyAt: checkpointTime(input.autoReplyStatus, input.autoReplyAt),
      status,
      startedAt: row.run.startedAt ?? now,
      completedAt: status === "pending" ? null : now,
      durationMs: status === "pending" ? null : Math.max(0, now.getTime() - (row.run.startedAt ?? now).getTime()),
      errorCode: status === "failed"
        ? "SUBMISSION_CHECK_FAILED"
        : status === "manual_required"
          ? "HUMAN_ACTION_REQUIRED"
          : null,
      updatedAt: now,
    })
    .where(and(eq(formCheckRuns.id, row.run.id), eq(formCheckRuns.workspaceId, workspaceId)));
  if (status === "passed") {
    await db
      .update(formMonitors)
      .set({ lastSubmissionPassedAt: now, updatedAt: now })
      .where(and(eq(formMonitors.id, row.run.monitorId), eq(formMonitors.workspaceId, workspaceId)));
  }
  if (status === "failed" && row.run.status !== "failed") {
    const labels = [
      ["website_submission", input.websiteSubmissionStatus],
      ["wordpress_receipt", input.wordpressReceiptStatus],
      ["admin_notification", input.adminNotificationStatus],
      ["auto_reply", input.autoReplyStatus],
    ].filter(([, value]) => value === "failed").map(([label]) => label);
    try {
      await sendSubmissionFailureAlert(c.env, workspaceId, row.run.monitorId, row.monitorName, labels);
    } catch {
      console.error(JSON.stringify({
        event: "form_submission_alert_failed",
        monitorId: row.run.monitorId,
        provider: "resend",
      }));
    }
  }
  return c.json({ status });
});

app.get("/api/clients", async (c) => {
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const [rows, careItems] = await Promise.all([
    db
      .select({
        id: clients.id,
        name: clients.name,
        contactName: clients.contactName,
        contactEmail: clients.contactEmail,
        reportLocale: clients.reportLocale,
        status: clients.status,
        assetId: managedAssets.id,
        assetName: managedAssets.name,
        url: managedAssets.url,
        criticalUrlsJson: managedAssets.criticalUrlsJson,
        nextCheckAt: managedAssets.nextCheckAt,
      })
      .from(clients)
      .leftJoin(managedAssets, eq(managedAssets.clientId, clients.id))
      .where(eq(clients.workspaceId, workspaceId))
      .orderBy(desc(clients.createdAt)),
    db
      .select()
      .from(maintenanceItems)
      .where(eq(maintenanceItems.workspaceId, workspaceId))
      .orderBy(asc(maintenanceItems.sortOrder), asc(maintenanceItems.createdAt)),
  ]);
  return c.json({
    clients: rows.map((row) => ({
      id: row.id,
      name: row.name,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
      reportLocale: row.reportLocale,
      maintenanceItems: careItems.filter((item) => item.clientId === row.id),
      asset: row.assetId
        ? {
            id: row.assetId,
            name: row.assetName,
            url: row.url,
            criticalUrls: safeJsonArray(row.criticalUrlsJson),
            nextCheckAt: row.nextCheckAt,
          }
        : null,
    })),
  });
});

app.post("/api/clients", async (c) => {
  const input = clientInputSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const [{ value: existingCount }] = await db
    .select({ value: count() })
    .from(clients)
    .where(and(eq(clients.workspaceId, workspaceId), eq(clients.status, "active")));
  const limit = await clientLimitForWorkspace(c.env, workspaceId);
  if (existingCount >= limit) return c.json({ error: "CLIENT_LIMIT_REACHED", limit }, 409);
  const siteUrl = await assertPublicHttpUrl(input.url);
  const criticalUrls = await Promise.all(input.criticalUrls.slice(0, 3).map(async (url) => (await assertPublicHttpUrl(url)).toString()));
  const now = new Date();
  const clientId = crypto.randomUUID();
  const serviceId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const defaultCareItems = defaultMaintenanceItems(input.reportLocale);
  await db.batch([
    db.insert(clients).values({
      id: clientId,
      workspaceId,
      name: input.name,
      contactName: input.contactName || null,
      contactEmail: input.contactEmail || null,
      reportLocale: input.reportLocale,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(services).values({
      id: serviceId,
      workspaceId,
      clientId,
      name: input.serviceName,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(managedAssets).values({
      id: assetId,
      workspaceId,
      clientId,
      serviceId,
      name: input.assetName,
      url: siteUrl.toString(),
      criticalUrlsJson: JSON.stringify(criticalUrls),
      nextCheckAt: now,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(maintenanceItems).values(
      defaultCareItems.map((item, index) => ({
        id: crypto.randomUUID(),
        workspaceId,
        clientId,
        ...item,
        sortOrder: index,
        createdAt: now,
        updatedAt: now,
      })),
    ),
    db
      .update(workspaces)
      .set({ timezone: input.timezone, updatedAt: now })
      .where(eq(workspaces.id, workspaceId)),
  ]);
  return c.json({ id: clientId, assetId }, 201);
});

app.patch("/api/clients/:id/report-locale", async (c) => {
  const input = z.object({ locale: z.enum(["en", "ja"]) }).parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const result = await db
    .update(clients)
    .set({ reportLocale: input.locale, updatedAt: new Date() })
    .where(and(eq(clients.id, c.req.param("id")), eq(clients.workspaceId, workspaceId)));
  if (!result.meta.changes) return c.json({ error: "CLIENT_NOT_FOUND" }, 404);
  return c.json({ locale: input.locale });
});

app.post("/api/clients/:id/maintenance-items", async (c) => {
  const input = maintenanceItemInputSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  const clientId = c.req.param("id");
  await assertClientBelongsToWorkspace(c.env, workspaceId, clientId);
  const db = drizzle(c.env.DB);
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(maintenanceItems).values({
    id,
    workspaceId,
    clientId,
    name: input.name,
    category: input.category,
    frequency: input.frequency,
    enabled: true,
    sortOrder: input.sortOrder,
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id }, 201);
});

app.patch("/api/maintenance-items/:id", async (c) => {
  const input = maintenanceItemUpdateSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  const db = drizzle(c.env.DB);
  const result = await db
    .update(maintenanceItems)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(maintenanceItems.id, c.req.param("id")), eq(maintenanceItems.workspaceId, workspaceId)));
  if (!result.meta.changes) return c.json({ error: "MAINTENANCE_ITEM_NOT_FOUND" }, 404);
  return c.json({ updated: true });
});

app.delete("/api/maintenance-items/:id", async (c) => {
  const workspaceId = c.get("workspace").id;
  const db = drizzle(c.env.DB);
  const result = await db
    .delete(maintenanceItems)
    .where(and(eq(maintenanceItems.id, c.req.param("id")), eq(maintenanceItems.workspaceId, workspaceId)));
  if (!result.meta.changes) return c.json({ error: "MAINTENANCE_ITEM_NOT_FOUND" }, 404);
  return c.json({ deleted: true });
});

app.get("/api/activities", async (c) => {
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const clientId = c.req.query("clientId");
  const condition = clientId
    ? and(eq(activities.workspaceId, workspaceId), eq(activities.clientId, clientId))
    : eq(activities.workspaceId, workspaceId);
  const rows = await db
    .select({
      id: activities.id,
      clientId: activities.clientId,
      clientName: clients.name,
      occurredAt: activities.occurredAt,
      category: activities.category,
      maintenanceItemId: activities.maintenanceItemId,
      target: activities.target,
      outcomeType: activities.outcomeType,
      internalNote: activities.internalNote,
      clientDescription: activities.clientSummary,
      resultSummary: activities.resultSummary,
      verificationMethod: activities.verificationMethod,
      clientValue: activities.clientValue,
      recommendationPriority: activities.recommendationPriority,
      nextAction: activities.nextAction,
      visibility: activities.visibility,
    })
    .from(activities)
    .innerJoin(clients, eq(clients.id, activities.clientId))
    .where(condition)
    .orderBy(desc(activities.occurredAt))
    .limit(200);
  return c.json({ activities: rows });
});

app.post("/api/activities", async (c) => {
  const input = activityInputSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  await assertClientBelongsToWorkspace(c.env, workspaceId, input.clientId);
  const reportLocale = await clientReportLocale(c.env, workspaceId, input.clientId);
  const template = quickTemplates[reportLocale][input.category];
  const clientSummary = input.clientDescription.trim() || template;
  const db = drizzle(c.env.DB);
  if (input.maintenanceItemId) {
    const careItem = await db
      .select({ clientId: maintenanceItems.clientId })
      .from(maintenanceItems)
      .where(
        and(
          eq(maintenanceItems.id, input.maintenanceItemId),
          eq(maintenanceItems.workspaceId, workspaceId),
        ),
      )
      .get();
    if (!careItem || careItem.clientId !== input.clientId) {
      return c.json({ error: "MAINTENANCE_ITEM_NOT_FOUND" }, 404);
    }
  }
  const id = crypto.randomUUID();
  await db.insert(activities).values({
    id,
    workspaceId,
    clientId: input.clientId,
    assetId: input.assetId || null,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    category: input.category,
    visibility: input.visibility,
    maintenanceItemId: input.maintenanceItemId || null,
    target: input.target,
    outcomeType: input.outcomeType,
    internalNote: input.internalNote,
    clientSummary,
    resultSummary: input.resultSummary,
    verificationMethod: input.verificationMethod,
    clientValue: input.clientValue,
    recommendationPriority: input.visibility === "recommendation" ? input.recommendationPriority : null,
    nextAction: input.visibility === "recommendation" ? input.nextAction : "",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  if (input.aiRewriteId) {
    await db
      .update(aiRewrites)
      .set({ acceptedText: clientSummary, status: "accepted" })
      .where(
        and(
          eq(aiRewrites.id, input.aiRewriteId),
          eq(aiRewrites.workspaceId, workspaceId),
          eq(aiRewrites.userId, c.get("user").id),
          eq(aiRewrites.status, "generated"),
        ),
      );
  }
  return c.json({ id, clientSummary }, 201);
});

app.post("/api/ai/rewrite", async (c) => {
  const input = rewriteInputSchema.parse(await c.req.json());
  await assertClientBelongsToWorkspace(c.env, c.get("workspace").id, input.clientId);
  const locale = await clientReportLocale(c.env, c.get("workspace").id, input.clientId);
  const output = await rewriteForClient(c.env, {
    workspaceId: c.get("workspace").id,
    userId: c.get("user").id,
    sourceText: input.text,
    locale,
    context: `Category: ${input.category}`,
  });
  return c.json({
    rewriteId: output.rewriteId,
    rewrittenText: output.result.clientSummary,
    category: output.result.category,
    importance: output.result.importance,
  });
});

app.get("/api/reports", async (c) => {
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const rows = await db
    .select({
      id: reports.id,
      clientId: reports.clientId,
      clientName: clients.name,
      periodStart: reports.periodStart,
      periodEnd: reports.periodEnd,
      status: reports.status,
      latestRevisionNumber: reports.currentRevision,
      firstViewedAt: reports.firstViewedAt,
      finalizedAt: reports.finalizedAt,
      updatedAt: reports.updatedAt,
      snapshotJson: reportRevisions.snapshotJson,
      pdfKey: reportRevisions.pdfKey,
    })
    .from(reports)
    .innerJoin(clients, eq(clients.id, reports.clientId))
    .innerJoin(
      reportRevisions,
      and(eq(reportRevisions.reportId, reports.id), eq(reportRevisions.revision, reports.currentRevision)),
    )
    .where(eq(reports.workspaceId, workspaceId))
    .orderBy(desc(reports.periodStart));
  return c.json({
    reports: rows.map(({ snapshotJson, pdfKey, ...report }) => {
      const snapshot = JSON.parse(snapshotJson) as ReportSnapshot;
      return {
        ...report,
        locale: normalizeLocale(snapshot.locale),
        periodLabel: snapshot.period.label,
        pdfAvailable: Boolean(pdfKey),
      };
    }),
  });
});

app.get("/api/reports/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const row = await db
    .select({
      report: reports,
      snapshotJson: reportRevisions.snapshotJson,
      revision: reportRevisions.revision,
    })
    .from(reports)
    .innerJoin(
      reportRevisions,
      and(eq(reportRevisions.reportId, reports.id), eq(reportRevisions.revision, reports.currentRevision)),
    )
    .where(and(eq(reports.id, c.req.param("id")), eq(reports.workspaceId, workspaceId)))
    .get();
  if (!row) return c.json({ error: "REPORT_NOT_FOUND" }, 404);
  return c.json({
    report: row.report,
    revision: row.revision,
    snapshot: JSON.parse(row.snapshotJson) as ReportSnapshot,
  });
});

app.post("/api/reports/draft", async (c) => {
  const input = reportDraftSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  await assertClientBelongsToWorkspace(c.env, workspaceId, input.clientId);
  if (input.locale) {
    const db = drizzle(c.env.DB);
    await db
      .update(clients)
      .set({ reportLocale: input.locale, updatedAt: new Date() })
      .where(and(eq(clients.id, input.clientId), eq(clients.workspaceId, workspaceId)));
  }
  const { start, end } = reportPeriod(input.periodStart, input.periodEnd, c.get("workspace").timezone);
  const snapshot = await buildReportSnapshot(c.env, workspaceId, input.clientId, start, end);
  return c.json(await saveDraft(c.env, workspaceId, input.clientId, start, end, snapshot), 201);
});

app.post("/api/reports/:id/correction", async (c) => {
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const reportId = c.req.param("id");
  const row = await db
    .select({
      clientId: reports.clientId,
      periodStart: reports.periodStart,
      periodEnd: reports.periodEnd,
      status: reports.status,
      snapshotJson: reportRevisions.snapshotJson,
    })
    .from(reports)
    .innerJoin(
      reportRevisions,
      and(eq(reportRevisions.reportId, reports.id), eq(reportRevisions.revision, reports.currentRevision)),
    )
    .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId)))
    .get();
  if (!row) return c.json({ error: "REPORT_NOT_FOUND" }, 404);
  if (row.status === "draft") return c.json({ error: "REPORT_ALREADY_DRAFT" }, 409);

  const current = JSON.parse(row.snapshotJson) as ReportSnapshot;
  const snapshot = await buildReportSnapshot(
    c.env,
    workspaceId,
    row.clientId,
    row.periodStart,
    row.periodEnd,
    normalizeLocale(current.locale),
  );
  return c.json(await saveCorrectionDraft(c.env, workspaceId, reportId, snapshot), 201);
});

app.put("/api/reports/:id", async (c) => {
  const input = reportEditSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const reportId = c.req.param("id");
  const row = await db
    .select({
      status: reports.status,
      currentRevision: reports.currentRevision,
      snapshotJson: reportRevisions.snapshotJson,
    })
    .from(reports)
    .innerJoin(
      reportRevisions,
      and(eq(reportRevisions.reportId, reports.id), eq(reportRevisions.revision, reports.currentRevision)),
    )
    .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId)))
    .get();
  if (!row) return c.json({ error: "REPORT_NOT_FOUND" }, 404);
  if (row.status !== "draft") return c.json({ error: "FINALIZED_REPORT_IMMUTABLE" }, 409);
  const current = JSON.parse(row.snapshotJson) as ReportSnapshot;
  const next: ReportSnapshot = {
    ...current,
    executiveSummary: input.executiveSummary,
    workCompleted: input.workCompleted,
    problemsPrevented: input.problemsPrevented,
    recommendations: input.recommendations,
    nextMonthPlan: input.nextMonthPlan,
    closingMessage: input.closingMessage,
    generatedAt: new Date().toISOString(),
  };
  const revision = row.currentRevision + 1;
  await db.batch([
    db.insert(reportRevisions).values({
      id: crypto.randomUUID(),
      workspaceId,
      reportId,
      revision,
      snapshotJson: JSON.stringify(next),
      createdAt: new Date(),
    }),
    db
      .update(reports)
      .set({ currentRevision: revision, updatedAt: new Date() })
      .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId))),
  ]);
  return c.json({ reportId, revision, snapshot: next });
});

app.post("/api/reports/:id/finalize", async (c) => {
  const input = finalizeSchema.parse(await c.req.json());
  const workspaceId = c.get("workspace").id;
  const finalized = await finalizeReport(c.env, workspaceId, c.req.param("id"), input);
  return c.json(finalized);
});

app.post("/api/reports/:id/pdf", async (c) => {
  const workspaceId = c.get("workspace").id;
  const result = await ensureReportPdf(c.env, workspaceId, c.req.param("id"));
  return c.json(result);
});

app.post("/api/reports/:id/revoke", async (c) => {
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  await db
    .update(reports)
    .set({ status: "revoked", shareTokenHash: null, updatedAt: new Date() })
    .where(and(eq(reports.id, c.req.param("id")), eq(reports.workspaceId, workspaceId)));
  return c.json({ revoked: true });
});

app.post("/api/billing/checkout", async (c) => {
  const input = billingSchema.parse(await c.req.json());
  const url = await createCheckout(c.env, {
    workspaceId: c.get("workspace").id,
    userId: c.get("user").id,
    email: c.get("user").email,
    plan: input.plan,
    interval: input.interval,
  });
  return c.json({ url });
});

app.post("/api/billing/reservation", async (c) => {
  const url = await createReservationCheckout(c.env, {
    workspaceId: c.get("workspace").id,
    userId: c.get("user").id,
    email: c.get("user").email,
  });
  return c.json({ url });
});

app.post("/api/billing/cancel", async (c) => {
  await cancelWorkspaceSubscription(c.env, c.get("workspace").id);
  return c.json({ canceled: true });
});

app.post("/api/account/request-deletion", async (c) => {
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const subscription = c.get("subscription");
  if (subscription.providerSubscriptionId && subscription.status !== "canceled") {
    await cancelWorkspaceSubscription(c.env, workspaceId);
  } else {
    await db
      .update(subscriptions)
      .set({ status: "canceled", updatedAt: new Date() })
      .where(eq(subscriptions.workspaceId, workspaceId));
  }
  const deletionScheduledAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
  await db
    .update(workspaces)
    .set({ deletionScheduledAt, updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
  return c.json({ deletionScheduledAt });
});

app.get("/r/*", (c) => c.env.ASSETS.fetch(c.req.raw));
app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  const code = error instanceof z.ZodError ? "VALIDATION_ERROR" : error instanceof Error ? error.message : "INTERNAL_ERROR";
  console.error(JSON.stringify({ event: "request_error", path: c.req.path, code }));
  const status = code === "VALIDATION_ERROR" || code === "GOOGLE_OAUTH_STATE_INVALID" || error instanceof UnsafeUrlError
    ? 400
    : code === "CLIENT_NOT_FOUND" ||
        code === "REPORT_NOT_FOUND" ||
        code === "SEARCH_CONSOLE_NOT_CONNECTED" ||
        code === "SEARCH_CONSOLE_PROPERTY_NOT_FOUND" ||
        code === "SEARCH_CONSOLE_KEYWORD_NOT_FOUND"
      ? 404
      : code === "FINALIZED_REPORT_IMMUTABLE" ||
          code === "REPORT_ALREADY_DRAFT" ||
          code === "GOOGLE_REAUTH_REQUIRED" ||
          code === "SEARCH_CONSOLE_KEYWORD_EXISTS" ||
          code === "SEARCH_CONSOLE_KEYWORD_LIMIT_REACHED"
        ? 409
        : code === "SEARCH_CONSOLE_NOT_CONFIGURED"
          ? 503
        : 500;
  return c.json({ error: code }, status);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        enqueueDueChecks(env),
        enqueueDueSearchConsoleSyncs(env),
        enqueueDueFormPresenceChecks(env),
        createDueSubmissionTasks(env),
        purgeDueWorkspaceData(env),
      ]).then(([count, searchConsoleCount, formPresenceCount, formSubmissionCount, purged]) => {
        console.log(JSON.stringify({
          event: "scheduled_complete",
          monitorEnqueued: count,
          searchConsoleEnqueued: searchConsoleCount,
          formPresenceEnqueued: formPresenceCount,
          formSubmissionCreated: formSubmissionCount,
          workspacesPurged: purged,
        }));
      }),
    );
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (isSearchConsoleSyncMessage(message.body)) {
          await syncClientSearchConsole(env, message.body.workspaceId, message.body.clientId);
        } else if (isFormPresenceMessage(message.body)) {
          await processFormPresenceMessage(env, message.body);
        } else {
          await processMonitorMessage(env, message.body);
        }
        message.ack();
      } catch {
        console.error(JSON.stringify({ event: "queue_error", messageId: message.id }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, MonitorMessage | SearchConsoleSyncMessage | FormPresenceMessage>;

function isSearchConsoleSyncMessage(
  message: MonitorMessage | SearchConsoleSyncMessage | FormPresenceMessage,
): message is SearchConsoleSyncMessage {
  return "type" in message && message.type === "search_console_sync";
}

function isFormPresenceMessage(
  message: MonitorMessage | SearchConsoleSyncMessage | FormPresenceMessage,
): message is FormPresenceMessage {
  return "type" in message && message.type === "form_presence_check";
}

const clientInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactName: z.string().trim().max(120).optional().default(""),
  contactEmail: z.union([z.literal(""), z.email()]).optional().default(""),
  reportLocale: z.enum(["en", "ja"]).default("en"),
  serviceName: z.string().trim().min(1).max(120).default("Website Care"),
  assetName: z.string().trim().min(1).max(120).default("Main website"),
  url: z.url(),
  criticalUrls: z.array(z.url()).max(3).default([]),
  timezone: z.string().trim().refine(isValidTimeZone, "Invalid IANA time zone").default("UTC"),
});

const categories = ["updates", "backups", "security", "fixes", "content", "performance", "forms", "support", "other"] as const;
const maintenanceFrequencies = ["daily", "weekly", "monthly", "quarterly", "as_needed"] as const;
const searchConsolePropertySchema = z.object({
  clientId: z.string().min(1),
  siteUrl: z.string().trim().min(1).max(2_000),
});
const searchConsoleKeywordSchema = z.object({
  clientId: z.string().min(1),
  propertyId: z.string().min(1),
  keyword: z.string().trim().min(1).max(120),
});
const formMonitorInputSchema = z.object({
  clientId: z.string().min(1),
  assetId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  url: z.url(),
  formType: z.enum(["contact_form_7", "generic"]),
  turnstileWidgetName: z.string().trim().max(120).optional().default(""),
  requireTurnstile: z.boolean().optional().default(false),
  intervalHours: z.number().int().min(6).max(168).optional().default(24),
});
const formMonitorUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: z.url().optional(),
  formType: z.enum(["contact_form_7", "generic"]).optional(),
  turnstileWidgetName: z.string().trim().max(120).optional(),
  requireTurnstile: z.boolean().optional(),
  intervalHours: z.number().int().min(6).max(168).optional(),
  enabled: z.boolean().optional(),
}).refine((input) => Object.keys(input).length > 0);
const submissionCheckCreateSchema = z.object({
  trigger: z.enum(["manual", "post_change"]).optional().default("manual"),
});
const checkpointStatusSchema = z.enum(["not_checked", "passed", "failed", "manual_required"]);
const submissionCheckUpdateSchema = z.object({
  websiteSubmissionStatus: checkpointStatusSchema,
  websiteSubmittedAt: z.iso.datetime().optional(),
  wordpressReceiptStatus: checkpointStatusSchema,
  wordpressReceivedAt: z.iso.datetime().optional(),
  adminNotificationStatus: checkpointStatusSchema,
  adminNotificationAt: z.iso.datetime().optional(),
  autoReplyStatus: checkpointStatusSchema,
  autoReplyAt: z.iso.datetime().optional(),
});
const outcomeTypes = ["work_completed", "issue_resolved", "risk_reduced", "routine_verification"] as const;
const recommendationPriorities = ["low", "medium", "high"] as const;
const maintenanceItemInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(categories),
  frequency: z.enum(maintenanceFrequencies),
  sortOrder: z.number().int().min(0).max(1_000).optional().default(0),
});
const maintenanceItemUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.enum(categories).optional(),
  frequency: z.enum(maintenanceFrequencies).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000).optional(),
}).refine((input) => Object.keys(input).length > 0);
const activityInputSchema = z.object({
  clientId: z.string().min(1),
  assetId: z.string().optional().default(""),
  maintenanceItemId: z.string().optional().default(""),
  occurredAt: z.iso.datetime().optional(),
  category: z.enum(categories),
  visibility: z.enum(["client_visible", "internal_only", "recommendation"]),
  target: z.string().trim().max(300).optional().default(""),
  outcomeType: z.enum(outcomeTypes).optional().default("work_completed"),
  internalNote: z.string().trim().max(2_000).optional().default(""),
  clientDescription: z.string().trim().max(500).optional().default(""),
  resultSummary: z.string().trim().max(500).optional().default(""),
  verificationMethod: z.string().trim().max(500).optional().default(""),
  clientValue: z.string().trim().max(500).optional().default(""),
  recommendationPriority: z.enum(recommendationPriorities).optional().default("medium"),
  nextAction: z.string().trim().max(500).optional().default(""),
  aiRewriteId: z.string().min(1).optional(),
});
const rewriteInputSchema = z.object({
  clientId: z.string().min(1),
  text: z.string().trim().min(3).max(1_500),
  category: z.enum(categories),
});
const reportDraftSchema = z.object({
  clientId: z.string().min(1),
  locale: z.enum(["en", "ja"]).optional(),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
});
const reportItemSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  occurredAt: z.iso.datetime(),
});
const reportEditSchema = z.object({
  executiveSummary: z.string().trim().min(1).max(2_000),
  workCompleted: z.array(
    reportItemSchema.extend({
      category: z.string().trim().min(1).max(80),
      target: z.string().trim().max(300).optional(),
      outcomeType: z.enum(outcomeTypes).optional(),
      resultSummary: z.string().trim().max(500).optional(),
      verificationMethod: z.string().trim().max(500).optional(),
      clientValue: z.string().trim().max(500).optional(),
    }),
  ).max(200),
  problemsPrevented: z.array(
    reportItemSchema.extend({ outcomeType: z.enum(outcomeTypes).optional() }),
  ).max(200),
  recommendations: z.array(
    reportItemSchema.extend({
      priority: z.enum(recommendationPriorities).optional(),
      nextAction: z.string().trim().max(500).optional(),
    }),
  ).max(200),
  nextMonthPlan: z.string().trim().min(1).max(2_000),
  closingMessage: z.string().trim().min(1).max(2_000),
});
const finalizeSchema = z.object({
  recipientEmail: z.union([z.literal(""), z.email()]).optional().default(""),
});
const billingSchema = z.object({
  plan: z.enum(["starter", "freelancer"]),
  interval: z.enum(["monthly", "yearly"]),
});

const quickTemplates: Record<"en" | "ja", Record<(typeof categories)[number], string>> = {
  en: {
    updates: "Updated the website software to maintain compatibility and reliability.",
    backups: "Reviewed the latest website backup and recovery readiness.",
    security: "Reviewed website security and addressed the recorded maintenance item.",
    fixes: "Corrected a website issue and confirmed the affected area is working.",
    content: "Updated website content as requested.",
    performance: "Improved website performance and reviewed the affected pages.",
    forms: "Reviewed the website form and addressed the recorded issue.",
    support: "Completed the requested website support work.",
    other: "Completed the recorded website care task.",
  },
  ja: {
    updates: "互換性と安定性を保つため、Webサイトのソフトウェアを更新しました。",
    backups: "最新のバックアップと復旧準備の状態を確認しました。",
    security: "Webサイトのセキュリティを確認し、記録された保守項目に対応しました。",
    fixes: "Webサイトの問題を修正し、対象箇所が正常に動作することを確認しました。",
    content: "ご依頼に沿ってWebサイトのコンテンツを更新しました。",
    performance: "Webサイトの表示性能を改善し、対象ページを確認しました。",
    forms: "Webサイトのフォームを確認し、記録された問題に対応しました。",
    support: "ご依頼のWebサイトサポート作業を完了しました。",
    other: "記録されたWebサイト保守作業を完了しました。",
  },
};

function defaultMaintenanceItems(locale: "en" | "ja") {
  return locale === "ja"
    ? [
        { name: "公開サイト確認", category: "support" as const, frequency: "daily" as const },
        { name: "ソフトウェア更新", category: "updates" as const, frequency: "monthly" as const },
        { name: "バックアップ準備確認", category: "backups" as const, frequency: "monthly" as const },
        { name: "セキュリティ確認", category: "security" as const, frequency: "monthly" as const },
        { name: "フォーム・主要機能確認", category: "forms" as const, frequency: "monthly" as const },
      ]
    : [
        { name: "Public site checks", category: "support" as const, frequency: "daily" as const },
        { name: "Software updates", category: "updates" as const, frequency: "monthly" as const },
        { name: "Backup readiness review", category: "backups" as const, frequency: "monthly" as const },
        { name: "Security review", category: "security" as const, frequency: "monthly" as const },
        { name: "Forms and key-function review", category: "forms" as const, frequency: "monthly" as const },
      ];
}

const maxReportPdfBytes = 10 * 1024 * 1024;

async function ensureReportPdf(env: Env, workspaceId: string, reportId: string) {
  const db = drizzle(env.DB);
  const row = await db
    .select({
      revision: reports.currentRevision,
      revisionId: reportRevisions.id,
      snapshotJson: reportRevisions.snapshotJson,
      pdfKey: reportRevisions.pdfKey,
    })
    .from(reports)
    .innerJoin(
      reportRevisions,
      and(eq(reportRevisions.reportId, reports.id), eq(reportRevisions.revision, reports.currentRevision)),
    )
    .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId)))
    .get();
  if (!row) throw new Error("REPORT_NOT_FOUND");
  if (row.pdfKey) return { pdfStored: true, created: false };

  const snapshot = JSON.parse(row.snapshotJson) as ReportSnapshot;
  const response = await env.BROWSER.quickAction("pdf", { html: renderReportHtml(snapshot) });
  if (!response.ok) {
    console.error(JSON.stringify({
      event: "pdf_generation_failed",
      reportId,
      stage: "render",
      status: response.status,
      browserMs: response.headers.get("X-Browser-Ms-Used"),
    }));
    throw new Error("PDF_RENDER_FAILED");
  }
  const pdf = await response.blob();
  if (pdf.size === 0 || pdf.size > maxReportPdfBytes) {
    console.error(JSON.stringify({
      event: "pdf_generation_failed",
      reportId,
      stage: "size",
      bytes: pdf.size,
    }));
    throw new Error("PDF_SIZE_INVALID");
  }

  const pdfKey = `${workspaceId}/${reportId}/revision-${row.revision}.pdf`;
  try {
    await env.REPORTS.put(pdfKey, pdf, {
      httpMetadata: { contentType: "application/pdf" },
    });
    await db.update(reportRevisions).set({ pdfKey }).where(eq(reportRevisions.id, row.revisionId));
  } catch (error) {
    console.error(JSON.stringify({
      event: "pdf_generation_failed",
      reportId,
      stage: "storage",
      code: error instanceof Error ? error.name : "UNKNOWN",
    }));
    throw new Error("PDF_STORAGE_FAILED");
  }
  return { pdfStored: true, created: true };
}

async function finalizeReport(
  env: Env,
  workspaceId: string,
  reportId: string,
  input: z.infer<typeof finalizeSchema>,
) {
  const db = drizzle(env.DB);
  const row = await db
    .select({
      report: reports,
      snapshotJson: reportRevisions.snapshotJson,
      recipient: clients.contactEmail,
    })
    .from(reports)
    .innerJoin(
      reportRevisions,
      and(eq(reportRevisions.reportId, reports.id), eq(reportRevisions.revision, reports.currentRevision)),
    )
    .innerJoin(clients, eq(clients.id, reports.clientId))
    .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId)))
    .get();
  if (!row) throw new Error("REPORT_NOT_FOUND");
  const snapshot = JSON.parse(row.snapshotJson) as ReportSnapshot;
  const locale = normalizeLocale(snapshot.locale);
  const token = randomToken();
  const tokenHash = await sha256(token);
  await ensureReportPdf(env, workspaceId, reportId);
  await db
    .update(reports)
    .set({
      status: "finalized",
      shareTokenHash: tokenHash,
      finalizedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId)));

  const shareUrl = `${env.APP_URL}/r/${token}`;
  const recipient = input.recipientEmail || row.recipient || "";
  if (recipient) {
    const deliveryId = crypto.randomUUID();
    await db.insert(reportDeliveries).values({
      id: deliveryId,
      workspaceId,
      reportId,
      recipientEmail: recipient,
      status: "queued",
      createdAt: new Date(),
    });
    try {
      const sent = await sendTransactionalEmail(env, {
        to: recipient,
        subject: localized(locale, {
          en: `${snapshot.client.name} — ${snapshot.period.label} website care report`,
          ja: `${snapshot.client.name} — ${snapshot.period.label} Webサイト保守レポート`,
        }),
        html: localized(locale, {
          en: `<p>Your website care report is ready.</p><p><a href="${escapeHtml(shareUrl)}">View the report</a></p>`,
          ja: `<p>Webサイト保守レポートが完成しました。</p><p><a href="${escapeHtml(shareUrl)}">レポートを見る</a></p>`,
        }),
        text: localized(locale, {
          en: `Your website care report is ready: ${shareUrl}`,
          ja: `Webサイト保守レポートが完成しました: ${shareUrl}`,
        }),
      });
      await db
        .update(reportDeliveries)
        .set({
          status: "sent",
          providerMessageId: sent.messageId,
          sentAt: new Date(),
        })
        .where(eq(reportDeliveries.id, deliveryId));
    } catch {
      await db
        .update(reportDeliveries)
        .set({ status: "failed", errorCode: "EMAIL_SEND_FAILED" })
        .where(eq(reportDeliveries.id, deliveryId));
    }
  }
  return { reportId, shareUrl, pdfStored: true };
}

async function findPublicReport(env: Env, token: string) {
  const tokenHash = await sha256(token);
  const db = drizzle(env.DB);
  const row = await db
    .select({
      id: reports.id,
      firstViewedAt: reports.firstViewedAt,
      snapshotJson: reportRevisions.snapshotJson,
      pdfKey: reportRevisions.pdfKey,
    })
    .from(reports)
    .innerJoin(
      reportRevisions,
      and(eq(reportRevisions.reportId, reports.id), eq(reportRevisions.revision, reports.currentRevision)),
    )
    .where(and(eq(reports.shareTokenHash, tokenHash), eq(reports.status, "finalized")))
    .get();
  if (!row) return null;
  return { ...row, snapshot: JSON.parse(row.snapshotJson) as ReportSnapshot };
}

async function clientReportLocale(env: Env, workspaceId: string, clientId: string): Promise<"en" | "ja"> {
  const db = drizzle(env.DB);
  const row = await db
    .select({ reportLocale: clients.reportLocale })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.workspaceId, workspaceId)))
    .get();
  if (!row) throw new Error("CLIENT_NOT_FOUND");
  return normalizeLocale(row.reportLocale);
}

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "care-report";
}

function safeJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
