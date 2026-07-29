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
import { reportPeriodLabel } from "../lib/report-period";

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
    db
      .select({ name: workspaces.name, timezone: workspaces.timezone })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get(),
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
  const label = reportPeriodLabel(periodStart, workspace.timezone);

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
  const healthTone =
    snapshot.currentHealth.total === 0
      ? "neutral"
      : snapshot.currentHealth.passed === snapshot.currentHealth.total
        ? "healthy"
        : "attention";
  const list = (items: Array<{ summary: string }>, emptyText: string, icon: "check" | "arrow") =>
    items.length
      ? `<ul>${items.map((item) => `<li><span class="list-icon">${icon === "check" ? "✓" : "→"}</span><p>${escapeHtml(item.summary)}</p></li>`).join("")}</ul>`
      : `<p class="empty">${escapeHtml(emptyText)}</p>`;
  const formattedDate = (value: string) =>
    new Date(value).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
  const generatedDate = new Date(snapshot.generatedAt).toLocaleDateString("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
@page{size:Letter;margin:0}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Arial,Helvetica,sans-serif;color:#18372f;background:#fffdfa;margin:0}
main{width:8.5in;margin:0 auto;background:#fffdfa}
.cover{height:4.2in;position:relative;overflow:hidden;padding:.55in .65in;color:#fff;background:#1b4a3f}
.cover:before{content:"";position:absolute;width:5.2in;height:5.2in;right:-2.1in;top:-2.2in;border:1px solid rgba(222,239,227,.18);border-radius:50%;box-shadow:0 0 0 .65in rgba(222,239,227,.035),0 0 0 1.3in rgba(222,239,227,.02)}
.cover:after{content:"";position:absolute;width:3.8in;height:1px;right:.4in;bottom:1.25in;background:linear-gradient(90deg,transparent,rgba(206,232,216,.62));transform:rotate(-32deg)}
.cover-top,.cover-copy,.cover-proof{position:relative;z-index:1}
.cover-top{display:flex;justify-content:space-between;align-items:center;color:#c6dacf;font-size:8px;font-weight:700;letter-spacing:1.7px}
.edition{padding:6px 10px;border:1px solid rgba(255,255,255,.22);border-radius:20px}
.cover-copy{margin-top:.78in}
.overline{margin:0 0 10px;color:#a7c8b8;font-size:10px}
h1{max-width:6.8in;margin:0 0 14px;font-family:Georgia,"Times New Roman",serif;font-size:46px;font-weight:400;line-height:1;letter-spacing:-1px}
.period{color:#d2e1da;font-size:11px}
.cover-proof{max-width:5.8in;display:grid;grid-template-columns:38px 1.2in 1fr;align-items:center;gap:13px;margin-top:.73in;padding-top:17px;border-top:1px solid rgba(255,255,255,.2)}
.status-mark{width:35px;height:35px;display:grid;place-items:center;border-radius:50%;font-size:16px;color:#fff;background:#679479}
.status-mark.attention{background:#bf7a61}.status-mark.neutral{background:#82928c}
.cover-proof small,.cover-proof b{display:block}.cover-proof small{color:#9fc1b2;font-size:6px;letter-spacing:1.1px}.cover-proof b{margin-top:3px;font-family:Georgia,serif;font-size:14px;font-weight:400}
.cover-proof p{margin:0;color:#b9cec5;font-size:7px;line-height:1.45}
.content{padding:.48in .65in .25in}
.section-heading{display:flex;align-items:flex-start;gap:13px}
.section-heading>span{color:#96a39d;font-family:Georgia,serif;font-size:15px}
.section-heading small,.metric small,.work b,.insight small,.closing small{font-size:6px;font-weight:700;letter-spacing:1.3px}
.section-heading p{margin:5px 0 0;color:#899791;font-size:7px}
.summary{display:grid;grid-template-columns:1.55in 1fr;gap:.35in;padding-bottom:.42in;border-bottom:1px solid #e1ded6}
.summary-copy{position:relative;padding-left:.28in}
.quote{position:absolute;left:0;top:-.12in;color:#9fbdaa;font-family:Georgia,serif;font-size:42px;line-height:1}
.summary h2{position:relative;margin:0;font-family:Georgia,serif;font-size:19px;font-weight:400;line-height:1.38}
.metrics{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:1px;margin-top:.34in;background:#d7ded9;border:1px solid #d7ded9}
.metric{min-height:1.05in;padding:.2in;background:#f0f4ef}
.metric.primary{position:relative;padding-left:.68in;background:#dfeadf}
.metric .status-mark{position:absolute;left:.19in;top:.22in;width:32px;height:32px}
.metric small{color:#657d72}.metric strong{display:block;margin-top:.12in;font-family:Georgia,serif;font-size:23px;font-weight:400;line-height:1}
.metric strong span{font-family:Arial,sans-serif;font-size:7px;color:#73887f}.metric p{margin:7px 0 0;color:#6c8078;font-size:6.5px;line-height:1.35}
.evidence-note{margin:8px 0 .35in;color:#89958f;font-size:5.5px;text-align:right}
.work{break-inside:auto}
.work-list{margin:.21in 0 0 1.55in}
.work-item{min-height:.52in;display:grid;grid-template-columns:.34in 1fr .55in;gap:.14in;align-items:center;padding:.1in 0;border-top:1px solid #e2dfd6;break-inside:avoid}
.work-item:last-child{border-bottom:1px solid #e2dfd6}
.work-index{width:24px;height:24px;display:grid;place-items:center;border-radius:50%;color:#426b5c;background:#e5eee6;font-family:Georgia,serif;font-size:8px}
.work b{display:block;color:#5c786d;text-transform:uppercase}.work h3{margin:4px 0 0;font-size:8.5px;font-weight:500;line-height:1.35}.work time{color:#7f8c87;font-size:6.5px;text-align:right}
.insights{display:grid;grid-template-columns:1fr 1fr;margin-top:.38in;break-inside:avoid}
.insight{min-height:4.2in;padding:.5in .3in;background:#f0efe9}.insight.recommendations{color:#fff;background:#9c624e}
.insight-title{display:flex;gap:10px;align-items:flex-start}.insight-title>span{color:#97a39e;font-family:Georgia,serif;font-size:14px}.recommendations .insight-title>span{color:#e7bdab}
.insight ul{margin:.18in 0 0;padding:0;list-style:none}.insight li{display:grid;grid-template-columns:20px 1fr;gap:8px;padding:7px 0;border-top:1px solid #d8d7cf;break-inside:avoid}.recommendations li{border-color:rgba(255,255,255,.2)}
.list-icon{width:18px;height:18px;display:grid;place-items:center;border-radius:50%;color:#426d5c;background:#dce8dd;font-size:8px}.recommendations .list-icon{color:#fff;background:rgba(255,255,255,.14)}
.insight li p{margin:2px 0 0;font-size:7px;line-height:1.45}.empty{color:#7e8d87;font-size:7px}.recommendations .empty{color:#eed8cf}
.closing{position:relative;min-height:4in;overflow:hidden;margin-top:.35in;padding:.6in .65in;display:flex;flex-direction:column;justify-content:center;text-align:center;background:#e2ece2;break-inside:avoid}
.closing:before{content:"RP";position:absolute;left:50%;top:-.08in;color:rgba(31,80,65,.055);font-family:Georgia,serif;font-size:86px;transform:translateX(-50%)}
.closing small,.closing h2{position:relative}.closing small{color:#5e796d}.closing h2{max-width:6.3in;margin:.13in auto 0;font-family:Georgia,serif;font-size:17px;font-weight:400;line-height:1.4}
footer{min-height:.95in;display:flex;justify-content:space-between;align-items:center;padding:.14in .65in;color:#75857f;font-size:6px}
.brand{display:flex;align-items:center;gap:7px;color:#18372f;font-size:9px;font-weight:700}.brand-mark{width:20px;height:20px;display:flex;align-items:flex-end;justify-content:center;gap:2px;padding:4px;border:1px solid #18372f;border-radius:50%}.brand-mark i{display:block;width:2px;background:#18372f;border-radius:2px}.brand-mark i:nth-child(1){height:5px}.brand-mark i:nth-child(2){height:10px}.brand-mark i:nth-child(3){height:7px}
.footer-meta{text-align:right;line-height:1.5}
</style></head><body><main>
<section class="cover">
  <div class="cover-top"><span>WEBSITE CARE / MONTHLY RECORD</span><span class="edition">${escapeHtml(snapshot.period.label)}</span></div>
  <div class="cover-copy"><p class="overline">Prepared exclusively for</p><h1>${escapeHtml(snapshot.client.name)}</h1><span class="period">${escapeHtml(snapshot.period.label)}</span></div>
  <div class="cover-proof"><span class="status-mark ${healthTone}">✓</span><div><small>CARE STATUS</small><b>${escapeHtml(snapshot.currentHealth.status)}</b></div><p>Based on recorded maintenance and scheduled public-site observations.</p></div>
</section>
<div class="content">
  <section class="summary">
    <div class="section-heading"><span>01</span><div><small>EXECUTIVE SUMMARY</small><p>The month at a glance</p></div></div>
    <div class="summary-copy"><span class="quote">“</span><h2>${escapeHtml(snapshot.executiveSummary)}</h2></div>
  </section>
  <section class="metrics">
    <article class="metric primary"><span class="status-mark ${healthTone}">✓</span><small>OBSERVED STATUS</small><strong>${escapeHtml(snapshot.currentHealth.status)}</strong><p>${snapshot.currentHealth.passed} of ${snapshot.currentHealth.total} scheduled checks passed</p></article>
    <article class="metric"><small>CHECKS PASSED</small><strong>${snapshot.currentHealth.passed}<span> / ${snapshot.currentHealth.total}</span></strong><p>Scheduled public checks</p></article>
    <article class="metric"><small>CARE COMPLETED</small><strong>${snapshot.workCompleted.length}<span> ${snapshot.workCompleted.length === 1 ? "item" : "items"}</span></strong><p>Client-visible work recorded</p></article>
  </section>
  <p class="evidence-note">Scheduled observations only. This report does not estimate uptime or guarantee availability.</p>
  <section class="work">
    <div class="section-heading"><span>02</span><div><small>WORK COMPLETED</small><p>The care behind the result</p></div></div>
    <div class="work-list">${snapshot.workCompleted.length
      ? snapshot.workCompleted.map((item, index) => `<article class="work-item"><span class="work-index">${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(item.category)}</b><h3>${escapeHtml(item.summary)}</h3></div><time>${escapeHtml(formattedDate(item.occurredAt))}</time></article>`).join("")
      : '<p class="empty">No client-visible maintenance activities were recorded in this period.</p>'}</div>
  </section>
  <section class="insights">
    <article class="insight"><div class="insight-title"><span>03</span><small>PROBLEMS PREVENTED</small></div>${list(snapshot.problemsPrevented, "No preventable issues were recorded.", "check")}</article>
    <article class="insight recommendations"><div class="insight-title"><span>04</span><small>RECOMMENDATIONS</small></div>${list(snapshot.recommendations, "No recommendations this month.", "arrow")}</article>
  </section>
  <section class="closing"><small>CLOSING NOTE</small><h2>${escapeHtml(snapshot.closingMessage)}</h2></section>
</div>
<footer><div class="brand"><span class="brand-mark"><i></i><i></i><i></i></span>${escapeHtml(snapshot.appName)}</div><div class="footer-meta">Client-visible website care<br>Generated ${escapeHtml(generatedDate)}</div></footer>
</main></body></html>`;
}
