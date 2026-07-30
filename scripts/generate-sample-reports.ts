import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { renderReportHtml, type ReportSnapshot } from "../worker/services/reports";

const outputDirectory = resolve("output/pdf");

const englishSnapshot: ReportSnapshot = {
  locale: "en",
  appName: "RetainerProof",
  client: { name: "North & Pine Studio" },
  period: {
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-06-30T23:59:59.999Z",
    label: "June 2026",
  },
  executiveSummary:
    "In June 2026, four client-visible care tasks were recorded and all five configured care items had completion evidence. All 30 scheduled public-site checks passed.",
  currentHealth: {
    passed: 30,
    total: 30,
    averageResponseMs: 214,
    status: "Healthy",
    targets: [
      { target: "https://northpine.example/", passed: 30, total: 30, averageResponseMs: 196, tlsExpiresAt: "2026-10-18T00:00:00.000Z", status: "Healthy" },
      { target: "https://northpine.example/services", passed: 30, total: 30, averageResponseMs: 225, tlsExpiresAt: "2026-10-18T00:00:00.000Z", status: "Healthy" },
      { target: "https://northpine.example/contact", passed: 30, total: 30, averageResponseMs: 221, tlsExpiresAt: "2026-10-18T00:00:00.000Z", status: "Healthy" },
    ],
  },
  maintenanceCoverage: [
    { name: "Public website checks", category: "performance", frequency: "daily", completedCount: 30, status: "completed" },
    { name: "Software updates", category: "updates", frequency: "monthly", completedCount: 1, status: "completed" },
    { name: "Backup readiness", category: "backups", frequency: "monthly", completedCount: 1, status: "completed" },
    { name: "Security review", category: "security", frequency: "monthly", completedCount: 1, status: "completed" },
    { name: "Forms and key functions", category: "forms", frequency: "monthly", completedCount: 1, status: "completed" },
  ],
  searchPerformance: {
    siteUrl: "sc-domain:northpine.example",
    lastSyncedAt: "2026-07-03T08:30:00.000Z",
    keywords: [
      { keyword: "website care studio", clicks: 92, impressions: 1240, ctr: 0.0742, averagePosition: 6.8, previousAveragePosition: 8.4, positionChange: 1.6 },
      { keyword: "web maintenance plan", clicks: 31, impressions: 690, ctr: 0.0449, averagePosition: 11.2, previousAveragePosition: 12, positionChange: 0.8 },
    ],
  },
  workCompleted: [
    {
      category: "security",
      summary: "Applied routine security updates and verified the public site.",
      occurredAt: "2026-06-04T09:00:00.000Z",
      target: "Main website",
      outcomeType: "risk_reduced",
      resultSummary: "All updates completed without errors.",
      verificationMethod: "Checked the homepage, services page, and browser console after deployment.",
      clientValue: "Reduced exposure to known software vulnerabilities.",
    },
    {
      category: "performance",
      summary: "Optimized large homepage images for faster delivery.",
      occurredAt: "2026-06-12T09:00:00.000Z",
      target: "Homepage",
      outcomeType: "work_completed",
      resultSummary: "Transferred image weight was reduced by 38%.",
      verificationMethod: "Compared production asset sizes before and after deployment.",
      clientValue: "Visitors receive the main visual content faster.",
    },
    {
      category: "content",
      summary: "Published the revised summer services page.",
      occurredAt: "2026-06-18T09:00:00.000Z",
      target: "Services page",
      outcomeType: "routine_verification",
      resultSummary: "The approved copy and links are live.",
      verificationMethod: "Reviewed the published page on desktop and mobile.",
      clientValue: "Customers now see the current seasonal offering.",
    },
    {
      category: "support",
      summary: "Resolved an issue affecting the contact details in the footer.",
      occurredAt: "2026-06-25T09:00:00.000Z",
      target: "Site footer",
      outcomeType: "issue_resolved",
      resultSummary: "The correct phone number now appears on every page.",
      verificationMethod: "Checked representative pages and both responsive breakpoints.",
      clientValue: "Customers can reach the correct contact point.",
    },
  ],
  problemsPrevented: [
    { summary: "Reduced exposure to known software vulnerabilities.", occurredAt: "2026-06-04T09:00:00.000Z", outcomeType: "risk_reduced" },
    { summary: "The incorrect contact details were corrected across the site.", occurredAt: "2026-06-25T09:00:00.000Z", outcomeType: "issue_resolved" },
  ],
  recommendations: [
    {
      summary: "Review and refresh the portfolio photography next month.",
      occurredAt: "2026-06-20T09:00:00.000Z",
      priority: "medium",
      nextAction: "Select six replacement images before the next maintenance window.",
    },
  ],
  nextMonthPlan:
    "Continue daily public-site checks and the monthly software, backup, security, and key-function reviews. Review the selected portfolio images during the next maintenance window.",
  closingMessage:
    "Your website is in good shape. We will continue monitoring it and taking care of routine maintenance next month.",
  generatedAt: "2026-07-01T09:00:00.000Z",
};

const japaneseSnapshot: ReportSnapshot = {
  ...englishSnapshot,
  locale: "ja",
  client: { name: "ノース＆パイン・スタジオ" },
  period: { ...englishSnapshot.period, label: "2026年6月" },
  executiveSummary:
    "2026年6月はお客様向けの定期保守作業を4件記録し、設定済み保守項目5件すべてに実施記録があります。公開サイトの定期確認は30回中30回成功しました。",
  maintenanceCoverage: [
    { name: "公開サイトの確認", category: "performance", frequency: "daily", completedCount: 30, status: "completed" },
    { name: "ソフトウェア更新", category: "updates", frequency: "monthly", completedCount: 1, status: "completed" },
    { name: "バックアップ確認", category: "backups", frequency: "monthly", completedCount: 1, status: "completed" },
    { name: "セキュリティ確認", category: "security", frequency: "monthly", completedCount: 1, status: "completed" },
    { name: "フォーム・重要機能確認", category: "forms", frequency: "monthly", completedCount: 1, status: "completed" },
  ],
  workCompleted: [
    {
      category: "security",
      summary: "定期的なセキュリティ更新を適用し、公開サイトを確認しました。",
      occurredAt: "2026-06-04T09:00:00.000Z",
      target: "メインサイト",
      outcomeType: "risk_reduced",
      resultSummary: "すべての更新がエラーなく完了しました。",
      verificationMethod: "公開後にトップ・サービスページ・ブラウザコンソールを確認しました。",
      clientValue: "既知の脆弱性にさらされるリスクを低減しました。",
    },
    {
      category: "performance",
      summary: "トップページの大きな画像を最適化し、表示を改善しました。",
      occurredAt: "2026-06-12T09:00:00.000Z",
      target: "トップページ",
      outcomeType: "work_completed",
      resultSummary: "画像の転送容量を38%削減しました。",
      verificationMethod: "公開前後の本番画像サイズを比較しました。",
      clientValue: "訪問者に主要な画像がより早く表示されます。",
    },
    {
      category: "content",
      summary: "夏季サービスページの改訂版を公開しました。",
      occurredAt: "2026-06-18T09:00:00.000Z",
      target: "サービスページ",
      outcomeType: "routine_verification",
      resultSummary: "承認済みの文章とリンクを公開しました。",
      verificationMethod: "公開ページをPCとモバイルで確認しました。",
      clientValue: "季節サービスの最新情報をお客様へ案内できます。",
    },
    {
      category: "support",
      summary: "フッターの連絡先表示に関する問題を解決しました。",
      occurredAt: "2026-06-25T09:00:00.000Z",
      target: "サイト共通フッター",
      outcomeType: "issue_resolved",
      resultSummary: "すべてのページに正しい電話番号が表示されています。",
      verificationMethod: "代表ページとPC・モバイル表示を確認しました。",
      clientValue: "お客様が正しい連絡先へ問い合わせできます。",
    },
  ],
  problemsPrevented: [
    { summary: "既知の脆弱性にさらされるリスクを低減しました。", occurredAt: "2026-06-04T09:00:00.000Z", outcomeType: "risk_reduced" },
    { summary: "サイト全体の誤った連絡先表示を修正しました。", occurredAt: "2026-06-25T09:00:00.000Z", outcomeType: "issue_resolved" },
  ],
  recommendations: [
    {
      summary: "来月、ポートフォリオ写真の見直しと更新をご検討ください。",
      occurredAt: "2026-06-20T09:00:00.000Z",
      priority: "medium",
      nextAction: "次回保守日までに差し替え候補を6枚選定してください。",
    },
  ],
  nextMonthPlan:
    "公開サイトの日次確認と、ソフトウェア・バックアップ・セキュリティ・重要機能の月次確認を継続します。次回の保守日にポートフォリオ写真の候補を確認します。",
  closingMessage: "Webサイトは良好な状態です。来月も継続して状態確認と定期保守を行います。",
};

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [filename, snapshot] of [
    ["RetainerProof-sample-report.pdf", englishSnapshot],
    ["RetainerProof-sample-report-ja.pdf", japaneseSnapshot],
  ] as const) {
    const page = await browser.newPage();
    await page.setContent(renderReportHtml(snapshot), { waitUntil: "load" });
    await page.pdf({
      path: resolve(outputDirectory, filename),
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
