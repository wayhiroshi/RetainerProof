import { and, count, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { createAuth } from "./auth";
import {
  activities,
  aiRewrites,
  clients,
  managedAssets,
  reportDeliveries,
  reportRevisions,
  reports,
  services,
  subscriptions,
  workspaces,
} from "./db/schema";
import { randomToken, sha256 } from "./lib/crypto";
import { escapeHtml, sendTransactionalEmail } from "./lib/email";
import { isValidTimeZone, reportPeriod } from "./lib/report-period";
import { assertPublicHttpUrl } from "./lib/url-security";
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
import { buildReportSnapshot, renderReportHtml, saveDraft, type ReportSnapshot } from "./services/reports";
import { purgeDueWorkspaceData } from "./services/deletion";

type AppUser = { id: string; name: string; email: string };
type AppVariables = {
  user: AppUser;
  workspace: { id: string; name: string; timezone: string; plan: string };
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
  return c.json({
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
        message: `${snapshot.currentHealth.passed} of ${snapshot.currentHealth.total} scheduled checks passed`,
      },
      workCompleted: snapshot.workCompleted.map((item) => ({
        category: item.category,
        description: item.summary,
        date: item.occurredAt,
      })),
      problemsPrevented: snapshot.problemsPrevented.map((item) => item.summary),
      recommendations: snapshot.recommendations.map((item) => item.summary),
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

app.get("/api/clients", async (c) => {
  const db = drizzle(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      contactName: clients.contactName,
      contactEmail: clients.contactEmail,
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
    .orderBy(desc(clients.createdAt));
  return c.json({
    clients: rows.map((row) => ({
      id: row.id,
      name: row.name,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
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
  await db.batch([
    db.insert(clients).values({
      id: clientId,
      workspaceId,
      name: input.name,
      contactName: input.contactName || null,
      contactEmail: input.contactEmail || null,
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
    db
      .update(workspaces)
      .set({ timezone: input.timezone, updatedAt: now })
      .where(eq(workspaces.id, workspaceId)),
  ]);
  return c.json({ id: clientId, assetId }, 201);
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
      internalNote: activities.internalNote,
      clientDescription: activities.clientSummary,
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
  const template = quickTemplates[input.category];
  const clientSummary = input.clientDescription.trim() || template;
  const db = drizzle(c.env.DB);
  const id = crypto.randomUUID();
  await db.insert(activities).values({
    id,
    workspaceId,
    clientId: input.clientId,
    assetId: input.assetId || null,
    occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
    category: input.category,
    visibility: input.visibility,
    internalNote: input.internalNote,
    clientSummary,
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
  const output = await rewriteForClient(c.env, {
    workspaceId: c.get("workspace").id,
    userId: c.get("user").id,
    sourceText: input.text,
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
    })
    .from(reports)
    .innerJoin(clients, eq(clients.id, reports.clientId))
    .where(eq(reports.workspaceId, workspaceId))
    .orderBy(desc(reports.periodStart));
  return c.json({ reports: rows });
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
  const { start, end } = reportPeriod(input.periodStart, input.periodEnd, c.get("workspace").timezone);
  const snapshot = await buildReportSnapshot(c.env, workspaceId, input.clientId, start, end);
  return c.json(await saveDraft(c.env, workspaceId, input.clientId, start, end, snapshot), 201);
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
  return c.json({ error: code }, code === "VALIDATION_ERROR" ? 400 : 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      Promise.all([enqueueDueChecks(env), purgeDueWorkspaceData(env)]).then(([count, purged]) => {
        console.log(JSON.stringify({ event: "scheduled_complete", monitorEnqueued: count, workspacesPurged: purged }));
      }),
    );
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processMonitorMessage(env, message.body);
        message.ack();
      } catch {
        console.error(JSON.stringify({ event: "monitor_queue_error", messageId: message.id }));
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, MonitorMessage>;

const clientInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactName: z.string().trim().max(120).optional().default(""),
  contactEmail: z.union([z.literal(""), z.email()]).optional().default(""),
  serviceName: z.string().trim().min(1).max(120).default("Website Care"),
  assetName: z.string().trim().min(1).max(120).default("Main website"),
  url: z.url(),
  criticalUrls: z.array(z.url()).max(3).default([]),
  timezone: z.string().trim().refine(isValidTimeZone, "Invalid IANA time zone").default("UTC"),
});

const categories = ["updates", "backups", "security", "fixes", "content", "performance", "forms", "support", "other"] as const;
const activityInputSchema = z.object({
  clientId: z.string().min(1),
  assetId: z.string().optional().default(""),
  occurredAt: z.iso.datetime().optional(),
  category: z.enum(categories),
  visibility: z.enum(["client_visible", "internal_only", "recommendation"]),
  internalNote: z.string().trim().max(2_000).optional().default(""),
  clientDescription: z.string().trim().max(500).optional().default(""),
  aiRewriteId: z.string().min(1).optional(),
});
const rewriteInputSchema = z.object({
  text: z.string().trim().min(3).max(1_500),
  category: z.enum(categories),
});
const reportDraftSchema = z.object({
  clientId: z.string().min(1),
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
    }),
  ).max(200),
  problemsPrevented: z.array(reportItemSchema).max(200),
  recommendations: z.array(reportItemSchema).max(200),
  closingMessage: z.string().trim().min(1).max(2_000),
});
const finalizeSchema = z.object({
  recipientEmail: z.union([z.literal(""), z.email()]).optional().default(""),
});
const billingSchema = z.object({
  plan: z.enum(["starter", "freelancer"]),
  interval: z.enum(["monthly", "yearly"]),
});

const quickTemplates: Record<(typeof categories)[number], string> = {
  updates: "Updated the website software to maintain compatibility and reliability.",
  backups: "Reviewed the latest website backup and recovery readiness.",
  security: "Reviewed website security and addressed the recorded maintenance item.",
  fixes: "Corrected a website issue and confirmed the affected area is working.",
  content: "Updated website content as requested.",
  performance: "Improved website performance and reviewed the affected pages.",
  forms: "Reviewed the website form and addressed the recorded issue.",
  support: "Completed the requested website support work.",
  other: "Completed the recorded website care task.",
};

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
        subject: `${snapshot.client.name} — ${snapshot.period.label} website care report`,
        html: `<p>Your website care report is ready.</p><p><a href="${escapeHtml(shareUrl)}">View the report</a></p>`,
        text: `Your website care report is ready: ${shareUrl}`,
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
