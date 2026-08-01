import { and, asc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  activities,
  checkRuns,
  clients,
  maintenanceItems,
  managedAssets,
  reportRevisions,
  reports,
  workspaces,
} from "../db/schema";
import { escapeHtml } from "../lib/email";
import { localized, normalizeLocale, type Locale } from "../lib/locale";
import { reportPeriodLabel } from "../lib/report-period";
import {
  buildSearchPerformanceSnapshot,
  type SearchPerformanceSnapshot,
} from "./search-console";

export interface ReportSnapshot {
  locale?: Locale;
  appName: string;
  client: { name: string };
  period: { start: string; end: string; label: string };
  executiveSummary: string;
  currentHealth: {
    passed: number;
    total: number;
    averageResponseMs: number | null;
    status: "Healthy" | "Needs attention" | "No checks";
    targets?: Array<{
      target: string;
      passed: number;
      total: number;
      averageResponseMs: number | null;
      tlsExpiresAt: string | null;
      status: "Healthy" | "Needs attention";
    }>;
  };
  maintenanceCoverage?: Array<{
    name: string;
    category: string;
    frequency: string;
    completedCount: number;
    status: "completed" | "not_recorded" | "as_needed";
  }>;
  searchPerformance?: SearchPerformanceSnapshot | null;
  workCompleted: Array<{
    category: string;
    summary: string;
    occurredAt: string;
    target?: string;
    outcomeType?: string;
    resultSummary?: string;
    verificationMethod?: string;
    clientValue?: string;
  }>;
  problemsPrevented: Array<{ summary: string; occurredAt: string; outcomeType?: string }>;
  recommendations: Array<{
    summary: string;
    occurredAt: string;
    priority?: "low" | "medium" | "high";
    nextAction?: string;
  }>;
  nextMonthPlan?: string;
  closingMessage: string;
  generatedAt: string;
}

export async function buildReportSnapshot(
  env: Env,
  workspaceId: string,
  clientId: string,
  periodStart: Date,
  periodEnd: Date,
  localeOverride?: Locale,
): Promise<ReportSnapshot> {
  const db = drizzle(env.DB);
  const [client, workspace, activityRows, runRows, maintenanceRows] = await Promise.all([
    db
      .select({ name: clients.name, reportLocale: clients.reportLocale })
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
        tlsExpiresAt: checkRuns.tlsExpiresAt,
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
    db
      .select()
      .from(maintenanceItems)
      .where(
        and(
          eq(maintenanceItems.workspaceId, workspaceId),
          eq(maintenanceItems.clientId, clientId),
          eq(maintenanceItems.enabled, true),
        ),
      )
      .orderBy(asc(maintenanceItems.sortOrder), asc(maintenanceItems.createdAt)),
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
  const outcomes = visible.filter((row) => row.outcomeType !== "work_completed");
  const passed = finalRuns.filter((run) => run.status === "passed").length;
  const measured = finalRuns.map((run) => run.responseMs).filter((value): value is number => value !== null);
  const averageResponseMs =
    measured.length > 0 ? Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length) : null;
  const healthStatus =
    finalRuns.length === 0 ? "No checks" : passed === finalRuns.length ? "Healthy" : "Needs attention";
  const targets = [...new Set(finalRuns.map((run) => run.target))].map((target) => {
    const targetRuns = finalRuns.filter((run) => run.target === target);
    const targetPassed = targetRuns.filter((run) => run.status === "passed").length;
    const responseTimes = targetRuns
      .map((run) => run.responseMs)
      .filter((value): value is number => value !== null);
    const latestTlsExpiry = targetRuns
      .filter((run) => run.tlsExpiresAt)
      .sort((a, b) => b.checkedAt.getTime() - a.checkedAt.getTime())[0]?.tlsExpiresAt;
    return {
      target,
      passed: targetPassed,
      total: targetRuns.length,
      averageResponseMs:
        responseTimes.length > 0
          ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
          : null,
      tlsExpiresAt: latestTlsExpiry?.toISOString() ?? null,
      status: targetPassed === targetRuns.length ? "Healthy" as const : "Needs attention" as const,
    };
  });
  const maintenanceCoverage = maintenanceRows.map((item) => {
    const completedCount = activityRows.filter((row) => row.maintenanceItemId === item.id).length;
    return {
      name: item.name,
      category: item.category,
      frequency: item.frequency,
      completedCount,
      status:
        completedCount > 0
          ? "completed" as const
          : item.frequency === "as_needed"
            ? "as_needed" as const
            : "not_recorded" as const,
    };
  });
  const completedMaintenance = maintenanceCoverage.filter((item) => item.status === "completed").length;
  const locale = normalizeLocale(localeOverride ?? client.reportLocale);
  const label = reportPeriodLabel(periodStart, workspace.timezone, locale);
  const searchPerformance = await buildSearchPerformanceSnapshot(env, {
    workspaceId,
    clientId,
    periodStart,
    periodEnd,
    timeZone: workspace.timezone,
  });
  const trackedKeywordCount = searchPerformance?.keywords.length ?? 0;
  const plannedMaintenanceNames = maintenanceCoverage.slice(0, 3).map((item) => item.name);
  const additionalPlannedCount = Math.max(maintenanceCoverage.length - plannedMaintenanceNames.length, 0);
  const plannedMaintenanceLabel = plannedMaintenanceNames.join(locale === "ja" ? "、" : ", ");

  return {
    locale,
    appName: env.APP_NAME,
    client: { name: client.name },
    period: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
      label,
    },
    executiveSummary: localized(locale, {
      en:
        `${label}: ${workspace.name} recorded ${visible.length} client-visible care ${visible.length === 1 ? "task" : "tasks"}${
          maintenanceCoverage.length
            ? ` and completed ${completedMaintenance} of ${maintenanceCoverage.length} configured care items`
            : ""
        }. ${finalRuns.length ? `${passed} of ${finalRuns.length} scheduled public checks passed.` : "No scheduled public checks were recorded."}${
          healthStatus === "Needs attention" ? " One or more observations need attention." : ""
        }${trackedKeywordCount ? ` Finalized Search Console data was included for ${trackedKeywordCount} tracked ${trackedKeywordCount === 1 ? "keyword" : "keywords"}.` : ""}`,
      ja:
        `${label}は、${workspace.name}がお客様向けの定期保守作業を${visible.length}件記録しました。${
          maintenanceCoverage.length
            ? `設定済み保守項目${maintenanceCoverage.length}件のうち${completedMaintenance}件に実施記録があります。`
            : ""
        }${finalRuns.length ? `公開サイトの定期確認は${finalRuns.length}回中${passed}回成功しました。` : "公開サイトの定期確認記録はありません。"}${
          healthStatus === "Needs attention" ? "確認が必要な観測結果があります。" : ""
        }${trackedKeywordCount ? `Search Consoleの確定データを追跡キーワード${trackedKeywordCount}件について掲載しています。` : ""}`,
    }),
    currentHealth: {
      passed,
      total: finalRuns.length,
      averageResponseMs,
      status: healthStatus,
      targets,
    },
    maintenanceCoverage,
    searchPerformance,
    workCompleted: visible.map((row) => ({
      category: row.category,
      summary: row.clientSummary,
      occurredAt: row.occurredAt.toISOString(),
      target: row.target,
      outcomeType: row.outcomeType,
      resultSummary: row.resultSummary,
      verificationMethod: row.verificationMethod,
      clientValue: row.clientValue,
    })),
    problemsPrevented: outcomes.map((row) => ({
      summary: row.resultSummary || row.clientValue || row.clientSummary,
      occurredAt: row.occurredAt.toISOString(),
      outcomeType: row.outcomeType,
    })),
    recommendations: recommendations.map((row) => ({
      summary: row.clientSummary,
      occurredAt: row.occurredAt.toISOString(),
      priority: row.recommendationPriority ?? "medium",
      nextAction: row.nextAction,
    })),
    nextMonthPlan: localized(locale, {
      en: maintenanceCoverage.length
        ? `Next month: continue ${plannedMaintenanceLabel}${
          additionalPlannedCount ? ` and ${additionalPlannedCount} more configured care ${additionalPlannedCount === 1 ? "item" : "items"}` : ""
        }, along with scheduled public-site observations.${recommendations.length ? " Review the recorded recommendations before the next service window." : ""}`
        : `Continue scheduled public-site observations next month.${recommendations.length ? " Review the recorded recommendations before the next service window." : ""}`,
      ja: maintenanceCoverage.length
        ? `翌月は${plannedMaintenanceLabel}${
          additionalPlannedCount ? `ほか${additionalPlannedCount}件` : ""
        }の保守予定と、公開サイトの定期確認を継続します。${recommendations.length ? "次回の保守前に記録済みの提案事項を確認します。" : ""}`
        : `翌月も公開サイトの定期確認を継続します。${recommendations.length ? "次回の保守前に記録済みの提案事項を確認します。" : ""}`,
    }),
    closingMessage: localized(locale, {
      en: "Everything important has been reviewed. Reply to your website care provider with any questions.",
      ja: "重要な項目はすべて確認済みです。ご不明な点はWebサイト保守担当者までお気軽にご連絡ください。",
    }),
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

export async function saveCorrectionDraft(
  env: Env,
  workspaceId: string,
  reportId: string,
  snapshot: ReportSnapshot,
) {
  const db = drizzle(env.DB);
  const existing = await db
    .select({
      currentRevision: reports.currentRevision,
      status: reports.status,
    })
    .from(reports)
    .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId)))
    .get();
  if (!existing) throw new Error("REPORT_NOT_FOUND");
  if (existing.status === "draft") throw new Error("REPORT_ALREADY_DRAFT");

  const revision = existing.currentRevision + 1;
  const now = new Date();
  await db.batch([
    db.insert(reportRevisions).values({
      id: crypto.randomUUID(),
      workspaceId,
      reportId,
      revision,
      snapshotJson: JSON.stringify(snapshot),
      createdAt: now,
    }),
    db
      .update(reports)
      .set({
        currentRevision: revision,
        status: "draft",
        shareTokenHash: null,
        firstViewedAt: null,
        finalizedAt: null,
        updatedAt: now,
      })
      .where(and(eq(reports.id, reportId), eq(reports.workspaceId, workspaceId))),
  ]);
  return { reportId, revision, snapshot };
}

export function renderReportHtml(snapshot: ReportSnapshot): string {
  const locale = normalizeLocale(snapshot.locale);
  const copy = reportCopy[locale];
  const healthTone =
    snapshot.currentHealth.total === 0
      ? "neutral"
      : snapshot.currentHealth.passed === snapshot.currentHealth.total
        ? "healthy"
        : "attention";
  const formattedDate = (value: string) =>
    new Date(value).toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const generatedDate = new Date(snapshot.generatedAt).toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const healthStatus = copy.health[snapshot.currentHealth.status];
  const passedMessage = copy.passed(snapshot.currentHealth.passed, snapshot.currentHealth.total);
  const careUnit = copy.careUnit(snapshot.workCompleted.length);
  const targets = snapshot.currentHealth.targets ?? [];
  const maintenanceCoverage = snapshot.maintenanceCoverage ?? [];
  const searchPerformance = snapshot.searchPerformance ?? null;
  const nextMonthPlan = snapshot.nextMonthPlan ?? copy.defaultNextMonth;
  const frequencyLabel = (value: string) => copy.frequency[value as keyof typeof copy.frequency] ?? value;
  const outcomeLabel = (value?: string) =>
    copy.outcomes[(value ?? "work_completed") as keyof typeof copy.outcomes] ?? copy.outcomes.work_completed;
  const priorityLabel = (value?: string) =>
    copy.priorities[(value ?? "medium") as keyof typeof copy.priorities] ?? copy.priorities.medium;
  const positionChangeLabel = (value: number | null) => {
    if (value === null) return { className: "", label: "—" };
    if (Math.abs(value) < 0.05) return { className: "position-neutral", label: copy.noPositionChange };
    return {
      className: value > 0 ? "position-up" : "position-down",
      label: `${value > 0 ? "↑" : "↓"} ${Math.abs(value).toFixed(1)}`,
    };
  };
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
@page{size:Letter;margin:0}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:Arial,Helvetica,sans-serif;color:#18372f;background:#fffdfa;margin:0}
body.ja{font-family:"Hiragino Sans","Yu Gothic",Meiryo,sans-serif}
body.ja h1,body.ja .cover-proof b,body.ja .summary h2,body.ja .metric strong,body.ja .closing h2{font-family:"Hiragino Mincho ProN","Yu Mincho",serif;letter-spacing:0}
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
.evidence-table,.coverage-table{width:100%;margin:.18in 0 .28in;border-collapse:collapse;font-size:6.5px}
.evidence-table th,.evidence-table td,.coverage-table th,.coverage-table td{padding:7px 6px;border-bottom:1px solid #dedfd9;text-align:left;vertical-align:top}
.evidence-table th,.coverage-table th{color:#607a6f;font-size:5.5px;letter-spacing:.7px;text-transform:uppercase}
.evidence-table td:first-child{max-width:2.6in;word-break:break-all}.evidence-table td:last-child,.coverage-table td:last-child{text-align:right}
.coverage-status{font-weight:700;color:#426d5c}.coverage-status.not-recorded{color:#96624f}.coverage-status.as-needed{color:#7b8983}
.search-performance{margin:.32in 0 .4in;padding:.28in .3in;background:#edf3ed;break-inside:avoid}.search-performance h2{margin:0;font-family:Georgia,serif;font-size:15px;font-weight:400}.search-performance>p{margin:7px 0 .18in;color:#71827a;font-size:6.5px;line-height:1.5}.search-table{width:100%;border-collapse:collapse;font-size:6.5px}.search-table th,.search-table td{padding:7px 5px;border-top:1px solid #d5ded7;text-align:right}.search-table th:first-child,.search-table td:first-child{text-align:left}.search-table th{color:#607a6f;font-size:5.5px;letter-spacing:.7px;text-transform:uppercase}.position-up{color:#2f7258;font-weight:700}.position-down{color:#9a5b47;font-weight:700}.position-neutral{color:#687a72;font-weight:700}
.work{break-inside:auto}
.work-list{margin:.21in 0 0 1.55in}
.work-item{min-height:.52in;display:grid;grid-template-columns:.34in 1fr .55in;gap:.14in;align-items:center;padding:.1in 0;border-top:1px solid #e2dfd6;break-inside:avoid}
.work-item:last-child{border-bottom:1px solid #e2dfd6}
.work-index{width:24px;height:24px;display:grid;place-items:center;border-radius:50%;color:#426b5c;background:#e5eee6;font-family:Georgia,serif;font-size:8px}
.work b{display:block;color:#5c786d;text-transform:uppercase}.work h3{margin:4px 0 0;font-size:8.5px;font-weight:500;line-height:1.35}.work time{color:#7f8c87;font-size:6.5px;text-align:right}
.work-detail{margin:4px 0 0;color:#6c7f77;font-size:6.5px;line-height:1.45}.work-detail strong{color:#47685b}
.insights{display:grid;grid-template-columns:1fr 1fr;margin-top:.38in;break-inside:avoid}
.insight{min-height:4.2in;padding:.5in .3in;background:#f0efe9}.insight.recommendations{color:#fff;background:#9c624e}
.insight-title{display:flex;gap:10px;align-items:flex-start}.insight-title>span{color:#97a39e;font-family:Georgia,serif;font-size:14px}.recommendations .insight-title>span{color:#e7bdab}
.insight ul{margin:.18in 0 0;padding:0;list-style:none}.insight li{display:grid;grid-template-columns:20px 1fr;gap:8px;padding:7px 0;border-top:1px solid #d8d7cf;break-inside:avoid}.recommendations li{border-color:rgba(255,255,255,.2)}
.list-icon{width:18px;height:18px;display:grid;place-items:center;border-radius:50%;color:#426d5c;background:#dce8dd;font-size:8px}.recommendations .list-icon{color:#fff;background:rgba(255,255,255,.14)}
.insight li p{margin:2px 0 0;font-size:7px;line-height:1.45}.empty{color:#7e8d87;font-size:7px}.recommendations .empty{color:#eed8cf}
.closing{position:relative;min-height:3in;overflow:hidden;margin-top:.35in;padding:.5in .65in;display:flex;flex-direction:column;justify-content:center;text-align:center;background:#e2ece2;break-inside:avoid}
.closing:before{content:"RP";position:absolute;left:50%;top:-.08in;color:rgba(31,80,65,.055);font-family:Georgia,serif;font-size:86px;transform:translateX(-50%)}
.closing small,.closing h2{position:relative}.closing small{color:#5e796d}.closing h2{max-width:6.3in;margin:.13in auto 0;font-family:Georgia,serif;font-size:17px;font-weight:400;line-height:1.4}
.next-month{margin-top:.35in;padding:.38in .45in;background:#173f36;color:#fff;break-inside:avoid}.next-month small{font-size:6px;font-weight:700;letter-spacing:1.3px;color:#9fc1b2}.next-month h2{margin:.12in 0 0;font-family:Georgia,serif;font-size:15px;font-weight:400;line-height:1.45}
footer{min-height:.95in;display:flex;justify-content:space-between;align-items:center;padding:.14in .65in;color:#75857f;font-size:6px}
.brand{display:flex;align-items:center;gap:7px;color:#18372f;font-size:9px;font-weight:700}.brand-mark{width:20px;height:20px;display:flex;align-items:flex-end;justify-content:center;gap:2px;padding:4px;border:1px solid #18372f;border-radius:50%}.brand-mark i{display:block;width:2px;background:#18372f;border-radius:2px}.brand-mark i:nth-child(1){height:5px}.brand-mark i:nth-child(2){height:10px}.brand-mark i:nth-child(3){height:7px}
.footer-meta{text-align:right;line-height:1.5}
</style></head><body class="${locale}"><main>
<section class="cover">
  <div class="cover-top"><span>${copy.recordTitle}</span><span class="edition">${escapeHtml(snapshot.period.label)}</span></div>
  <div class="cover-copy"><p class="overline">${copy.preparedFor}</p><h1>${escapeHtml(snapshot.client.name)}</h1><span class="period">${escapeHtml(snapshot.period.label)}</span></div>
  <div class="cover-proof"><span class="status-mark ${healthTone}">✓</span><div><small>${copy.careStatus}</small><b>${healthStatus}</b></div><p>${copy.basedOn}</p></div>
</section>
<div class="content">
  <section class="summary">
    <div class="section-heading"><span>01</span><div><small>${copy.executiveSummary}</small><p>${copy.monthAtGlance}</p></div></div>
    <div class="summary-copy"><span class="quote">“</span><h2>${escapeHtml(snapshot.executiveSummary)}</h2></div>
  </section>
  <section class="metrics">
    <article class="metric primary"><span class="status-mark ${healthTone}">✓</span><small>${copy.observedStatus}</small><strong>${healthStatus}</strong><p>${passedMessage}</p></article>
    <article class="metric"><small>${copy.checksPassed}</small><strong>${snapshot.currentHealth.passed}<span> / ${snapshot.currentHealth.total}</span></strong><p>${copy.scheduledPublicChecks}</p></article>
    <article class="metric"><small>${copy.careCompleted}</small><strong>${snapshot.workCompleted.length}<span> ${careUnit}</span></strong><p>${copy.clientVisibleWork}</p></article>
  </section>
  <p class="evidence-note">${copy.evidenceNote}</p>
  ${targets.length ? `<table class="evidence-table"><thead><tr><th>${copy.target}</th><th>${copy.observations}</th><th>${copy.response}</th><th>${copy.ssl}</th></tr></thead><tbody>${targets.map((item) => `<tr><td>${escapeHtml(item.target)}</td><td>${item.passed} / ${item.total}</td><td>${item.averageResponseMs === null ? "—" : `${item.averageResponseMs} ms`}</td><td>${item.tlsExpiresAt ? escapeHtml(new Date(item.tlsExpiresAt).toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })) : copy.sslVerifiedOnly}</td></tr>`).join("")}</tbody></table>` : ""}
  ${maintenanceCoverage.length ? `<table class="coverage-table"><thead><tr><th>${copy.careItem}</th><th>${copy.frequencyLabel}</th><th>${copy.recorded}</th><th>${copy.coverageStatus}</th></tr></thead><tbody>${maintenanceCoverage.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(frequencyLabel(item.frequency))}</td><td>${item.completedCount}</td><td><span class="coverage-status ${item.status.replace("_", "-")}">${copy.coverage[item.status]}</span></td></tr>`).join("")}</tbody></table>` : ""}
  ${searchPerformance ? `<section class="search-performance"><h2>${copy.searchVisibility}</h2><p>${copy.searchNote} ${copy.searchProperty}: ${escapeHtml(searchPerformance.siteUrl)}</p>${searchPerformance.keywords.length ? `<table class="search-table"><thead><tr><th>${copy.keyword}</th><th>${copy.averagePosition}</th><th>${copy.change}</th><th>${copy.impressions}</th><th>${copy.clicks}</th><th>${copy.ctr}</th></tr></thead><tbody>${searchPerformance.keywords.map((item) => {
    const change = positionChangeLabel(item.positionChange);
    return `<tr><td>${escapeHtml(item.keyword)}</td><td>${item.averagePosition === null ? "—" : item.averagePosition.toFixed(1)}</td><td class="${change.className}">${change.label}</td><td>${Math.round(item.impressions)}</td><td>${Math.round(item.clicks)}</td><td>${item.ctr === null ? "—" : `${(item.ctr * 100).toFixed(1)}%`}</td></tr>`;
  }).join("")}</tbody></table>` : `<p>${copy.noKeywordData}</p>`}</section>` : ""}
  <section class="work">
    <div class="section-heading"><span>02</span><div><small>${copy.workCompleted}</small><p>${copy.careBehind}</p></div></div>
    <div class="work-list">${snapshot.workCompleted.length
      ? snapshot.workCompleted.map((item, index) => `<article class="work-item"><span class="work-index">${String(index + 1).padStart(2, "0")}</span><div><b>${escapeHtml(categoryLabel(item.category, locale))} · ${escapeHtml(outcomeLabel(item.outcomeType))}</b><h3>${escapeHtml(item.summary)}</h3>${item.target ? `<p class="work-detail"><strong>${copy.target}:</strong> ${escapeHtml(item.target)}</p>` : ""}${item.resultSummary ? `<p class="work-detail"><strong>${copy.result}:</strong> ${escapeHtml(item.resultSummary)}</p>` : ""}${item.verificationMethod ? `<p class="work-detail"><strong>${copy.verification}:</strong> ${escapeHtml(item.verificationMethod)}</p>` : ""}${item.clientValue ? `<p class="work-detail"><strong>${copy.clientValue}:</strong> ${escapeHtml(item.clientValue)}</p>` : ""}</div><time>${escapeHtml(formattedDate(item.occurredAt))}</time></article>`).join("")
      : `<p class="empty">${copy.noWork}</p>`}</div>
  </section>
  <section class="insights">
    <article class="insight"><div class="insight-title"><span>03</span><small>${copy.problemsPrevented}</small></div>${snapshot.problemsPrevented.length ? `<ul>${snapshot.problemsPrevented.map((item) => `<li><span class="list-icon">✓</span><p><strong>${escapeHtml(outcomeLabel(item.outcomeType))}</strong><br>${escapeHtml(item.summary)}</p></li>`).join("")}</ul>` : `<p class="empty">${copy.noProblems}</p>`}</article>
    <article class="insight recommendations"><div class="insight-title"><span>04</span><small>${copy.recommendations}</small></div>${snapshot.recommendations.length ? `<ul>${snapshot.recommendations.map((item) => `<li><span class="list-icon">→</span><p><strong>${escapeHtml(priorityLabel(item.priority))}</strong><br>${escapeHtml(item.summary)}${item.nextAction ? `<br><em>${copy.nextAction}: ${escapeHtml(item.nextAction)}</em>` : ""}</p></li>`).join("")}</ul>` : `<p class="empty">${copy.noRecommendations}</p>`}</article>
  </section>
  <section class="next-month"><small>${copy.nextMonth}</small><h2>${escapeHtml(nextMonthPlan)}</h2></section>
  <section class="closing"><small>${copy.closingNote}</small><h2>${escapeHtml(snapshot.closingMessage)}</h2></section>
</div>
<footer><div class="brand"><span class="brand-mark"><i></i><i></i><i></i></span>${escapeHtml(snapshot.appName)}</div><div class="footer-meta">${copy.footerLine}<br>${copy.generated} ${escapeHtml(generatedDate)}</div></footer>
</main></body></html>`;
}

const reportCopy = {
  en: {
    recordTitle: "WEBSITE CARE / MONTHLY RECORD",
    preparedFor: "Prepared exclusively for",
    careStatus: "CARE STATUS",
    basedOn: "Based on recorded maintenance and scheduled public-site observations.",
    executiveSummary: "EXECUTIVE SUMMARY",
    monthAtGlance: "The month at a glance",
    observedStatus: "OBSERVED STATUS",
    checksPassed: "CHECKS PASSED",
    scheduledPublicChecks: "Scheduled public checks",
    careCompleted: "CARE COMPLETED",
    clientVisibleWork: "Client-visible work recorded",
    evidenceNote: "Scheduled observations only. This report does not estimate uptime or guarantee availability.",
    target: "Target",
    observations: "Checks passed",
    response: "Average response",
    ssl: "SSL certificate",
    sslVerifiedOnly: "Valid when checked; expiry unavailable",
    careItem: "Care item",
    frequencyLabel: "Frequency",
    recorded: "Records",
    coverageStatus: "Status",
    result: "Result",
    verification: "Verified by",
    clientValue: "Client value",
    searchVisibility: "GOOGLE SEARCH VISIBILITY",
    searchNote: "Average position is calculated from Search Console impressions for this period; it is not a live or guaranteed rank.",
    searchProperty: "Property",
    keyword: "Tracked keyword",
    averagePosition: "Avg. position",
    change: "vs prior period",
    noPositionChange: "No change",
    impressions: "Impressions",
    clicks: "Clicks",
    ctr: "CTR",
    noKeywordData: "No tracked keyword data was returned for this period.",
    workCompleted: "WORK COMPLETED",
    careBehind: "The care behind the result",
    noWork: "No client-visible maintenance activities were recorded in this period.",
    problemsPrevented: "OUTCOMES & VERIFICATION",
    noProblems: "No separately classified outcomes were recorded.",
    recommendations: "RECOMMENDATIONS",
    noRecommendations: "No recommendations this month.",
    nextAction: "Next action",
    nextMonth: "NEXT MONTH",
    defaultNextMonth: "Continue the configured care schedule and public-site observations next month.",
    closingNote: "CLOSING NOTE",
    footerLine: "Client-visible website care",
    generated: "Generated",
    health: {
      Healthy: "Healthy",
      "Needs attention": "Needs attention",
      "No checks": "No checks",
    },
    passed: (passed: number, total: number) => `${passed} of ${total} scheduled checks passed`,
    careUnit: (count: number) => (count === 1 ? "item" : "items"),
    frequency: {
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
      quarterly: "Quarterly",
      as_needed: "As needed",
    },
    coverage: {
      completed: "Recorded",
      not_recorded: "No activity recorded",
      as_needed: "As needed",
    },
    outcomes: {
      work_completed: "Work completed",
      issue_resolved: "Issue resolved",
      risk_reduced: "Risk reduced",
      routine_verification: "Routine verification",
    },
    priorities: {
      low: "Low priority",
      medium: "Medium priority",
      high: "High priority",
    },
  },
  ja: {
    recordTitle: "WEBサイト保守 / 月次レポート",
    preparedFor: "ご報告先",
    careStatus: "保守状況",
    basedOn: "記録された保守作業と、定期的な公開サイト確認に基づくレポートです。",
    executiveSummary: "概要",
    monthAtGlance: "今月のまとめ",
    observedStatus: "確認時の状態",
    checksPassed: "確認成功数",
    scheduledPublicChecks: "定期公開サイト確認",
    careCompleted: "完了した保守",
    clientVisibleWork: "お客様向けに記録された作業",
    evidenceNote: "定期確認の観測結果のみを掲載しています。稼働率の推定や可用性の保証を行うものではありません。",
    target: "確認対象",
    observations: "確認成功数",
    response: "平均応答",
    ssl: "SSL証明書",
    sslVerifiedOnly: "確認時は有効・期限未取得",
    careItem: "保守項目",
    frequencyLabel: "頻度",
    recorded: "記録数",
    coverageStatus: "状態",
    result: "結果",
    verification: "確認方法",
    clientValue: "お客様への価値",
    searchVisibility: "Google検索での表示状況",
    searchNote: "平均掲載順位は、この期間にSearch Consoleへ記録された表示回数から算出した値です。リアルタイム順位や固定順位ではありません。",
    searchProperty: "プロパティ",
    keyword: "追跡キーワード",
    averagePosition: "平均掲載順位",
    change: "前期間比",
    noPositionChange: "変化なし",
    impressions: "表示回数",
    clicks: "クリック",
    ctr: "クリック率",
    noKeywordData: "この期間に追跡キーワードのデータは返されませんでした。",
    workCompleted: "完了した作業",
    careBehind: "結果を支える保守内容",
    noWork: "この期間にお客様向けの保守作業記録はありません。",
    problemsPrevented: "成果と確認",
    noProblems: "区分された成果・確認記録はありません。",
    recommendations: "今後のご提案",
    noRecommendations: "今月のご提案はありません。",
    nextAction: "次のアクション",
    nextMonth: "翌月の予定",
    defaultNextMonth: "翌月も設定済みの保守予定と公開サイトの定期確認を継続します。",
    closingNote: "おわりに",
    footerLine: "見えるかたちで届けるWebサイト保守",
    generated: "作成日",
    health: {
      Healthy: "良好",
      "Needs attention": "要確認",
      "No checks": "確認記録なし",
    },
    passed: (passed: number, total: number) => `${total}回中${passed}回の定期確認に成功`,
    careUnit: () => "件",
    frequency: {
      daily: "毎日",
      weekly: "毎週",
      monthly: "毎月",
      quarterly: "四半期",
      as_needed: "必要時",
    },
    coverage: {
      completed: "実施記録あり",
      not_recorded: "記録なし",
      as_needed: "必要時",
    },
    outcomes: {
      work_completed: "作業完了",
      issue_resolved: "問題解決",
      risk_reduced: "リスク低減",
      routine_verification: "定期確認",
    },
    priorities: {
      low: "優先度：低",
      medium: "優先度：中",
      high: "優先度：高",
    },
  },
} as const;

const categoryLabels: Record<string, { en: string; ja: string }> = {
  updates: { en: "Updates", ja: "更新" },
  backups: { en: "Backups", ja: "バックアップ" },
  security: { en: "Security", ja: "セキュリティ" },
  fixes: { en: "Fixes", ja: "修正" },
  content: { en: "Content", ja: "コンテンツ" },
  performance: { en: "Performance", ja: "パフォーマンス" },
  forms: { en: "Forms", ja: "フォーム" },
  support: { en: "Support", ja: "サポート" },
  other: { en: "Other", ja: "その他" },
};

function categoryLabel(category: string, locale: Locale): string {
  return categoryLabels[category]?.[locale] ?? category;
}
