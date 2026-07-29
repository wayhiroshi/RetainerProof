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
    "Your website stayed healthy, secure, and up to date. This month we completed routine maintenance, resolved two content issues, and verified every scheduled availability check.",
  currentHealth: {
    passed: 30,
    total: 30,
    averageResponseMs: 214,
    status: "Healthy",
  },
  workCompleted: [
    { category: "security", summary: "Applied routine security updates and verified the public site.", occurredAt: "2026-06-04T09:00:00.000Z" },
    { category: "performance", summary: "Optimized large homepage images for faster delivery.", occurredAt: "2026-06-12T09:00:00.000Z" },
    { category: "content", summary: "Published the revised summer services page.", occurredAt: "2026-06-18T09:00:00.000Z" },
    { category: "support", summary: "Resolved an issue affecting the contact details in the footer.", occurredAt: "2026-06-25T09:00:00.000Z" },
  ],
  problemsPrevented: [
    { summary: "Verified updates on the public site before closing the maintenance task.", occurredAt: "2026-06-04T09:00:00.000Z" },
    { summary: "Confirmed important pages remained reachable throughout the month.", occurredAt: "2026-06-30T09:00:00.000Z" },
  ],
  recommendations: [
    { summary: "Review and refresh the portfolio photography next month.", occurredAt: "2026-06-20T09:00:00.000Z" },
  ],
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
    "Webサイトは良好で安全な状態を維持しています。今月は定期保守を完了し、2件のコンテンツ上の問題を解決したうえで、すべての定期確認に成功しました。",
  workCompleted: [
    { category: "security", summary: "定期的なセキュリティ更新を適用し、公開サイトを確認しました。", occurredAt: "2026-06-04T09:00:00.000Z" },
    { category: "performance", summary: "トップページの大きな画像を最適化し、表示を改善しました。", occurredAt: "2026-06-12T09:00:00.000Z" },
    { category: "content", summary: "夏季サービスページの改訂版を公開しました。", occurredAt: "2026-06-18T09:00:00.000Z" },
    { category: "support", summary: "フッターの連絡先表示に関する問題を解決しました。", occurredAt: "2026-06-25T09:00:00.000Z" },
  ],
  problemsPrevented: [
    { summary: "保守作業を完了する前に、公開サイトで更新結果を確認しました。", occurredAt: "2026-06-04T09:00:00.000Z" },
    { summary: "重要なページへ正常にアクセスできることを確認しました。", occurredAt: "2026-06-30T09:00:00.000Z" },
  ],
  recommendations: [
    { summary: "来月、ポートフォリオ写真の見直しと更新をご検討ください。", occurredAt: "2026-06-20T09:00:00.000Z" },
  ],
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
