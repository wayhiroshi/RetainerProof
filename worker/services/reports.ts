import { and, asc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  activities,
  checkRuns,
  clients,
  managedAssets,
  reportRevisions,
  reports,
  workspaces,
} from "../db/schema";
import { escapeHtml } from "../lib/email";

export interface ReportSnapshot {
  appName: string;
  client: { name: string };
  period: { start: string; end: string; label: string };
  executiveSummary: string;
  currentHealth: {
    passed: number;
    total: number;
    averageResponseMs: number | null;
    status: "Healthy" | "Needs attention" | "No checks";
  };
  workCompleted: Array<{ category: string; summary: string; occurredAt: string }>;
  problemsPrevented: Array<{ summary: string; occurredAt: string }>;
  recommendations: Array<{ summary: string; occurredAt: string }>;
  closingMessage: string;
  generatedAt: string;
}

export async function buildReportSnapshot(
  env: Env,
  workspaceId: string,
  clientId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ReportSnapshot> {
  const db = drizzle(env.DB);
  const [client, workspace, activityRows, runRows] = await Promise.all([
    db
      .select({ name: clients.name })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.workspaceId, workspaceId)))
      .get(),
    db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).get(),
    db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.workspaceId, workspaceId),
          eq(activities.clientId, clientId),
          gte(activities.occurredAt, periodStart),
          lte(activities.occurredAt, periodEnd),
        ),
      )
      .orderBy(asc(activities.occurredAt)),
    db
      .select({
        status: checkRuns.status,
        responseMs: checkRuns.responseMs,
        attempt: checkRuns.attempt,
        target: checkRuns.target,
        checkedAt: checkRuns.checkedAt,
      })
      .from(checkRuns)
      .innerJoin(managedAssets, eq(checkRuns.assetId, managedAssets.id))
      .where(
        and(
          eq(checkRuns.workspaceId, workspaceId),
          eq(managedAssets.clientId, clientId),
          gte(checkRuns.checkedAt, periodStart),
          lte(checkRuns.checkedAt, periodEnd),
        ),
      ),
  ]);
  if (!client || !workspace) throw new Error("REPORT_CONTEXT_NOT_FOUND");

  const finalRunsBySchedule = new Map<string, (typeof runRows)[number]>();
  for (const run of runRows) {
    const scheduleKey = `${run.target}:${run.checkedAt.toISOString().slice(0, 10)}`;
    const existing = finalRunsBySchedule.get(scheduleKey);
    if (!existing || run.attempt > existing.attempt) finalRunsBySchedule.set(scheduleKey, run);
  }
  const finalRuns = [...finalRunsBySchedule.values()];
  const visible = activityRows.filter((row) => row.visibility === "client_visible");
  const recommendations = activityRows.filter((row) => row.visibility === "recommendation");
  const problems = visible.filter((row) => ["fixes", "security", "forms"].includes(row.category));
  const passed = finalRuns.filter((run) => run.status === "passed").length;
  const measured = finalRuns.map((run) => run.responseMs).filter((value): value is number => value !== null);
  const averageResponseMs =
    measured.length > 0 ? Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length) : null;
  const healthStatus =
    finalRuns.length === 0 ? "No checks" : passed === finalRuns.length ? "Healthy" : "Needs attention";
  const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    periodStart,
  );

  return {
    appName: env.APP_NAME,
    client,
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
      label,
    },
    executiveSummary:
      visible.length > 0
        ? `${workspace.name} completed ${visible.length} website care ${visible.length === 1 ? "task" : "tasks"} during ${label}.`
        : `Routine website care and public health checks were reviewed during ${label}.`,
    currentHealth: {
      passed,
      total: finalRuns.length,
      averageResponseMs,
      status: healthStatus,
    },
    workCompleted: visible.map((row) => ({
      category: row.category,
      summary: row.clientSummary,
      occurredAt: row.occurredAt.toISOString(),
    })),
    problemsPrevented: problems.map((row) => ({
      summary: row.clientSummary,
      occurredAt: row.occurredAt.toISOString(),
    })),
    recommendations: recommendations.map((row) => ({
      summary: row.clientSummary,
      occurredAt: row.occurredAt.toISOString(),
    })),
    closingMessage: "Everything important has been reviewed. Reply to your website care provider with any questions.",
    generatedAt: new Date().toISOString(),
  };
}

export async function saveDraft(
  env: Env,
  workspaceId: string,
  clientId: string,
  periodStart: Date,
  periodEnd: Date,
  snapshot: ReportSnapshot,
) {
  const db = drizzle(env.DB);
  const existing = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.workspaceId, workspaceId),
        eq(reports.clientId, clientId),
        eq(reports.periodStart, periodStart),
      ),
    )
    .get();
  const now = new Date();
  if (existing?.status === "finalized") throw new Error("FINALIZED_REPORT_IMMUTABLE");
  const reportId = existing?.id ?? crypto.randomUUID();
  const revision = existing ? existing.currentRevision + 1 : 1;
  if (existing) {
    await db
      .update(reports)
      .set({ currentRevision: revision, status: "draft", updatedAt: now })
      .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId)));
  } else {
    await db.insert(reports).values({
      id: reportId,
      workspaceId,
      clientId,
      periodStart,
      periodEnd,
      status: "draft",
      currentRevision: revision,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(reportRevisions).values({
    id: crypto.randomUUID(),
    workspaceId,
    reportId,
    revision,
    snapshotJson: JSON.stringify(snapshot),
    createdAt: now,
  });
  return { reportId, revision, snapshot };
}

export function renderReportHtml(snapshot: ReportSnapshot): string {
  const list = (items: Array<{ summary: string }>) =>
    items.length
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item.summary)}</li>`).join("")}</ul>`
      : "<p>None recorded this period.</p>";
  const work = snapshot.workCompleted.map((item) => ({ summary: item.summary }));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#19322b;background:#f6f3ed;margin:0}
main{max-width:760px;margin:0 auto;padding:48px 24px}
.report{background:white;border-radius:24px;padding:44px;box-shadow:0 20px 60px rgba(24,60,50,.1)}
.eyebrow{color:#1d7d60;text-transform:uppercase;letter-spacing:.12em;font-size:12px;font-weight:700}
h1{font-family:Georgia,serif;font-size:42px;margin:8px 0}.period{color:#66736e}
section{border-top:1px solid #dfe5e2;padding-top:24px;margin-top:28px}h2{font-size:18px}
.health{display:flex;gap:16px;flex-wrap:wrap}.metric{background:#edf7f2;padding:16px;border-radius:14px;min-width:140px}
.metric strong{display:block;font-size:24px}li{margin:10px 0;line-height:1.5}
footer{margin-top:36px;color:#68736f;font-size:13px}@media(max-width:600px){.report{padding:28px}h1{font-size:34px}}
@media print{body{background:white}main{padding:0}.report{box-shadow:none;border-radius:0}}
</style></head><body><main><article class="report">
<div class="eyebrow">Website care report</div><h1>${escapeHtml(snapshot.client.name)}</h1>
<p class="period">${escapeHtml(snapshot.period.label)}</p><p>${escapeHtml(snapshot.executiveSummary)}</p>
<section><h2>Current health</h2><div class="health">
<div class="metric"><strong>${escapeHtml(snapshot.currentHealth.status)}</strong>Status</div>
<div class="metric"><strong>${snapshot.currentHealth.passed}/${snapshot.currentHealth.total}</strong>Checks passed</div>
<div class="metric"><strong>${snapshot.currentHealth.averageResponseMs ?? "—"}${snapshot.currentHealth.averageResponseMs ? " ms" : ""}</strong>Average response</div>
</div></section>
<section><h2>Work completed</h2>${list(work)}</section>
<section><h2>Problems prevented</h2>${list(snapshot.problemsPrevented)}</section>
<section><h2>Recommendations</h2>${list(snapshot.recommendations)}</section>
<section><h2>Closing note</h2><p>${escapeHtml(snapshot.closingMessage)}</p></section>
<footer>Prepared with ${escapeHtml(snapshot.appName)} · ${escapeHtml(snapshot.generatedAt.slice(0, 10))}</footer>
</article></main></body></html>`;
}
