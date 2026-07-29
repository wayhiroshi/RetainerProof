import { describe, expect, it } from "vitest";
import type { ReportSnapshot } from "./reports";
import { renderReportHtml } from "./reports";

const snapshot: ReportSnapshot = {
  appName: "RetainerProof",
  client: { name: "North & Pine <Studio>" },
  period: {
    start: "2026-06-01T00:00:00.000Z",
    end: "2026-06-30T23:59:59.999Z",
    label: "June 1–30, 2026",
  },
  executiveSummary: "Routine care was completed & verified.",
  currentHealth: {
    passed: 30,
    total: 30,
    averageResponseMs: 214,
    status: "Healthy",
  },
  workCompleted: [
    {
      category: "security",
      summary: "Applied routine updates.",
      occurredAt: "2026-06-04T09:00:00.000Z",
    },
  ],
  problemsPrevented: [
    { summary: "Verified the public site.", occurredAt: "2026-06-04T09:00:00.000Z" },
  ],
  recommendations: [
    { summary: "Review portfolio images.", occurredAt: "2026-06-20T09:00:00.000Z" },
  ],
  closingMessage: "Everything important has been reviewed.",
  generatedAt: "2026-07-01T09:00:00.000Z",
};

describe("renderReportHtml", () => {
  it("renders the premium report structure and factual metrics", () => {
    const html = renderReportHtml(snapshot);

    expect(html).toContain("WEBSITE CARE / MONTHLY RECORD");
    expect(html).toContain("30 of 30 scheduled checks passed");
    expect(html).toContain("CARE COMPLETED");
    expect(html).toContain("PROBLEMS PREVENTED");
    expect(html).toContain("@page{size:Letter");
    expect(html).not.toContain("100% uptime");
  });

  it("escapes client-controlled report content", () => {
    const html = renderReportHtml(snapshot);

    expect(html).toContain("North &amp; Pine &lt;Studio&gt;");
    expect(html).toContain("Routine care was completed &amp; verified.");
    expect(html).not.toContain("North & Pine <Studio>");
  });

  it("renders Japanese report chrome without changing factual values", () => {
    const html = renderReportHtml({
      ...snapshot,
      locale: "ja",
      period: { ...snapshot.period, label: "2026年6月" },
      executiveSummary: "定期保守と公開サイトの状態を確認しました。",
      closingMessage: "重要な項目はすべて確認済みです。",
    });

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("WEBサイト保守 / 月次レポート");
    expect(html).toContain("30回中30回の定期確認に成功");
    expect(html).toContain("セキュリティ");
    expect(html).toContain("稼働率の推定や可用性の保証を行うものではありません");
    expect(html).not.toContain("100% uptime");
  });
});
