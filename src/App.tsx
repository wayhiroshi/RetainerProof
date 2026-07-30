import {
  createContext,
  FormEvent,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { api, ApiError } from "./lib/api";
import { authClient } from "./lib/auth-client";
import { previousMonthDateRange } from "./lib/report-dates";
import { brand } from "./config";

type Locale = "en" | "ja";

type MaintenanceItem = {
  id: string;
  clientId: string;
  name: string;
  category: string;
  frequency: "daily" | "weekly" | "monthly" | "quarterly" | "as_needed";
  enabled: boolean;
  sortOrder: number;
};

type Client = {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  reportLocale: Locale;
  createdAt: string;
  maintenanceItems: MaintenanceItem[];
  asset?: {
    id: string;
    name: string;
    url: string;
    criticalUrls: string[];
  } | null;
};

type Activity = {
  id: string;
  clientId: string;
  clientName: string;
  occurredAt: string;
  category: string;
  maintenanceItemId: string | null;
  target: string;
  outcomeType: "work_completed" | "issue_resolved" | "risk_reduced" | "routine_verification";
  internalNote: string | null;
  clientDescription: string | null;
  resultSummary: string;
  verificationMethod: string;
  clientValue: string;
  recommendationPriority: "low" | "medium" | "high" | null;
  nextAction: string;
  visibility: "client_visible" | "internal_only" | "recommendation";
};

type Report = {
  id: string;
  clientId: string;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "finalized";
  updatedAt: string;
  finalizedAt: string | null;
  firstViewedAt: string | null;
  latestRevisionNumber: number;
  periodLabel: string;
  pdfAvailable: boolean;
  locale?: Locale;
};

type EditableReportSnapshot = {
  locale?: Locale;
  executiveSummary: string;
  currentHealth: {
    passed: number;
    total: number;
    averageResponseMs: number | null;
    status: string;
    targets?: Array<{
      target: string;
      passed: number;
      total: number;
      averageResponseMs: number | null;
      tlsExpiresAt: string | null;
      status: string;
    }>;
  };
  maintenanceCoverage?: Array<{
    name: string;
    category: string;
    frequency: string;
    completedCount: number;
    status: "completed" | "not_recorded" | "as_needed";
  }>;
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
};

type SessionData = {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; uiLocale: Locale };
  subscription: {
    plan: "founding" | "starter" | "freelancer";
    status: string;
    clientLimit: number;
    providerSubscriptionId?: string | null;
  };
};

type PublicReport = {
  locale: Locale;
  appName: string;
  clientName: string;
  periodLabel: string;
  generatedAt: string;
  pdfUrl: string | null;
  snapshot: {
    executiveSummary: string;
    currentHealth: {
      scheduled: number;
      passed: number;
      failed: number;
      message: string;
      targets: Array<{
        target: string;
        passed: number;
        total: number;
        averageResponseMs: number | null;
        tlsExpiresAt: string | null;
        status: string;
      }>;
    };
    maintenanceCoverage: Array<{
      name: string;
      category: string;
      frequency: string;
      completedCount: number;
      status: "completed" | "not_recorded" | "as_needed";
    }>;
    workCompleted: Array<{
      category: string;
      description: string;
      date: string;
      target: string;
      outcomeType: string;
      resultSummary: string;
      verificationMethod: string;
      clientValue: string;
    }>;
    problemsPrevented: Array<{ summary: string; outcomeType: string }>;
    recommendations: Array<{ summary: string; priority: "low" | "medium" | "high"; nextAction: string }>;
    nextMonthPlan: string;
    closingMessage: string;
  };
};

const UiLocaleContext = createContext<Locale>("en");

function useUiLocale(): Locale {
  return useContext(UiLocaleContext);
}

function tr<T>(locale: Locale, en: T, ja: T): T {
  return locale === "ja" ? ja : en;
}

function LanguageSwitch({
  locale,
  onChange,
  compact = false,
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
  compact?: boolean;
}) {
  return (
    <div className={`language-switch ${compact ? "compact" : ""}`} aria-label={tr(locale, "Language", "表示言語")}>
      <button className={locale === "en" ? "active" : ""} onClick={() => onChange("en")} type="button">EN</button>
      <button className={locale === "ja" ? "active" : ""} onClick={() => onChange("ja")} type="button">日本語</button>
    </div>
  );
}

const categories = [
  ["updates", "Updates"],
  ["backups", "Backups"],
  ["security", "Security"],
  ["fixes", "Fixes"],
  ["content", "Content"],
  ["performance", "Performance"],
  ["forms", "Forms"],
  ["support", "Support"],
  ["other", "Other"],
] as const;

function categoryName(category: string, locale: Locale): string {
  const labels: Record<string, string> = locale === "ja"
    ? {
        updates: "更新",
        backups: "バックアップ",
        security: "セキュリティ",
        fixes: "修正",
        content: "コンテンツ",
        performance: "パフォーマンス",
        forms: "フォーム",
        support: "サポート",
        other: "その他",
      }
    : Object.fromEntries(categories);
  return labels[category] ?? category;
}

function frequencyName(frequency: string, locale: Locale): string {
  const labels = locale === "ja"
    ? { daily: "毎日", weekly: "毎週", monthly: "毎月", quarterly: "四半期", as_needed: "必要時" }
    : { daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", as_needed: "As needed" };
  return labels[frequency as keyof typeof labels] ?? frequency;
}

function outcomeName(outcome: string, locale: Locale): string {
  const labels = locale === "ja"
    ? { work_completed: "作業完了", issue_resolved: "問題解決", risk_reduced: "リスク低減", routine_verification: "定期確認" }
    : { work_completed: "Work completed", issue_resolved: "Issue resolved", risk_reduced: "Risk reduced", routine_verification: "Routine verification" };
  return labels[outcome as keyof typeof labels] ?? outcome;
}

function priorityName(priority: string, locale: Locale): string {
  const labels = locale === "ja"
    ? { low: "低", medium: "中", high: "高" }
    : { low: "Low", medium: "Medium", high: "High" };
  return labels[priority as keyof typeof labels] ?? priority;
}

function Icon({ name }: { name: string }) {
  const icons: Record<string, ReactNode> = {
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    pulse: <path d="M3 12h4l2-7 4 14 2-7h6" />,
    report: (
      <>
        <path d="M6 2h9l5 5v15H6z" />
        <path d="M14 2v6h6M9 13h8M9 17h6" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    client: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" />
      </>
    ),
    activity: (
      <>
        <path d="M12 2v20M2 12h20" />
        <circle cx="12" cy="12" r="8" />
      </>
    ),
    external: <path d="M14 3h7v7M10 14 21 3M21 14v7H3V3h7" />,
    lock: (
      <>
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icons[name]}
    </svg>
  );
}

function Logo({ dark = false, home = "/" }: { dark?: boolean; home?: string }) {
  return (
    <Link className={`logo ${dark ? "logo-dark" : ""}`} to={home}>
      <span className="logo-mark">
        <span />
        <span />
        <span />
      </span>
      <span>{brand.name}</span>
    </Link>
  );
}

function MarketingHeader({ locale = "en" }: { locale?: Locale }) {
  const prefix = locale === "ja" ? "/ja" : "";
  return (
    <header className="marketing-header">
      <Logo home={prefix || "/"} />
      <nav aria-label="Main navigation">
        <Link to={`${prefix}/#how`}>{tr(locale, "How it works", "仕組み")}</Link>
        <Link to={`${prefix}/sample`}>{tr(locale, "Sample report", "サンプル")}</Link>
        <Link to={`${prefix}/pricing`}>{tr(locale, "Pricing", "料金")}</Link>
      </nav>
      <div className="header-actions">
        <Link className="language-link" to={locale === "ja" ? "/" : "/ja"}>
          {locale === "ja" ? "EN" : "日本語"}
        </Link>
        <Link className="text-link" to={`${prefix}/login`}>
          {tr(locale, "Log in", "ログイン")}
        </Link>
        <Link className="button button-small" to={`${prefix}/login`}>
          {tr(locale, "Start for $5", "$5で始める")} <Icon name="arrow" />
        </Link>
      </div>
    </header>
  );
}

function Landing({ locale = "en" }: { locale?: Locale }) {
  const prefix = locale === "ja" ? "/ja" : "";
  return (
    <div className="marketing">
      <MarketingHeader locale={locale} />
      <main>
        <section className="hero">
          <div className="eyebrow">
            <span className="live-dot" />
            {tr(locale, "Built for independent web care professionals", "Webサイト保守のプロのために")}
          </div>
          <h1>
            {tr(locale, "Make invisible maintenance", "見えない保守作業を")}
            <br />
            <em>{tr(locale, "visible to clients.", "お客様に見える価値へ。")}</em>
          </h1>
          <p>
            {tr(locale, `Log your work in seconds. ${brand.name} watches every client site and turns the month into a polished, client-ready report.`, `数秒で作業を記録。${brand.name}が各サイトを確認し、1か月の保守価値を美しいお客様向けレポートにまとめます。`)}
          </p>
          <div className="hero-actions">
            <Link className="button" to={`${prefix}/login`}>
              {tr(locale, "Become a founding customer", "先行ユーザーになる")} <Icon name="arrow" />
            </Link>
            <Link className="button button-ghost" to={`${prefix}/sample`}>
              {tr(locale, "View a sample report", "サンプルを見る")}
            </Link>
          </div>
          <div className="trust-line">
            <span>
              <Icon name="check" /> {tr(locale, "No client login", "お客様ログイン不要")}
            </span>
            <span>
              <Icon name="check" /> {tr(locale, "Works with any website", "どのWebサイトにも対応")}
            </span>
            <span>
              <Icon name="check" /> {tr(locale, "Cancel anytime", "いつでも解約可能")}
            </span>
          </div>
        </section>

        <section className="report-stage" aria-label="Product preview">
          <div className="float-note float-note-left">
            <span className="note-icon"><Icon name="pulse" /></span>
            <div><b>30 / 30</b><small>{tr(locale, "scheduled checks passed", "定期確認に成功")}</small></div>
          </div>
          <div className="report-paper">
            <div className="paper-head">
              <Logo dark />
              <span>{tr(locale, "MONTHLY CARE REPORT", "月次保守レポート")}</span>
            </div>
            <div className="paper-client">
              <small>{tr(locale, "PREPARED FOR", "ご報告先")}</small>
              <h3>{tr(locale, "North & Pine Studio", "ノース＆パイン・スタジオ")}</h3>
              <p>{tr(locale, "June 1–30, 2026", "2026年6月")}</p>
            </div>
            <div className="paper-summary">
              <small>{tr(locale, "EXECUTIVE SUMMARY", "概要")}</small>
              <h4>{tr(locale, "Your website stayed healthy, secure, and up to date.", "Webサイトは良好で安全な状態を維持しています。")}</h4>
              <p>
                {tr(locale, "This month we completed routine maintenance, resolved two content issues, and verified every scheduled availability check.", "今月は定期保守を完了し、2件のコンテンツ上の問題を解決したうえで、すべての定期確認に成功しました。")}
              </p>
            </div>
            <div className="paper-grid">
              <div>
                <span className="metric green">100%</span>
                <small>{tr(locale, "SCHEDULED CHECKS", "定期確認")}</small>
              </div>
              <div>
                <span className="metric">7</span>
                <small>{tr(locale, "CARE ACTIVITIES", "保守作業")}</small>
              </div>
              <div>
                <span className="metric">184ms</span>
                <small>{tr(locale, "MEDIAN RESPONSE", "応答中央値")}</small>
              </div>
            </div>
            <div className="paper-work">
              <small>{tr(locale, "WORK COMPLETED", "完了した作業")}</small>
              {[
                [tr(locale, "Security", "セキュリティ"), tr(locale, "Applied security updates and verified the site", "セキュリティ更新を適用し、サイトを確認")],
                [tr(locale, "Performance", "表示速度"), tr(locale, "Optimized large homepage images", "トップページの大きな画像を最適化")],
                [tr(locale, "Content", "コンテンツ"), tr(locale, "Updated the summer services page", "夏季サービスページを更新")],
              ].map(([tag, text]) => (
                <div className="work-line" key={tag}>
                  <span>{tag}</span>
                  <p>{text}</p>
                  <b>✓</b>
                </div>
              ))}
            </div>
          </div>
          <div className="float-note float-note-right">
            <span className="note-icon coral"><Icon name="report" /></span>
            <div><b>{tr(locale, "Report ready", "レポート完成")}</b><small>{tr(locale, "Review and share in one click", "確認してすぐ共有")}</small></div>
          </div>
        </section>

        <section className="problem-section">
          <div>
            <span className="section-number">{tr(locale, "01 — THE PROBLEM", "01 — 課題")}</span>
            <h2>{tr(locale, "Your best work is the work clients never notice.", "優れた保守ほど、お客様には見えにくい。")}</h2>
          </div>
          <div>
            <p>
              {tr(locale, "Updates run smoothly. Problems get prevented. Sites stay online. That is exactly what good maintenance looks like—but it can leave clients wondering what they are paying for.", "更新は滞りなく終わり、問題は起こる前に防がれ、サイトは動き続けます。それこそ良い保守ですが、お客様には何に料金を払っているのか見えにくくなります。")}
            </p>
            <p>
              {tr(locale, `${brand.name} gives the quiet work a clear, professional story every month.`, `${brand.name}は、目立たない保守作業を毎月わかりやすくプロフェッショナルに伝えます。`)}
            </p>
          </div>
        </section>

        <section className="how-section" id="how">
          <div className="section-heading">
            <span className="section-number">{tr(locale, "02 — HOW IT WORKS", "02 — 仕組み")}</span>
            <h2>{tr(locale, "From ten-second notes to a report clients understand.", "10秒の記録から、お客様に伝わるレポートへ。")}</h2>
          </div>
          <div className="step-grid">
            <article>
              <span className="step-no">1</span>
              <div className="step-icon"><Icon name="plus" /></div>
              <h3>{tr(locale, "Record the work", "作業を記録")}</h3>
              <p>{tr(locale, "Pick a client and a care activity. Add context only when it helps.", "クライアントと作業を選び、必要なときだけ補足します。")}</p>
            </article>
            <article>
              <span className="step-no">2</span>
              <div className="step-icon"><Icon name="pulse" /></div>
              <h3>{tr(locale, `Let ${brand.name} watch`, `${brand.name}が確認`)}</h3>
              <p>{tr(locale, "Daily checks capture website reachability and response evidence.", "毎日の確認で、サイトへの到達性と応答の記録を残します。")}</p>
            </article>
            <article>
              <span className="step-no">3</span>
              <div className="step-icon"><Icon name="report" /></div>
              <h3>{tr(locale, "Review and share", "確認して共有")}</h3>
              <p>{tr(locale, "Approve the monthly story, then send a private link or PDF.", "月次レポートを承認し、限定公開リンクまたはPDFで送ります。")}</p>
            </article>
          </div>
        </section>

        <section className="founder-cta">
          <span className="section-number">{tr(locale, "FOUNDING CUSTOMER OFFER", "先行ユーザー特典")}</span>
          <h2>{tr(locale, "Start proving your value for $5.", "$5で保守価値を伝え始めましょう。")}</h2>
          <p>
            {tr(locale, `Reserve early access. Your refundable $5 reservation becomes your first month when ${brand.name} opens.`, `返金可能な$5で先行利用を予約できます。正式提供開始時に予約金を初月料金へ充当します。`)}
          </p>
          <Link className="button button-light" to={`${prefix}/pricing`}>
            {tr(locale, "See founding pricing", "先行料金を見る")} <Icon name="arrow" />
          </Link>
        </section>
      </main>
      <MarketingFooter locale={locale} />
    </div>
  );
}

function Pricing({ locale = "en" }: { locale?: Locale }) {
  const prefix = locale === "ja" ? "/ja" : "";
  return (
    <div className="marketing">
      <MarketingHeader locale={locale} />
      <main className="pricing-page">
        <span className="section-number">{tr(locale, "SIMPLE, HONEST PRICING", "シンプルで明確な料金")}</span>
        <h1>{tr(locale, "Charge for care. Not report-writing hours.", "レポート作成時間ではなく、保守の価値に対価を。")}</h1>
        <p className="pricing-lead">
          {tr(locale, "All plans include activity logging, daily checks, client-ready reports, private sharing, PDF, and optional AI rewriting.", "すべてのプランに作業記録、毎日の確認、お客様向けレポート、限定公開、PDF、任意のAI文章変換が含まれます。")}
        </p>
        <div className="pricing-grid">
          <article className="price-card featured">
            <div className="popular">{tr(locale, "FOUNDING FAVORITE", "先行おすすめ")}</div>
            <h2>Starter</h2>
            <p>{tr(locale, "For a focused care practice.", "少数の保守顧客に集中する方へ。")}</p>
            <div className="price"><sup>$</sup>5<small>{tr(locale, "/ month", "/ 月")}</small></div>
            <p className="annual">{tr(locale, "$50 billed yearly — two months free", "年払い $50 — 2か月分お得")}</p>
            <ul>
              <li><Icon name="check" /> {tr(locale, "Up to 3 clients", "最大3クライアント")}</li>
              <li><Icon name="check" /> {tr(locale, "1 website per client", "1クライアント1サイト")}</li>
              <li><Icon name="check" /> {tr(locale, "3 important URLs per site", "サイトごとに重要URL 3件")}</li>
              <li><Icon name="check" /> {tr(locale, "Unlimited care activities", "作業記録数は無制限")}</li>
              <li><Icon name="check" /> {tr(locale, "Share link and PDF reports", "共有リンクとPDFレポート")}</li>
            </ul>
            <Link className="button" to={`${prefix}/login`}>
              {tr(locale, "Reserve for $5", "$5で予約")} <Icon name="arrow" />
            </Link>
          </article>
          <article className="price-card">
            <h2>Freelancer</h2>
            <p>{tr(locale, "For a growing client roster.", "保守顧客を増やしたい方へ。")}</p>
            <div className="price"><sup>$</sup>12<small>{tr(locale, "/ month", "/ 月")}</small></div>
            <p className="annual">{tr(locale, "$120 billed yearly — two months free", "年払い $120 — 2か月分お得")}</p>
            <ul>
              <li><Icon name="check" /> {tr(locale, "Up to 15 clients", "最大15クライアント")}</li>
              <li><Icon name="check" /> {tr(locale, "Everything in Starter", "Starterの全機能")}</li>
              <li><Icon name="check" /> {tr(locale, "Priority product feedback", "優先的な製品フィードバック")}</li>
              <li><Icon name="check" /> {tr(locale, "Founding price for first 10", "先着10名は先行料金を維持")}</li>
            </ul>
            <Link className="button button-dark" to={`${prefix}/login`}>
              {tr(locale, "Choose Freelancer", "Freelancerを選ぶ")} <Icon name="arrow" />
            </Link>
          </article>
        </div>
        <p className="payment-note">
          {tr(locale, "Payments are processed by Link as merchant of record through Stripe Managed Payments. Reservations are refundable before launch. No custom checkout domain is used.", "決済はStripe Managed Paymentsを通じて販売者であるLinkが処理します。予約金は正式提供開始前まで返金可能です。独自の決済ドメインは使用しません。")}
        </p>
      </main>
      <MarketingFooter locale={locale} />
    </div>
  );
}

function SampleReport({ locale = "en" }: { locale?: Locale }) {
  const sample: PublicReport = {
    locale,
    appName: brand.name,
    clientName: locale === "ja" ? "ノース＆パイン・スタジオ" : "North & Pine Studio",
    periodLabel: tr(locale, "June 1–30, 2026", "2026年6月"),
    generatedAt: "2026-07-01T09:00:00Z",
    pdfUrl: null,
    snapshot: {
      executiveSummary: tr(
        locale,
        "Your website stayed healthy, secure, and up to date. This month we completed routine maintenance, resolved two content issues, and verified every scheduled availability check.",
        "Webサイトは良好で安全な状態を維持しています。今月は定期保守を完了し、2件のコンテンツ上の問題を解決したうえで、すべての定期確認に成功しました。",
      ),
      currentHealth: {
        scheduled: 30,
        passed: 30,
        failed: 0,
        message: tr(locale, "30 of 30 scheduled checks passed", "30回中30回の定期確認に成功"),
        targets: [
          {
            target: "https://northpine.example/",
            passed: 30,
            total: 30,
            averageResponseMs: 214,
            tlsExpiresAt: "2026-09-28T00:00:00.000Z",
            status: "Healthy",
          },
        ],
      },
      maintenanceCoverage: locale === "ja" ? [
        { name: "公開サイト確認", category: "support", frequency: "daily", completedCount: 30, status: "completed" },
        { name: "セキュリティ確認", category: "security", frequency: "monthly", completedCount: 1, status: "completed" },
        { name: "バックアップ準備確認", category: "backups", frequency: "monthly", completedCount: 1, status: "completed" },
        { name: "フォーム・主要機能確認", category: "forms", frequency: "monthly", completedCount: 1, status: "completed" },
      ] : [
        { name: "Public site checks", category: "support", frequency: "daily", completedCount: 30, status: "completed" },
        { name: "Security review", category: "security", frequency: "monthly", completedCount: 1, status: "completed" },
        { name: "Backup readiness review", category: "backups", frequency: "monthly", completedCount: 1, status: "completed" },
        { name: "Forms and key-function review", category: "forms", frequency: "monthly", completedCount: 1, status: "completed" },
      ],
      workCompleted: locale === "ja" ? [
        { category: "セキュリティ", description: "定期的なセキュリティ更新を適用しました。", date: "2026-06-04", target: "メインサイト", outcomeType: "risk_reduced", resultSummary: "すべての更新が正常に完了しました。", verificationMethod: "公開ページと管理機能を確認", clientValue: "既知の脆弱性に対する露出を減らしました。" },
        { category: "パフォーマンス", description: "トップページの大きな画像を最適化しました。", date: "2026-06-12", target: "トップページ", outcomeType: "work_completed", resultSummary: "画像容量を削減しました。", verificationMethod: "公開ページをモバイルで確認", clientValue: "訪問者がページを閲覧しやすくなりました。" },
        { category: "コンテンツ", description: "夏季サービスページの改訂版を公開しました。", date: "2026-06-18", target: "サービスページ", outcomeType: "work_completed", resultSummary: "新しい内容が公開されています。", verificationMethod: "公開URLを確認", clientValue: "最新のサービス情報を案内できます。" },
        { category: "サポート", description: "フッターの連絡先表示に関する問題を修正しました。", date: "2026-06-25", target: "サイト共通フッター", outcomeType: "issue_resolved", resultSummary: "正しい連絡先が全ページに表示されています。", verificationMethod: "デスクトップとモバイルで確認", clientValue: "訪問者が正しい窓口へ連絡できます。" },
      ] : [
        { category: "Security", description: "Applied routine security updates.", date: "2026-06-04", target: "Main website", outcomeType: "risk_reduced", resultSummary: "All updates completed successfully.", verificationMethod: "Reviewed public pages and administration", clientValue: "Reduced exposure to known vulnerabilities." },
        { category: "Performance", description: "Optimized large homepage images for faster delivery.", date: "2026-06-12", target: "Homepage", outcomeType: "work_completed", resultSummary: "Reduced image payload size.", verificationMethod: "Reviewed the live page on mobile", clientValue: "Visitors can reach the page content more quickly." },
        { category: "Content", description: "Published the revised summer services page.", date: "2026-06-18", target: "Services page", outcomeType: "work_completed", resultSummary: "The revised content is live.", verificationMethod: "Checked the public URL", clientValue: "Visitors now see current service information." },
        { category: "Support", description: "Resolved an issue affecting the contact details in the footer.", date: "2026-06-25", target: "Site-wide footer", outcomeType: "issue_resolved", resultSummary: "The correct details now appear across the site.", verificationMethod: "Checked desktop and mobile layouts", clientValue: "Visitors can reach the correct contact channel." },
      ],
      problemsPrevented: locale === "ja"
        ? [{ summary: "セキュリティ更新を適用し、公開サイトの正常動作を確認しました。", outcomeType: "risk_reduced" }, { summary: "重要ページへの定期確認はすべて成功しました。", outcomeType: "routine_verification" }]
        : [{ summary: "Applied security updates and confirmed the public site remained functional.", outcomeType: "risk_reduced" }, { summary: "Every scheduled observation of important pages passed.", outcomeType: "routine_verification" }],
      recommendations: locale === "ja"
        ? [{ summary: "ポートフォリオ写真の見直しと更新をご検討ください。", priority: "medium", nextAction: "来月の保守前に更新候補の写真をご共有ください。" }]
        : [{ summary: "Review and refresh the portfolio photography.", priority: "medium", nextAction: "Share candidate images before next month's care visit." }],
      nextMonthPlan: tr(locale, "Continue scheduled care and review the proposed portfolio refresh.", "定期保守を継続し、提案中のポートフォリオ写真更新を確認します。"),
      closingMessage: tr(
        locale,
        "Your website is in good shape. We will continue monitoring it and taking care of routine maintenance next month.",
        "Webサイトは良好な状態です。来月も継続して状態確認と定期保守を行います。",
      ),
    },
  };
  return (
    <div className="public-page">
      <PublicReportView report={sample} sample />
    </div>
  );
}

function Login({ locale = "en" }: { locale?: Locale }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const result = await authClient.signIn.magicLink({
      email,
      callbackURL: "/app",
      newUserCallbackURL: "/app",
      errorCallbackURL: "/login",
    });
    setLoading(false);
    if (result.error) {
      setError(result.error.message ?? tr(locale, "We could not send that link.", "ログインリンクを送信できませんでした。"));
      return;
    }
    setSent(true);
  }

  useEffect(() => {
    void authClient.getSession().then(({ data }) => {
      if (data) void navigate("/app", { replace: true });
    });
  }, [navigate]);

  return (
    <div className="login-page">
      <div className="login-brand">
        <Logo home={locale === "ja" ? "/ja" : "/"} />
        <div>
          <span className="section-number">{tr(locale, "YOUR CARE, MADE VISIBLE", "保守の価値を見えるかたちに")}</span>
          <h1>{tr(locale, "Clients keep trusting the work they can understand.", "伝わる保守が、お客様の信頼を育てます。")}</h1>
          <p>
            {tr(locale, "Record care in seconds, collect real monitoring evidence, and send a report worth renewing.", "保守作業を数秒で記録し、実際の確認結果をまとめ、継続したくなるレポートを届けましょう。")}
          </p>
        </div>
        <blockquote>
          {tr(locale, "“I finally have something useful to send at the end of every month.”", "「毎月末に、お客様へきちんと送れるものができました。」")}
          <small>{tr(locale, "— Sample beta feedback", "— ベータ版の声（サンプル）")}</small>
        </blockquote>
      </div>
      <main className="login-panel">
        <div className="login-box">
          <Link className="back-link" to={locale === "ja" ? "/ja" : "/"}>← {tr(locale, `Back to ${brand.name}`, `${brand.name}へ戻る`)}</Link>
          {sent ? (
            <div className="sent-state">
              <span className="big-check"><Icon name="check" /></span>
              <h2>{tr(locale, "Check your inbox", "受信トレイをご確認ください")}</h2>
              <p>
                {tr(locale, "We sent a secure sign-in link to", "安全なログインリンクを送信しました：")} <b>{email}</b>。{tr(locale, "It expires in 15 minutes and works once.", "有効期限は15分で、1回だけ使用できます。")}
              </p>
              <button className="text-button" onClick={() => setSent(false)}>
                {tr(locale, "Use a different email", "別のメールアドレスを使う")}
              </button>
            </div>
          ) : (
            <>
              <span className="section-number">{tr(locale, "WELCOME", "ログイン")}</span>
              <h2>{tr(locale, "Sign in to your workspace", "ワークスペースにログイン")}</h2>
              <p>{tr(locale, "No password to remember. We will email you a secure link.", "パスワードは不要です。安全なリンクをメールでお送りします。")}</p>
              <form onSubmit={submit}>
                <label>
                  {tr(locale, "Work email", "メールアドレス")}
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@yourstudio.com"
                    autoFocus
                  />
                </label>
                {error && <div className="form-error">{error}</div>}
                <button className="button button-wide" disabled={loading}>
                  {loading ? tr(locale, "Sending…", "送信中…") : tr(locale, "Email me a sign-in link", "ログインリンクを送信")}
                  {!loading && <Icon name="arrow" />}
                </button>
              </form>
              <small className="login-terms">
                {tr(locale, "By continuing, you agree to the Terms and acknowledge the Privacy Policy.", "続行すると、利用規約に同意し、プライバシーポリシーを確認したものとみなされます。")}
              </small>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "ready" | "signed-out">("loading");
  useEffect(() => {
    void authClient.getSession().then(({ data }) =>
      setState(data ? "ready" : "signed-out"),
    );
  }, []);
  if (state === "loading") return <div className="loading-screen"><span /></div>;
  if (state === "signed-out") return <Navigate to="/login" replace />;
  return children;
}

function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState<SessionData | null>(null);
  const locale = me?.workspace.uiLocale ?? "en";
  useEffect(() => {
    api<SessionData>("/api/me")
      .then((data) => {
        setMe(data);
        if (["unpaid", "canceled"].includes(data.subscription.status) && location.pathname !== "/app/billing") {
          void navigate("/app/billing", { replace: true });
        }
      })
      .catch(() => navigate("/login", { replace: true }));
  }, [location.pathname, navigate]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  async function changeLocale(nextLocale: Locale) {
    if (!me || nextLocale === locale) return;
    const previous = me;
    setMe({ ...me, workspace: { ...me.workspace, uiLocale: nextLocale } });
    try {
      await api("/api/me/locale", {
        method: "PATCH",
        body: JSON.stringify({ locale: nextLocale }),
      });
    } catch {
      setMe(previous);
    }
  }

  async function signOut() {
    await authClient.signOut();
    void navigate(locale === "ja" ? "/ja" : "/");
  }

  return (
    <UiLocaleContext.Provider value={locale}>
    <div className={`app-shell ${locale === "ja" ? "ui-ja" : ""}`}>
      <aside className="sidebar">
        <Logo />
        <nav>
          <NavLink end to="/app"><Icon name="pulse" /> {tr(locale, "Overview", "概要")}</NavLink>
          <NavLink to="/app/clients"><Icon name="client" /> {tr(locale, "Clients", "クライアント")}</NavLink>
          <NavLink to="/app/activity"><Icon name="activity" /> {tr(locale, "Activity", "作業記録")}</NavLink>
          <NavLink to="/app/reports"><Icon name="report" /> {tr(locale, "Reports", "レポート")}</NavLink>
        </nav>
        <div className="sidebar-bottom">
          <LanguageSwitch locale={locale} onChange={(next) => void changeLocale(next)} compact />
          <div className="plan-pill">
            <span>{me?.subscription.plan ?? "Starter"}</span>
            <small>{tr(locale, `Up to ${me?.subscription.clientLimit ?? 3} clients`, `最大${me?.subscription.clientLimit ?? 3}クライアント`)}</small>
          </div>
          <button onClick={signOut}>
            <span className="avatar">{me?.user.name?.slice(0, 1) || "C"}</span>
            <span><b>{me?.user.name || tr(locale, "Care professional", "Web保守担当者")}</b><small>{me?.user.email}</small></span>
          </button>
        </div>
      </aside>
      <div className="mobile-language-switch">
        <LanguageSwitch locale={locale} onChange={(next) => void changeLocale(next)} compact />
      </div>
      <main className="app-main">
        <Routes>
          <Route index element={<Dashboard me={me} />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="activity" element={<ActivityPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="billing" element={<BillingPage me={me} />} />
        </Routes>
      </main>
    </div>
    </UiLocaleContext.Provider>
  );
}

function PageHeader({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="app-page-header">
      <div><small>{kicker}</small><h1>{title}</h1></div>
      <div>{children}</div>
    </header>
  );
}

function Dashboard({ me }: { me: SessionData | null }) {
  const locale = useUiLocale();
  const [clients, setClients] = useState<Client[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  useEffect(() => {
    void Promise.all([
      api<{ clients: Client[] }>("/api/clients"),
      api<{ activities: Activity[] }>("/api/activities?limit=5"),
      api<{ reports: Report[] }>("/api/reports"),
    ]).then(([c, a, r]) => {
      setClients(c.clients);
      setActivities(a.activities);
      setReports(r.reports);
    }).catch(() => undefined);
  }, []);

  const now = new Date();
  const month = now.toLocaleString(locale === "ja" ? "ja-JP" : "en-US", { month: "long" });
  const drafted = reports.filter((report) => report.status === "draft").length;
  return (
    <>
      <PageHeader
        kicker={tr(locale, `${month.toUpperCase()} CARE WORKSPACE`, `${month}の保守ワークスペース`)}
        title={tr(locale, `Good ${now.getHours() < 12 ? "morning" : "afternoon"}, ${me?.user.name?.split(" ")[0] || "there"}.`, `${me?.user.name?.split(" ")[0] || ""}さん、お疲れさまです。`)}
      >
        <Link className="button button-small" to="/app/activity">
          <Icon name="plus" /> {tr(locale, "Quick add", "かんたん記録")}
        </Link>
      </PageHeader>
      <section className="dashboard-intro">
        <div>
          <span className="live-dot" /> {tr(locale, "YOUR MONTH AT A GLANCE", "今月の状況")}
          <h2>{tr(locale, "Your client care is taking shape.", "保守の記録が形になってきました。")}</h2>
          <p>{tr(locale, "Keep the record current now, and the report writes itself later.", "日々記録しておけば、後でレポートが自然にまとまります。")}</p>
        </div>
        <div className="month-ring"><b>{activities.length}</b><small>{tr(locale, <><span>recent</span><br />activities</>, <>最近の<br />作業</>)}</small></div>
      </section>
      <section className="stat-grid">
        <article><span>{tr(locale, "ACTIVE CLIENTS", "クライアント")}</span><b>{clients.length}</b><small>{tr(locale, `of ${me?.subscription.clientLimit ?? 3} plan slots`, `上限 ${me?.subscription.clientLimit ?? 3}件`)}</small></article>
        <article><span>{tr(locale, "DRAFT REPORTS", "下書きレポート")}</span><b>{drafted}</b><small>{tr(locale, "ready for your review", "確認待ち")}</small></article>
        <article><span>{tr(locale, "REPORTS SENT", "確定レポート")}</span><b>{reports.filter((r) => r.status === "finalized").length}</b><small>{tr(locale, "all time", "累計")}</small></article>
      </section>
      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-head"><h3>{tr(locale, "Recent care activity", "最近の作業記録")}</h3><Link to="/app/activity">{tr(locale, "View all", "すべて見る")} →</Link></div>
          {activities.length ? (
            <div className="activity-list compact">
              {activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
            </div>
          ) : (
            <EmptyState icon="activity" title={tr(locale, "No activity yet", "作業記録はまだありません")} text={tr(locale, "Record your first care task. It takes about ten seconds.", "最初の保守作業を記録しましょう。約10秒で完了します。")}>
              <Link className="button button-small" to="/app/activity">{tr(locale, "Add activity", "作業を記録")}</Link>
            </EmptyState>
          )}
        </article>
        <article className="panel">
          <div className="panel-head"><h3>{tr(locale, "Client coverage", "クライアント状況")}</h3><Link to="/app/clients">{tr(locale, "Manage", "管理")} →</Link></div>
          {clients.length ? (
            <div className="client-mini-list">
              {clients.slice(0, 5).map((client) => (
                <div key={client.id}>
                  <span className="client-initial">{client.name.slice(0, 2).toUpperCase()}</span>
                  <div><b>{client.name}</b><small>{client.asset?.url ?? tr(locale, "No website added", "サイト未登録")}</small></div>
                  <span className={client.asset ? "status-good" : "status-muted"}>{client.asset ? tr(locale, "Watching", "確認中") : tr(locale, "Setup", "要設定")}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon="client" title={tr(locale, "Add your first client", "最初のクライアントを追加")} text={tr(locale, "Their website and care history will live here.", "Webサイトと保守履歴がここに表示されます。")}>
              <Link className="button button-small" to="/app/clients">{tr(locale, "Add client", "クライアントを追加")}</Link>
            </EmptyState>
          )}
        </article>
      </section>
    </>
  );
}

function EmptyState({
  icon,
  title,
  text,
  children,
}: {
  icon: string;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span><Icon name={icon} /></span><h4>{title}</h4><p>{text}</p>{children}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>{title}</h2><button onClick={onClose} aria-label="Close">×</button></header>
        {children}
      </section>
    </div>
  );
}

function ClientsPage() {
  const locale = useUiLocale();
  const [clients, setClients] = useState<Client[]>([]);
  const [open, setOpen] = useState(false);
  const [careClientId, setCareClientId] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void api<{ clients: Client[] }>("/api/clients")
      .then((data) => setClients(data.clients))
      .catch(() => setError(tr(locale, "Could not load clients.", "クライアントを読み込めませんでした。")));
  }, [locale]);
  useEffect(load, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    const criticalUrls = ["critical1", "critical2", "critical3"]
      .map((key) => data.get(key)?.toString().trim())
      .filter(Boolean);
    try {
      await api("/api/clients", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          contactName: data.get("contactName") || undefined,
          contactEmail: data.get("contactEmail") || undefined,
          reportLocale: data.get("reportLocale"),
          assetName: "Main website",
          url: data.get("url"),
          criticalUrls,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      setOpen(false);
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(locale, "Could not save client.", "クライアントを保存できませんでした。"));
    }
  }

  async function changeReportLocale(client: Client, reportLocale: Locale) {
    const previous = clients;
    setClients((current) => current.map((item) => item.id === client.id ? { ...item, reportLocale } : item));
    try {
      await api(`/api/clients/${client.id}/report-locale`, {
        method: "PATCH",
        body: JSON.stringify({ locale: reportLocale }),
      });
    } catch {
      setClients(previous);
      setError(tr(locale, "Could not update the report language.", "レポート言語を変更できませんでした。"));
    }
  }

  async function addMaintenanceItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api(`/api/clients/${careClientId}/maintenance-items`, {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          category: data.get("category"),
          frequency: data.get("frequency"),
        }),
      });
      event.currentTarget.reset();
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(locale, "Could not add the care item.", "保守項目を追加できませんでした。"));
    }
  }

  async function updateMaintenanceItem(id: string, input: Partial<Pick<MaintenanceItem, "frequency" | "enabled">>) {
    try {
      await api(`/api/maintenance-items/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      load();
    } catch {
      setError(tr(locale, "Could not update the care item.", "保守項目を更新できませんでした。"));
    }
  }

  async function deleteMaintenanceItem(id: string) {
    try {
      await api(`/api/maintenance-items/${id}`, { method: "DELETE" });
      load();
    } catch {
      setError(tr(locale, "Could not remove the care item.", "保守項目を削除できませんでした。"));
    }
  }

  const careClient = clients.find((client) => client.id === careClientId) ?? null;

  return (
    <>
      <PageHeader kicker={tr(locale, "YOUR CARE ROSTER", "保守クライアント一覧")} title={tr(locale, "Clients", "クライアント")}>
        <button className="button button-small" onClick={() => setOpen(true)}><Icon name="plus" /> {tr(locale, "Add client", "クライアントを追加")}</button>
      </PageHeader>
      <div className="page-lead"><p>{tr(locale, "One clear record for every website you protect.", "保守するWebサイトごとに、わかりやすい記録を残します。")}</p><span>{tr(locale, `${clients.length} active`, `${clients.length}件`)}</span></div>
      {clients.length ? (
        <div className="client-card-grid">
          {clients.map((client) => (
            <article className="client-card" key={client.id}>
              <div className="client-card-top">
                <span className="client-initial large">{client.name.slice(0, 2).toUpperCase()}</span>
                <span className={client.asset ? "status-good" : "status-muted"}>{client.asset ? tr(locale, "Watching daily", "毎日確認中") : tr(locale, "Needs setup", "設定が必要")}</span>
              </div>
              <h2>{client.name}</h2>
              <p>{client.contactName || tr(locale, "No contact name", "担当者名なし")} · {client.contactEmail || tr(locale, "No report email", "送信先メールなし")}</p>
              {client.asset && (
                <a href={client.asset.url} target="_blank" rel="noreferrer">
                  {new URL(client.asset.url).hostname} <Icon name="external" />
                </a>
              )}
              <label className="inline-locale-field">
                <span>{tr(locale, "Report language", "レポート言語")}</span>
                <select value={client.reportLocale} onChange={(event) => void changeReportLocale(client, event.target.value as Locale)}>
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                </select>
              </label>
              <div className="care-plan-preview">
                <span>{tr(locale, "Care plan", "保守プラン")}</span>
                <b>{tr(locale, `${client.maintenanceItems.filter((item) => item.enabled).length} configured items`, `${client.maintenanceItems.filter((item) => item.enabled).length}項目`)}</b>
                <button type="button" className="text-button" onClick={() => setCareClientId(client.id)}>{tr(locale, "Manage", "管理")}</button>
              </div>
              <div className="client-card-foot">
                <Link to={`/app/activity?client=${client.id}`}>{tr(locale, "Add activity", "作業を記録")}</Link>
                <Link to={`/app/reports?client=${client.id}`}>{tr(locale, "Create report", "レポート作成")}</Link>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="large-empty">
          <EmptyState icon="client" title={tr(locale, "Your first client is one minute away", "最初のクライアントを登録しましょう")} text={tr(locale, `Add a name, email, and public website. ${brand.name} will prepare the daily check schedule.`, `名称、メール、公開サイトを登録すると、${brand.name}が毎日の確認を準備します。`)}>
            <button className="button" onClick={() => setOpen(true)}>{tr(locale, "Add your first client", "最初のクライアントを追加")} <Icon name="arrow" /></button>
          </EmptyState>
        </div>
      )}
      {open && (
        <Modal title={tr(locale, "Add a client", "クライアントを追加")} onClose={() => setOpen(false)}>
          <form className="stack-form" onSubmit={create}>
            <div className="form-row">
              <label>{tr(locale, "Client or business name", "クライアント・事業者名")}<input name="name" required placeholder={tr(locale, "North & Pine Studio", "サンプル株式会社")} /></label>
              <label>{tr(locale, "Contact name", "担当者名")}<input name="contactName" placeholder={tr(locale, "Avery Morgan", "山田 太郎")} /></label>
            </div>
            <label>{tr(locale, "Report email", "レポート送信先")}<input name="contactEmail" type="email" placeholder="client@example.com" /></label>
            <label>{tr(locale, "Report language", "レポート言語")}<select name="reportLocale" defaultValue={locale}><option value="en">English</option><option value="ja">日本語</option></select></label>
            <label>{tr(locale, "Public website URL", "公開WebサイトURL")}<input name="url" type="url" required placeholder="https://example.com" /></label>
            <div className="field-help">{tr(locale, "Only public HTTP/HTTPS sites are accepted. Private networks, credentials, and unsafe redirects are blocked.", "公開されたHTTP/HTTPSサイトのみ登録できます。プライベートネットワーク、認証情報、危険なリダイレクトは拒否されます。")}</div>
            <details>
              <summary>{tr(locale, "Add important URLs (optional, up to 3)", "重要URLを追加（任意・最大3件）")}</summary>
              <label>{tr(locale, "Important URL 1", "重要URL 1")}<input name="critical1" type="url" placeholder="https://example.com/contact" /></label>
              <label>{tr(locale, "Important URL 2", "重要URL 2")}<input name="critical2" type="url" placeholder="https://example.com/services" /></label>
              <label>{tr(locale, "Important URL 3", "重要URL 3")}<input name="critical3" type="url" placeholder="https://example.com/shop" /></label>
            </details>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setOpen(false)}>{tr(locale, "Cancel", "キャンセル")}</button><button className="button">{tr(locale, "Save client", "保存")} <Icon name="arrow" /></button></div>
          </form>
        </Modal>
      )}
      {careClient && (
        <Modal title={tr(locale, `${careClient.name} care plan`, `${careClient.name}の保守プラン`)} onClose={() => setCareClientId("")}>
          <div className="care-plan-editor">
            <p>{tr(locale, "These items define the agreed maintenance scope shown in monthly reports.", "月次レポートに表示する、合意済みの保守範囲を設定します。")}</p>
            <div className="care-plan-list">
              {careClient.maintenanceItems.length ? careClient.maintenanceItems.map((item) => (
                <div className={!item.enabled ? "disabled" : ""} key={item.id}>
                  <label className="care-toggle">
                    <input type="checkbox" checked={item.enabled} onChange={(event) => void updateMaintenanceItem(item.id, { enabled: event.target.checked })} />
                    <span><b>{item.name}</b><small>{categoryName(item.category, locale)}</small></span>
                  </label>
                  <select value={item.frequency} onChange={(event) => void updateMaintenanceItem(item.id, { frequency: event.target.value as MaintenanceItem["frequency"] })}>
                    {(["daily", "weekly", "monthly", "quarterly", "as_needed"] as const).map((frequency) => <option value={frequency} key={frequency}>{frequencyName(frequency, locale)}</option>)}
                  </select>
                  <button type="button" className="text-button danger" onClick={() => void deleteMaintenanceItem(item.id)}>{tr(locale, "Remove", "削除")}</button>
                </div>
              )) : <p>{tr(locale, "No care items configured.", "保守項目はまだありません。")}</p>}
            </div>
            <form className="care-plan-add" onSubmit={addMaintenanceItem}>
              <label>{tr(locale, "New care item", "新しい保守項目")}<input name="name" required maxLength={120} placeholder={tr(locale, "Example: Monthly form test", "例：月次フォーム確認")} /></label>
              <div className="form-row">
                <label>{tr(locale, "Category", "カテゴリー")}<select name="category" defaultValue="support">{categories.map(([value]) => <option value={value} key={value}>{categoryName(value, locale)}</option>)}</select></label>
                <label>{tr(locale, "Frequency", "頻度")}<select name="frequency" defaultValue="monthly">{(["daily", "weekly", "monthly", "quarterly", "as_needed"] as const).map((frequency) => <option value={frequency} key={frequency}>{frequencyName(frequency, locale)}</option>)}</select></label>
              </div>
              <button className="button button-small">{tr(locale, "Add care item", "保守項目を追加")}</button>
            </form>
            {error && <div className="form-error">{error}</div>}
          </div>
        </Modal>
      )}
    </>
  );
}

function ActivityRow({ activity }: { activity: Activity }) {
  const locale = useUiLocale();
  const category = categoryName(activity.category, locale);
  const visibilityLabel = {
    client_visible: tr(locale, "client visible", "お客様向け"),
    internal_only: tr(locale, "internal only", "内部記録"),
    recommendation: tr(locale, "recommendation", "ご提案"),
  }[activity.visibility];
  return (
    <div className="activity-row">
      <span className={`category-dot ${activity.category}`} />
      <div><b>{activity.clientDescription || activity.internalNote || category}</b><small>{activity.clientName} · {outcomeName(activity.outcomeType, locale)} · {new Date(activity.occurredAt).toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US")}</small>{activity.resultSummary && <small>{tr(locale, "Result", "結果")}: {activity.resultSummary}</small>}</div>
      <span className={`visibility ${activity.visibility}`}>{visibilityLabel}</span>
    </div>
  );
}

function ActivityPage() {
  const locale = useUiLocale();
  const [clients, setClients] = useState<Client[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("updates");
  const [visibility, setVisibility] = useState("client_visible");
  const [outcomeType, setOutcomeType] = useState<Activity["outcomeType"]>("work_completed");
  const [description, setDescription] = useState("");
  const [aiRewriteId, setAiRewriteId] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState(() => new URLSearchParams(window.location.search).get("client") ?? "");
  const load = useCallback(() => {
    void Promise.all([
      api<{ clients: Client[] }>("/api/clients"),
      api<{ activities: Activity[] }>("/api/activities?limit=100"),
    ]).then(([c, a]) => {
      setClients(c.clients);
      setActivities(a.activities);
      setSelectedClientId((current) => current || c.clients[0]?.id || "");
    })
      .catch(() => setError(tr(locale, "Could not load care activity.", "作業記録を読み込めませんでした。")));
  }, [locale]);
  useEffect(load, [load]);

  async function rewrite() {
    if (!description.trim()) return;
    setRewriting(true);
    setError("");
    try {
      const result = await api<{ rewriteId: string; rewrittenText: string; category: string }>("/api/ai/rewrite", {
        method: "POST",
        body: JSON.stringify({ clientId: selectedClientId, text: description, category }),
      });
      setDescription(result.rewrittenText);
      setCategory(result.category);
      setAiRewriteId(result.rewriteId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(locale, "AI rewrite was unavailable. Your original text is unchanged.", "AI変換を利用できませんでした。元の文章は変更されていません。"));
    } finally {
      setRewriting(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/activities", {
        method: "POST",
        body: JSON.stringify({
          clientId: data.get("clientId"),
          maintenanceItemId: data.get("maintenanceItemId") || undefined,
          category,
          target: data.get("target") || undefined,
          outcomeType,
          internalNote: data.get("internalNote") || undefined,
          clientDescription: description || undefined,
          resultSummary: data.get("resultSummary") || undefined,
          verificationMethod: data.get("verificationMethod") || undefined,
          clientValue: data.get("clientValue") || undefined,
          recommendationPriority: data.get("recommendationPriority") || undefined,
          nextAction: data.get("nextAction") || undefined,
          aiRewriteId: aiRewriteId || undefined,
          visibility,
          occurredAt: new Date(`${data.get("date")}T12:00:00`).toISOString(),
        }),
      });
      setOpen(false);
      setDescription("");
      setAiRewriteId("");
      setCategory("updates");
      setOutcomeType("work_completed");
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(locale, "Could not save activity.", "作業記録を保存できませんでした。"));
    }
  }

  return (
    <>
      <PageHeader kicker={tr(locale, "THE WORK BEHIND THE WORK", "保守の裏側にある作業")} title={tr(locale, "Care activity", "作業記録")}>
        <button className="button button-small" disabled={!clients.length} onClick={() => setOpen(true)}><Icon name="plus" /> {tr(locale, "Quick add", "かんたん記録")}</button>
      </PageHeader>
      <div className="page-lead"><p>{tr(locale, "Short, factual notes now become a strong client story later.", "短く事実に基づく記録が、後でお客様に伝わるレポートになります。")}</p><span>{tr(locale, `${activities.length} recorded`, `${activities.length}件`)}</span></div>
      <section className="panel full-panel">
        {activities.length ? <div className="activity-list">{activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}</div> : (
          <EmptyState icon="activity" title={clients.length ? tr(locale, "Record your first care activity", "最初の作業を記録しましょう") : tr(locale, "Add a client first", "先にクライアントを追加してください")} text={clients.length ? tr(locale, `Choose a common task and ${brand.name} will suggest client-ready language.`, `よくある作業を選ぶと、${brand.name}がお客様向けの文章を提案します。`) : tr(locale, "Activities always belong to a client, so start by creating one.", "作業記録にはクライアントが必要です。まずクライアントを登録してください。")}>
            <Link className="button button-small" to={clients.length ? "#" : "/app/clients"} onClick={() => clients.length && setOpen(true)}>{clients.length ? tr(locale, "Quick add", "かんたん記録") : tr(locale, "Add a client", "クライアントを追加")}</Link>
          </EmptyState>
        )}
      </section>
      {open && (
        <Modal title={tr(locale, "Quick add care activity", "作業をかんたん記録")} onClose={() => setOpen(false)}>
          <form className="stack-form" onSubmit={create}>
            <div className="form-row">
              <label>{tr(locale, "Client", "クライアント")}<select name="clientId" required value={selectedClientId} onChange={(event) => setSelectedClientId(event.target.value)}>{clients.map((client) => <option value={client.id} key={client.id}>{client.name} · {client.reportLocale === "ja" ? "日本語" : "English"}</option>)}</select></label>
              <label>{tr(locale, "Date", "作業日")}<input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label>
            </div>
            <label>{tr(locale, "Care plan item", "保守プラン項目")} <span className="optional">{tr(locale, "optional", "任意")}</span>
              <select
                name="maintenanceItemId"
                defaultValue=""
                onChange={(event) => {
                  const selected = clients
                    .find((client) => client.id === selectedClientId)
                    ?.maintenanceItems.find((item) => item.id === event.target.value);
                  if (selected) setCategory(selected.category);
                }}
              >
                <option value="">{tr(locale, "Not linked to a care item", "保守項目に関連付けない")}</option>
                {clients.find((client) => client.id === selectedClientId)?.maintenanceItems.filter((item) => item.enabled).map((item) => <option value={item.id} key={item.id}>{item.name} · {frequencyName(item.frequency, locale)}</option>)}
              </select>
            </label>
            <fieldset className="category-picker">
              <legend>{tr(locale, "What kind of work?", "どのような作業ですか？")}</legend>
              <div>{categories.map(([value]) => <button type="button" className={category === value ? "active" : ""} onClick={() => setCategory(value)} key={value}>{categoryName(value, locale)}</button>)}</div>
            </fieldset>
            <label>{tr(locale, "Work performed", "実施内容")}<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={tr(locale, "Example: Updated the site software.", "例：サイトのソフトウェアを更新しました。")} rows={3} /></label>
            <button type="button" className="rewrite-button" onClick={rewrite} disabled={rewriting || !description.trim()}>
              ✦ {rewriting ? tr(locale, "Rewriting…", "変換中…") : tr(locale, "Rewrite for client", "お客様向けに書き換える")} <small>{tr(locale, "Only this description is sent to AI", "この説明文だけをAIへ送信します")}</small>
            </button>
            <fieldset className="outcome-picker">
              <legend>{tr(locale, "What kind of outcome?", "成果の種類")}</legend>
              <div>
                {(["work_completed", "issue_resolved", "risk_reduced", "routine_verification"] as const).map((value) => (
                  <button type="button" className={outcomeType === value ? "active" : ""} onClick={() => setOutcomeType(value)} key={value}>{outcomeName(value, locale)}</button>
                ))}
              </div>
            </fieldset>
            <details className="activity-details">
              <summary>{tr(locale, "Add result and evidence", "結果と確認内容を追加")}</summary>
              <label>{tr(locale, "Target page or function", "対象ページ・機能")}<input name="target" maxLength={300} placeholder={tr(locale, "Contact form, homepage, checkout…", "お問い合わせフォーム、トップページ、決済など")} /></label>
              <label>{tr(locale, "Result", "結果")}<textarea name="resultSummary" maxLength={500} rows={2} placeholder={tr(locale, "What was true after the work?", "作業後にどのような状態になりましたか？")} /></label>
              <label>{tr(locale, "Verification method", "確認方法")}<textarea name="verificationMethod" maxLength={500} rows={2} placeholder={tr(locale, "Checked the public page on desktop and mobile.", "公開ページをパソコンとスマートフォンで確認。")} /></label>
              <label>{tr(locale, "Client value", "お客様への価値")}<textarea name="clientValue" maxLength={500} rows={2} placeholder={tr(locale, "Why does this matter to the client?", "お客様にとってどのような意味がありますか？")} /></label>
            </details>
            <label>{tr(locale, "Internal note", "内部メモ")} <span className="optional">{tr(locale, "never shown to the client", "お客様には表示されません")}</span><textarea name="internalNote" placeholder={tr(locale, "Technical details, ticket number, credentials reminder…", "技術的な詳細、チケット番号、認証情報に関する注意など")} rows={2} /></label>
            <fieldset className="visibility-picker">
              <legend>{tr(locale, "Where should this appear?", "どこに表示しますか？")}</legend>
              {[
                ["client_visible", tr(locale, "Client-visible", "お客様向け"), tr(locale, "Work completed", "完了した作業")],
                ["internal_only", tr(locale, "Internal only", "内部のみ"), tr(locale, "Private record", "非公開の記録")],
                ["recommendation", tr(locale, "Recommendation", "ご提案"), tr(locale, "Next-step section", "今後のご提案")],
              ].map(([value, title, help]) => <label className={visibility === value ? "active" : ""} key={value}><input type="radio" checked={visibility === value} onChange={() => setVisibility(value)} /><span><b>{title}</b><small>{help}</small></span></label>)}
            </fieldset>
            {visibility === "recommendation" && (
              <div className="recommendation-fields">
                <label>{tr(locale, "Priority", "優先度")}<select name="recommendationPriority" defaultValue="medium"><option value="low">{priorityName("low", locale)}</option><option value="medium">{priorityName("medium", locale)}</option><option value="high">{priorityName("high", locale)}</option></select></label>
                <label>{tr(locale, "Next action", "次のアクション")}<input name="nextAction" maxLength={500} placeholder={tr(locale, "Example: Approve the proposed change by August 15.", "例：8月15日までに変更案をご確認ください。")} /></label>
              </div>
            )}
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setOpen(false)}>{tr(locale, "Cancel", "キャンセル")}</button><button className="button">{tr(locale, "Save activity", "作業を保存")} <Icon name="check" /></button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ReportsPage() {
  const locale = useUiLocale();
  const [clients, setClients] = useState<Client[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState<{ report: Report; snapshot: EditableReportSnapshot } | null>(null);
  const [saving, setSaving] = useState(false);
  const [repairingPdf, setRepairingPdf] = useState("");
  const [error, setError] = useState("");
  const [draftClientId, setDraftClientId] = useState(() => new URLSearchParams(window.location.search).get("client") ?? "");
  const [draftLocale, setDraftLocale] = useState<Locale>("en");
  const load = useCallback(() => {
    void Promise.all([
      api<{ clients: Client[] }>("/api/clients"),
      api<{ reports: Report[] }>("/api/reports"),
    ]).then(([c, r]) => {
      setClients(c.clients);
      setReports(r.reports);
      setDraftClientId((current) => {
        const next = current || c.clients[0]?.id || "";
        setDraftLocale(c.clients.find((client) => client.id === next)?.reportLocale ?? "en");
        return next;
      });
    })
      .catch(() => setError(tr(locale, "Could not load reports.", "レポートを読み込めませんでした。")));
  }, [locale]);
  useEffect(load, [load]);

  const defaultDates = useMemo(() => {
    const now = new Date();
    return previousMonthDateRange(now.getFullYear(), now.getMonth());
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/reports/draft", {
        method: "POST",
        body: JSON.stringify({ clientId: data.get("clientId"), locale: data.get("locale"), periodStart: data.get("periodStart"), periodEnd: data.get("periodEnd") }),
      });
      setOpen(false);
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : tr(locale, "Could not build report.", "レポートを作成できませんでした。"));
    }
  }

  async function review(report: Report) {
    try {
      const detail = await api<{ snapshot: EditableReportSnapshot }>(`/api/reports/${report.id}`);
      setReviewing({ report, snapshot: detail.snapshot });
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Could not open report.", "レポートを開けませんでした。"));
    }
  }

  async function saveAndFinalize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewing) return;
    const data = new FormData(event.currentTarget);
    const email = String(data.get("recipientEmail") ?? "").trim();
    setSaving(true);
    const snapshot = reviewing.snapshot;
    try {
      await api(`/api/reports/${reviewing.report.id}`, {
        method: "PUT",
        body: JSON.stringify({
          executiveSummary: data.get("executiveSummary"),
          workCompleted: snapshot.workCompleted.map((item, index) => ({
            ...item,
            summary: data.get(`work-${index}`),
          })),
          problemsPrevented: snapshot.problemsPrevented.map((item, index) => ({
            ...item,
            summary: data.get(`problem-${index}`),
          })),
          recommendations: snapshot.recommendations.map((item, index) => ({
            ...item,
            summary: data.get(`recommendation-${index}`),
            priority: data.get(`recommendation-priority-${index}`),
            nextAction: data.get(`recommendation-action-${index}`),
          })),
          nextMonthPlan: data.get("nextMonthPlan"),
          closingMessage: data.get("closingMessage"),
        }),
      });
      await finalize(reviewing.report, email);
      setReviewing(null);
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Could not save report revision.", "レポートの改訂版を保存できませんでした。"));
    } finally {
      setSaving(false);
    }
  }

  async function finalize(report: Report, email: string) {
    try {
      const result = await api<{ shareUrl: string }>(`/api/reports/${report.id}/finalize`, {
        method: "POST",
        body: JSON.stringify({ recipientEmail: email || undefined }),
      });
      await navigator.clipboard.writeText(result.shareUrl).catch(() => undefined);
      window.alert(`${tr(locale, "Report finalized. The private URL is copied:", "レポートを確定し、限定公開URLをコピーしました。")}\n${result.shareUrl}`);
      load();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Could not finalize report.", "レポートを確定できませんでした。"));
      throw caught;
    }
  }

  async function correct(report: Report) {
    const confirmed = window.confirm(tr(locale, "Revoke the current share link and create a new draft Revision? The finalized snapshot remains in history.", "現在の共有リンクを失効し、新しい下書きを作成しますか？確定済みの版は履歴に残ります。"));
    if (!confirmed) return;
    try {
      await api(`/api/reports/${report.id}/revoke`, { method: "POST" });
      await api("/api/reports/draft", {
        method: "POST",
        body: JSON.stringify({
          clientId: report.clientId,
          periodStart: report.periodStart.slice(0, 10),
          periodEnd: report.periodEnd.slice(0, 10),
          locale: report.locale ?? "en",
        }),
      });
      load();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Could not create a correction revision.", "修正版の下書きを作成できませんでした。"));
    }
  }

  async function repairPdf(report: Report) {
    setRepairingPdf(report.id);
    try {
      await api(`/api/reports/${report.id}/pdf`, { method: "POST" });
      load();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Could not generate the report PDF.", "レポートPDFを生成できませんでした。"));
    } finally {
      setRepairingPdf("");
    }
  }

  const reviewingRecipientEmail = reviewing
    ? clients.find((client) => client.id === reviewing.report.clientId)?.contactEmail ?? ""
    : "";

  return (
    <>
      <PageHeader kicker={tr(locale, "CLIENT-VISIBLE VALUE", "お客様に伝わる保守価値")} title={tr(locale, "Reports", "レポート")}>
        <button className="button button-small" disabled={!clients.length} onClick={() => setOpen(true)}><Icon name="plus" /> {tr(locale, "Create report", "レポート作成")}</button>
      </PageHeader>
      <div className="page-lead"><p>{tr(locale, "Draft from evidence, review every word, then share privately.", "記録から下書きを作り、文章を確認してから限定公開します。")}</p><span>{tr(locale, `${reports.length} total`, `${reports.length}件`)}</span></div>
      <section className="panel full-panel">
        {reports.length ? (
          <div className="report-list">
            {reports.map((report) => (
              <article key={report.id}>
                <span className="report-doc"><Icon name="report" /></span>
                <div><h3>{report.clientName}</h3><p>{report.periodLabel} · {tr(locale, "Revision", "版")} {report.latestRevisionNumber} · {report.locale === "ja" ? "日本語" : "English"}</p></div>
                <span className={`report-status ${report.status}`}>{tr(locale, report.status, report.status === "draft" ? "下書き" : "確定済み")}</span>
                {report.status === "draft" ? <button className="button button-small" onClick={() => review(report)}>{tr(locale, "Review & finalize", "確認して確定")}</button> : (
                  <div className="report-final-actions">
                    <span className="view-status">{report.firstViewedAt ? tr(locale, "Viewed", "閲覧済み") : tr(locale, "Not viewed yet", "未閲覧")}</span>
                    <span className="view-status">{report.pdfAvailable ? tr(locale, "PDF ready", "PDF準備済み") : tr(locale, "PDF unavailable", "PDF未生成")}</span>
                    {!report.pdfAvailable && (
                      <button className="text-button" onClick={() => repairPdf(report)} disabled={repairingPdf === report.id}>
                        {repairingPdf === report.id ? tr(locale, "Generating…", "生成中…") : tr(locale, "Generate PDF", "PDF生成")}
                      </button>
                    )}
                    <button className="text-button" onClick={() => correct(report)}>{tr(locale, "Correct", "修正")}</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState icon="report" title={tr(locale, "No reports yet", "レポートはまだありません")} text={tr(locale, "Once you have activity, build a monthly draft and see the story come together.", "作業を記録したら月次レポートの下書きを作成できます。")}>
            {clients.length ? <button className="button button-small" onClick={() => setOpen(true)}>{tr(locale, "Create report", "レポート作成")}</button> : <Link className="button button-small" to="/app/clients">{tr(locale, "Add a client", "クライアントを追加")}</Link>}
          </EmptyState>
        )}
      </section>
      {open && (
        <Modal title={tr(locale, "Create monthly report", "月次レポートを作成")} onClose={() => setOpen(false)}>
          <form className="stack-form" onSubmit={create}>
            <label>{tr(locale, "Client", "クライアント")}<select name="clientId" value={draftClientId} onChange={(event) => {
              const clientId = event.target.value;
              setDraftClientId(clientId);
              setDraftLocale(clients.find((client) => client.id === clientId)?.reportLocale ?? "en");
            }}>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label>
            <label>{tr(locale, "Report language", "レポート言語")}<select name="locale" value={draftLocale} onChange={(event) => setDraftLocale(event.target.value as Locale)}><option value="en">English</option><option value="ja">日本語</option></select></label>
            <div className="form-row"><label>{tr(locale, "Period starts", "開始日")}<input name="periodStart" type="date" required defaultValue={defaultDates.start} /></label><label>{tr(locale, "Period ends", "終了日")}<input name="periodEnd" type="date" required defaultValue={defaultDates.end} /></label></div>
            <div className="info-box"><Icon name="lock" /><p>{tr(locale, `${brand.name} will use only client-visible activities, recommendations, and scheduled check results from this period. You review before anything is shared.`, `${brand.name}は、この期間のお客様向け作業、ご提案、定期確認結果だけを使用します。共有前に必ず内容を確認できます。`)}</p></div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setOpen(false)}>{tr(locale, "Cancel", "キャンセル")}</button><button className="button">{tr(locale, "Build draft", "下書きを作成")} <Icon name="arrow" /></button></div>
          </form>
        </Modal>
      )}
      {reviewing && (
        <Modal title={`${reviewing.report.clientName} — ${tr(locale, "review report", "レポート確認")}`} onClose={() => !saving && setReviewing(null)}>
          <form className="stack-form report-review-form" onSubmit={saveAndFinalize}>
            <div className="info-box"><Icon name="lock" /><p>{tr(locale, "Nothing is shared until you finalize. Saving this review creates a new immutable Revision; older revisions are retained.", "確定するまで共有されません。確認内容を保存すると変更不可の新しい版が作成され、以前の版も保持されます。")}</p></div>
            <div className="report-language-badge">{reviewing.snapshot.locale === "ja" ? "日本語レポート" : "English report"}</div>
            <label>{tr(locale, "Executive summary", "概要")}<textarea name="executiveSummary" required rows={4} defaultValue={reviewing.snapshot.executiveSummary} /></label>
            <div className="review-health"><span className={reviewing.snapshot.currentHealth.status === "Healthy" ? "status-good" : "status-muted"}>{reviewing.snapshot.locale === "ja" ? (reviewing.snapshot.currentHealth.status === "Healthy" ? "良好" : reviewing.snapshot.currentHealth.status === "No checks" ? "確認記録なし" : "要確認") : reviewing.snapshot.currentHealth.status}</span><b>{reviewing.snapshot.locale === "ja" ? `${reviewing.snapshot.currentHealth.total}回中${reviewing.snapshot.currentHealth.passed}回の定期確認に成功` : `${reviewing.snapshot.currentHealth.passed} of ${reviewing.snapshot.currentHealth.total} scheduled checks passed`}</b><small>{reviewing.snapshot.currentHealth.averageResponseMs ? tr(locale, `${reviewing.snapshot.currentHealth.averageResponseMs} ms average response`, `平均応答 ${reviewing.snapshot.currentHealth.averageResponseMs} ms`) : tr(locale, "No response-time evidence", "応答時間の記録なし")}</small></div>
            <fieldset className="review-group">
              <legend>{tr(locale, "Work completed", "完了した作業")}</legend>
              {reviewing.snapshot.workCompleted.length ? reviewing.snapshot.workCompleted.map((item, index) => (
                <label key={`${item.occurredAt}-${index}`}><span>{item.category} · {new Date(item.occurredAt).toLocaleDateString()}</span><input name={`work-${index}`} required defaultValue={item.summary} /></label>
              )) : <p>{tr(locale, "No client-visible work was recorded.", "お客様向けの作業記録はありません。")}</p>}
            </fieldset>
            <fieldset className="review-group">
              <legend>{tr(locale, "Outcomes and verification", "成果と確認")}</legend>
              {reviewing.snapshot.problemsPrevented.length ? reviewing.snapshot.problemsPrevented.map((item, index) => (
                <label key={`${item.occurredAt}-${index}`}><span>{outcomeName(item.outcomeType ?? "routine_verification", reviewing.snapshot.locale ?? "en")}</span><input name={`problem-${index}`} required defaultValue={item.summary} /></label>
              )) : <p>{tr(locale, "No separately classified outcomes were recorded.", "区分された成果・確認記録はありません。")}</p>}
            </fieldset>
            <fieldset className="review-group">
              <legend>{tr(locale, "Recommendations", "今後のご提案")}</legend>
              {reviewing.snapshot.recommendations.length ? reviewing.snapshot.recommendations.map((item, index) => (
                <div className="review-recommendation" key={`${item.occurredAt}-${index}`}>
                  <label>{tr(locale, "Recommendation", "提案内容")}<input name={`recommendation-${index}`} required defaultValue={item.summary} /></label>
                  <label>{tr(locale, "Priority", "優先度")}<select name={`recommendation-priority-${index}`} defaultValue={item.priority ?? "medium"}><option value="low">{priorityName("low", locale)}</option><option value="medium">{priorityName("medium", locale)}</option><option value="high">{priorityName("high", locale)}</option></select></label>
                  <label>{tr(locale, "Next action", "次のアクション")}<input name={`recommendation-action-${index}`} defaultValue={item.nextAction ?? ""} /></label>
                </div>
              )) : <p>{tr(locale, "No recommendations this month.", "今月のご提案はありません。")}</p>}
            </fieldset>
            <label>{tr(locale, "Next month plan", "翌月の予定")}<textarea name="nextMonthPlan" required rows={3} defaultValue={reviewing.snapshot.nextMonthPlan ?? tr(reviewing.snapshot.locale ?? "en", "Continue the configured care schedule and public-site observations next month.", "翌月も設定済みの保守予定と公開サイトの定期確認を継続します。")} /></label>
            <label>{tr(locale, "Closing message", "おわりのメッセージ")}<textarea name="closingMessage" required rows={3} defaultValue={reviewing.snapshot.closingMessage} /></label>
            <label>
              {tr(locale, "Send report link to", "レポート送信先")}
              <input
                name="recipientEmail"
                type="email"
                defaultValue={reviewingRecipientEmail}
                placeholder="client@example.com"
              />
              <small className="optional">{tr(locale, "Leave blank to finalize without sending an email.", "空欄の場合はメールを送らずに確定します。")}</small>
            </label>
            <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setReviewing(null)} disabled={saving}>{tr(locale, "Keep as draft", "下書きのまま戻る")}</button><button className="button" disabled={saving}>{saving ? tr(locale, "Finalizing…", "確定中…") : tr(locale, "Approve & finalize", "承認して確定")} <Icon name="check" /></button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function BillingPage({ me }: { me: SessionData | null }) {
  const locale = useUiLocale();
  const [loading, setLoading] = useState("");
  async function checkout(plan: "starter" | "freelancer", interval: "monthly" | "yearly") {
    setLoading(`${plan}-${interval}`);
    try {
      const result = await api<{ url: string }>("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan, interval }),
      });
      window.location.href = result.url;
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Checkout is unavailable.", "決済を利用できません。"));
      setLoading("");
    }
  }
  async function reserve() {
    setLoading("reservation");
    try {
      const result = await api<{ url: string }>("/api/billing/reservation", { method: "POST" });
      window.location.href = result.url;
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Reservation checkout is unavailable.", "予約決済を利用できません。"));
      setLoading("");
    }
  }
  async function cancelSubscription() {
    const confirmed = window.confirm(tr(locale, "Cancel the recurring subscription now? Access will stop and existing data will not be deleted immediately.", "継続課金を解約しますか？利用は停止しますが、既存データはすぐには削除されません。"));
    if (!confirmed) return;
    setLoading("cancel");
    try {
      await api("/api/billing/cancel", { method: "POST" });
      window.alert(tr(locale, "Subscription canceled. Contact support if you also want your account data deleted.", "サブスクリプションを解約しました。アカウントデータの削除も希望する場合はサポートへご連絡ください。"));
      window.location.reload();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Cancellation failed.", "解約できませんでした。"));
      setLoading("");
    }
  }
  async function requestDeletion() {
    const confirmed = window.confirm(tr(locale, "Schedule deletion of client records, reports, AI rewrites, and this login after 30 days? Cancel this request through support before the deadline.", "クライアント記録、レポート、AI変換、ログイン情報を30日後に削除しますか？期限前であればサポートから取り消せます。"));
    if (!confirmed) return;
    setLoading("deletion");
    try {
      const result = await api<{ deletionScheduledAt: string }>("/api/account/request-deletion", { method: "POST" });
      await authClient.signOut();
      window.alert(tr(locale, `Deletion is scheduled for ${new Date(result.deletionScheduledAt).toLocaleDateString()}.`, `削除予定日は${new Date(result.deletionScheduledAt).toLocaleDateString("ja-JP")}です。`));
      window.location.href = locale === "ja" ? "/ja" : "/";
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : tr(locale, "Deletion request failed.", "削除を予約できませんでした。"));
      setLoading("");
    }
  }
  return (
    <>
      <PageHeader kicker={tr(locale, "PLAN & BILLING", "プランとお支払い")} title={tr(locale, "A plan that pays for itself", "保守業務に無理なく組み込めるプラン")} />
      <div className="page-lead"><p>{tr(locale, `One retained maintenance client can cover ${brand.name} many times over.`, `保守顧客1社の契約で、${brand.name}の利用料を十分にまかなえます。`)}</p><span>{me?.subscription.status === "unpaid" ? tr(locale, "No active plan", "有効なプランなし") : tr(locale, `Current: ${me?.subscription.plan ?? "starter"}`, `現在：${me?.subscription.plan ?? "starter"}`)}</span></div>
      {me?.subscription.status === "unpaid" && (
        <section className="reservation-card">
          <div><span className="section-number">{tr(locale, "FOUNDING RESERVATION", "先行利用予約")}</span><h2>{tr(locale, "Reserve beta access for $5", "$5でベータ利用を予約")}</h2><p>{tr(locale, "Refundable before launch. At launch, the reservation becomes your first Starter month.", "正式提供開始前まで返金可能です。提供開始時にStarterの初月料金へ充当します。")}</p></div>
          <button className="button" disabled={!!loading} onClick={reserve}>{loading === "reservation" ? tr(locale, "Opening…", "移動中…") : tr(locale, "Reserve with Link", "Linkで予約")} <Icon name="arrow" /></button>
        </section>
      )}
      <div className="app-price-grid">
        {(["starter", "freelancer"] as const).map((plan) => (
          <article key={plan} className={me?.subscription.plan === plan && me?.subscription.status !== "unpaid" ? "current" : ""}>
            {me?.subscription.plan === plan && me?.subscription.status !== "unpaid" && <span className="current-label">{tr(locale, "CURRENT PLAN", "現在のプラン")}</span>}
            <h2>{plan === "starter" ? "Starter" : "Freelancer"}</h2>
            <div className="price"><sup>$</sup>{plan === "starter" ? 5 : 12}<small>{tr(locale, "/ month", "/ 月")}</small></div>
            <p>{tr(locale, `Up to ${plan === "starter" ? 3 : 15} active clients`, `最大${plan === "starter" ? 3 : 15}クライアント`)}</p>
            <button className="button" disabled={!!loading} onClick={() => checkout(plan, "monthly")}>{loading === `${plan}-monthly` ? tr(locale, "Opening…", "移動中…") : tr(locale, "Choose monthly", "月払いを選ぶ")}</button>
            <button className="button button-ghost" disabled={!!loading} onClick={() => checkout(plan, "yearly")}>{loading === `${plan}-yearly` ? tr(locale, "Opening…", "移動中…") : tr(locale, `Pay yearly — $${plan === "starter" ? 50 : 120}`, `年払い — $${plan === "starter" ? 50 : 120}`)}</button>
          </article>
        ))}
      </div>
      {me?.subscription.providerSubscriptionId && me.subscription.status !== "canceled" && (
        <div className="cancel-panel"><div><b>{tr(locale, "Cancel subscription", "サブスクリプション解約")}</b><p>{tr(locale, "This stops recurring billing. Data deletion is a separate request so an accidental cancellation does not erase client records.", "継続課金を停止します。誤操作で記録が消えないよう、データ削除は別の手続きです。")}</p></div><button className="text-button danger" disabled={!!loading} onClick={cancelSubscription}>{loading === "cancel" ? tr(locale, "Canceling…", "解約中…") : tr(locale, "Cancel recurring plan", "継続プランを解約")}</button></div>
      )}
      {me?.subscription.plan === "founding" && (
        <div className="cancel-panel"><div><b>{tr(locale, "Founding reservation", "先行利用予約")}</b><p>{tr(locale, `Your $5 reservation is applied automatically to the first recurring plan invoice. Reservations remain refundable before launch; email ${brand.supportEmail} from the purchasing address.`, `$5の予約金は最初の継続プラン請求へ自動適用されます。正式提供開始前は返金可能です。購入時のメールアドレスから${brand.supportEmail}へご連絡ください。`)}</p></div></div>
      )}
      <div className="cancel-panel"><div><b>{tr(locale, "Delete account data", "アカウントデータを削除")}</b><p>{tr(locale, "Schedules customer content and account data for deletion after 30 days. Legally required billing records are retained.", "お客様コンテンツとアカウントデータを30日後に削除します。法令上必要な請求記録は保持されます。")}</p></div><button className="text-button danger" disabled={!!loading} onClick={requestDeletion}>{loading === "deletion" ? tr(locale, "Scheduling…", "予約中…") : tr(locale, "Request deletion", "削除を予約")}</button></div>
    </>
  );
}

function PublicReportPage() {
  const { token } = useParams();
  const [report, setReport] = useState<PublicReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<PublicReport>(`/api/public/reports/${token}`)
      .then(setReport)
      .catch((caught) => setError(caught instanceof ApiError && caught.status === 404 ? "This report link is invalid or has expired." : "The report could not be loaded."));
  }, [token]);
  if (error) return <div className="public-error"><Logo dark /><h1>Report unavailable</h1><p>{error}</p></div>;
  if (!report) return <div className="loading-screen"><span /></div>;
  return <div className="public-page"><PublicReportView report={report} /></div>;
}

function PublicReportView({ report, sample = false }: { report: PublicReport; sample?: boolean }) {
  const navigate = useNavigate();
  const locale = report.locale ?? "en";
  const healthState =
    report.snapshot.currentHealth.scheduled === 0
      ? tr(locale, "No checks", "確認記録なし")
      : report.snapshot.currentHealth.failed === 0
        ? tr(locale, "Healthy", "良好")
        : tr(locale, "Needs attention", "要確認");
  const healthTone =
    report.snapshot.currentHealth.scheduled === 0
      ? "neutral"
      : report.snapshot.currentHealth.failed === 0
        ? "healthy"
        : "attention";
  const careItems = report.snapshot.workCompleted.length;
  const generatedDate = new Date(report.generatedAt);
  const dateLocale = locale === "ja" ? "ja-JP" : "en-US";
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <>
      <header className="public-header">
        <Logo dark home={sample && locale === "ja" ? "/ja" : "/"} />
        <div>
          {sample && <LanguageSwitch locale={locale} compact onChange={(next) => navigate(next === "ja" ? "/ja/sample" : "/sample")} />}
          {sample && <span className="sample-label">{tr(locale, "SAMPLE REPORT", "サンプルレポート")}</span>}
          {report.pdfUrl && <a className="button button-small button-dark" href={report.pdfUrl}>{tr(locale, "Download PDF", "PDFをダウンロード")}</a>}
          {!report.pdfUrl && sample && <Link className="button button-small button-dark" to={locale === "ja" ? "/ja/pricing" : "/pricing"}>{tr(locale, "Create reports like this", "このようなレポートを作る")}</Link>}
        </div>
      </header>
      <main className={`public-report ${locale === "ja" ? "report-ja" : ""}`}>
        <section className="report-cover">
          <div className="report-cover-orbit" aria-hidden="true" />
          <div className="report-cover-top">
            <span>{tr(locale, "WEBSITE CARE / MONTHLY RECORD", "WEBサイト保守 / 月次レポート")}</span>
            <span className="report-cover-edition">
              {generatedDate.toLocaleDateString(dateLocale, { month: "2-digit", year: "numeric" }).replace("/", " / ")}
            </span>
          </div>
          <div className="report-cover-copy">
            <p>{tr(locale, "Prepared exclusively for", "ご報告先")}</p>
            <h1>{report.clientName}</h1>
            <span className="report-period">{report.periodLabel}</span>
          </div>
          <div className="report-cover-proof">
            <span className={`report-status-mark ${healthTone}`}><Icon name="check" /></span>
            <div>
              <small>{tr(locale, "CARE STATUS", "保守状況")}</small>
              <b>{healthState}</b>
            </div>
            <p>{tr(locale, "Based on recorded maintenance and scheduled public-site observations.", "記録された保守作業と、定期的な公開サイト確認に基づくレポートです。")}</p>
          </div>
        </section>

        <section className="report-introduction">
          <div className="report-section-heading">
            <span>01</span>
            <div><small>{tr(locale, "EXECUTIVE SUMMARY", "概要")}</small><p>{tr(locale, "The month at a glance", "今月のまとめ")}</p></div>
          </div>
          <div className="report-summary-copy">
            <span className="report-quote-mark" aria-hidden="true">“</span>
            <h2>{report.snapshot.executiveSummary}</h2>
          </div>
        </section>

        <section className="report-evidence">
          <div className="report-section-heading light">
            <span>02</span>
            <div><small>{tr(locale, "CURRENT HEALTH", "現在の状態")}</small><p>{tr(locale, "Evidence, not estimates", "推定ではなく確認結果")}</p></div>
          </div>
          <div className="report-metrics">
            <article className="report-metric-primary">
              <span className={`report-status-mark ${healthTone}`}><Icon name="check" /></span>
              <small>{tr(locale, "OBSERVED STATUS", "確認時の状態")}</small>
              <strong>{healthState}</strong>
              <h3 className="report-observation">{report.snapshot.currentHealth.message}</h3>
            </article>
            <article>
              <small>{tr(locale, "CHECKS PASSED", "確認成功数")}</small>
              <strong>{report.snapshot.currentHealth.passed}<span> / {report.snapshot.currentHealth.scheduled}</span></strong>
              <p>{tr(locale, "Scheduled public checks", "定期公開サイト確認")}</p>
            </article>
            <article>
              <small>{tr(locale, "CARE COMPLETED", "完了した保守")}</small>
              <strong>{careItems}<span> {tr(locale, careItems === 1 ? "item" : "items", "件")}</span></strong>
              <p>{tr(locale, "Client-visible work recorded", "お客様向けに記録された作業")}</p>
            </article>
          </div>
          <p className="report-evidence-note">
            {tr(locale, "RetainerProof reports scheduled observations only. It does not estimate uptime or make guarantees about availability.", "RetainerProofは定期確認の観測結果のみを掲載します。稼働率の推定や可用性の保証を行うものではありません。")}
          </p>
          {report.snapshot.currentHealth.targets.length > 0 && (
            <div className="report-table-wrap">
              <table className="report-data-table">
                <thead><tr><th>{tr(locale, "Target", "確認対象")}</th><th>{tr(locale, "Checks passed", "確認成功数")}</th><th>{tr(locale, "Average response", "平均応答")}</th><th>{tr(locale, "SSL certificate", "SSL証明書")}</th></tr></thead>
                <tbody>{report.snapshot.currentHealth.targets.map((target) => (
                  <tr key={target.target}>
                    <td>{target.target}</td>
                    <td>{target.passed} / {target.total}</td>
                    <td>{target.averageResponseMs === null ? "—" : `${target.averageResponseMs} ms`}</td>
                    <td>{target.tlsExpiresAt ? new Date(target.tlsExpiresAt).toLocaleDateString(dateLocale) : tr(locale, "Valid when checked; expiry unavailable", "確認時は有効・期限未取得")}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {report.snapshot.maintenanceCoverage.length > 0 && (
            <div className="report-table-wrap coverage">
              <h3>{tr(locale, "Maintenance coverage", "保守範囲の実施記録")}</h3>
              <table className="report-data-table">
                <thead><tr><th>{tr(locale, "Care item", "保守項目")}</th><th>{tr(locale, "Frequency", "頻度")}</th><th>{tr(locale, "Records", "記録数")}</th><th>{tr(locale, "Status", "状態")}</th></tr></thead>
                <tbody>{report.snapshot.maintenanceCoverage.map((item) => (
                  <tr key={`${item.name}-${item.frequency}`}>
                    <td>{item.name}</td>
                    <td>{frequencyName(item.frequency, locale)}</td>
                    <td>{item.completedCount}</td>
                    <td><span className={`coverage-pill ${item.status}`}>{item.status === "completed" ? tr(locale, "Recorded", "実施記録あり") : item.status === "as_needed" ? tr(locale, "As needed", "必要時") : tr(locale, "No activity recorded", "記録なし")}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>

        <section className="report-work">
          <div className="report-section-heading">
            <span>03</span>
            <div><small>{tr(locale, "WORK COMPLETED", "完了した作業")}</small><p>{tr(locale, "The care behind the result", "結果を支える保守内容")}</p></div>
          </div>
          <div className="public-work-list">
            {report.snapshot.workCompleted.length ? report.snapshot.workCompleted.map((work, index) => (
              <article key={`${work.date}-${index}`}>
                <span className="work-index">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <b>{work.category} · {outcomeName(work.outcomeType, locale)}</b>
                  <h3>{work.description}</h3>
                  {work.target && <p className="report-work-detail"><strong>{tr(locale, "Target", "対象")}:</strong> {work.target}</p>}
                  {work.resultSummary && <p className="report-work-detail"><strong>{tr(locale, "Result", "結果")}:</strong> {work.resultSummary}</p>}
                  {work.verificationMethod && <p className="report-work-detail"><strong>{tr(locale, "Verified by", "確認方法")}:</strong> {work.verificationMethod}</p>}
                  {work.clientValue && <p className="report-work-detail"><strong>{tr(locale, "Client value", "お客様への価値")}:</strong> {work.clientValue}</p>}
                </div>
                <time>{new Date(work.date).toLocaleDateString(dateLocale, { month: "short", day: "numeric" })}</time>
              </article>
            )) : (
              <div className="report-empty"><span>—</span><p>{tr(locale, "No client-visible maintenance activities were recorded in this period.", "この期間にお客様向けの保守作業記録はありません。")}</p></div>
            )}
          </div>
        </section>

        <section className="report-insights">
          <article>
            <div className="insight-heading">
              <span>04</span>
              <div><small>{tr(locale, "OUTCOMES & VERIFICATION", "成果と確認")}</small><p>{tr(locale, "What changed and how it was checked", "何が変わり、どう確認したか")}</p></div>
            </div>
            <ul>
              {report.snapshot.problemsPrevented.length
                ? report.snapshot.problemsPrevented.map((item, index) => <li key={`${item.summary}-${index}`}><span><Icon name="check" /></span><p><b>{outcomeName(item.outcomeType, locale)}</b><br />{item.summary}</p></li>)
                : <li className="empty-insight"><p>{tr(locale, "No separately classified outcomes were recorded.", "区分された成果・確認記録はありません。")}</p></li>}
            </ul>
          </article>
          <article className="recommendations-card">
            <div className="insight-heading">
              <span>05</span>
              <div><small>{tr(locale, "RECOMMENDATIONS", "今後のご提案")}</small><p>{tr(locale, "What comes next", "次にできること")}</p></div>
            </div>
            <ul>
              {report.snapshot.recommendations.length
                ? report.snapshot.recommendations.map((item, index) => <li key={`${item.summary}-${index}`}><span><Icon name="arrow" /></span><p><b>{tr(locale, "Priority", "優先度")}: {priorityName(item.priority, locale)}</b><br />{item.summary}{item.nextAction && <><br /><em>{tr(locale, "Next action", "次のアクション")}: {item.nextAction}</em></>}</p></li>)
                : <li className="empty-insight"><p>{tr(locale, "No recommendations this month.", "今月のご提案はありません。")}</p></li>}
            </ul>
          </article>
        </section>

        <section className="report-next-month">
          <small>{tr(locale, "NEXT MONTH", "翌月の予定")}</small>
          <h2>{report.snapshot.nextMonthPlan}</h2>
        </section>

        <section className="report-closing">
          <span className="report-closing-mark" aria-hidden="true">RP</span>
          <small>{tr(locale, "CLOSING NOTE", "おわりに")}</small>
          <h2>{report.snapshot.closingMessage}</h2>
          <div className="report-closing-rule"><span /></div>
        </section>
        <footer className="report-footer">
          <div><Logo dark /><p>{tr(locale, "Client-visible website care, presented clearly.", "Webサイト保守の価値を、わかりやすく。")}</p></div>
          <div className="report-footer-meta">
            <span>{tr(locale, "Prepared with", "作成")} {report.appName}</span>
            <small>{tr(locale, "Generated", "作成日")} {generatedDate.toLocaleDateString(dateLocale, { month: "long", day: "numeric", year: "numeric" })}</small>
          </div>
        </footer>
      </main>
    </>
  );
}

function MarketingFooter({ locale = "en" }: { locale?: Locale }) {
  const prefix = locale === "ja" ? "/ja" : "";
  return (
    <footer className="marketing-footer">
      <Logo home={prefix || "/"} />
      <p>{tr(locale, brand.message, "見えない保守作業を、お客様に伝わる価値へ。")}</p>
      <div><Link to={`${prefix}/sample`}>{tr(locale, "Sample", "サンプル")}</Link><Link to={`${prefix}/pricing`}>{tr(locale, "Pricing", "料金")}</Link><Link to="/terms">{tr(locale, "Terms", "利用規約")}</Link><Link to="/privacy">{tr(locale, "Privacy", "プライバシー")}</Link></div>
      <small>© 2026 {brand.name}.</small>
    </footer>
  );
}

const legalCopy = {
  terms: {
    label: "TERMS OF SERVICE",
    title: "Clear terms for a small, useful service.",
    updated: "Draft updated July 24, 2026",
    sections: [
      ["The service", `${brand.name} helps website care professionals record maintenance activity, observe public website availability, and prepare reports. Monitoring is periodic evidence, not a guarantee of availability, security, backup integrity, or error-free operation.`],
      ["Your responsibility", "You must have authority to monitor the public URLs you add. You review and approve every report before sharing it. Do not enter passwords, credentials, sensitive personal data, or confidential client material."],
      ["Billing", "Subscriptions renew until canceled. Link is shown as the seller of record and Stripe Managed Payments handles supported payment, tax, dispute, and transaction-support obligations. Product questions remain our responsibility."],
      ["Availability and liability", "The service is provided on an as-available basis. To the extent permitted by law, liability is limited to fees paid for the service during the three months before the event giving rise to the claim."],
      ["Contact", `Questions about these terms: ${brand.supportEmail}. This is a pre-launch draft and must be reviewed for the operating entity and launch jurisdictions before accepting payments.`],
    ],
  },
  privacy: {
    label: "PRIVACY POLICY",
    title: "Collect less. Explain what moves.",
    updated: "Draft updated July 24, 2026",
    sections: [
      ["Data we process", "We process account email, workspace and client labels, public website URLs, maintenance records, monitoring observations, report content, delivery status, and billing identifiers. We do not need website administrator credentials."],
      ["AI rewriting", "AI is used only when you press Rewrite for client. We send the selected work description and minimal category context to Cloudflare Workers AI. We do not send internal notes, credentials, client email addresses, or unrelated account data. You approve the result before saving."],
      ["Sharing and measurement", "Client reports use revocable, unguessable links. We record the first report view without a tracking pixel. Payment information is handled by Stripe and Link; we retain billing identifiers and event status rather than full card details."],
      ["Retention and deletion", "After account closure, customer content is scheduled for deletion within 30 days except records required for billing, fraud prevention, disputes, or law. Backups and exports expire on their own operational schedule."],
      ["Contact", `Request access, correction, export, or deletion at ${brand.supportEmail}. This policy must be completed with the legal entity, subprocessors, international transfer terms, and jurisdiction-specific disclosures before launch.`],
    ],
  },
  refunds: {
    label: "REFUND POLICY",
    title: "A low-friction founding offer.",
    updated: "Draft updated July 24, 2026",
    sections: [
      ["Founding reservation", "The $5 founding reservation is refundable until general availability. At launch it is credited to the first month of the Starter plan unless you request a refund instead."],
      ["Subscriptions", "Cancel future renewal at any time. Unless required by law, partially used subscription periods are not prorated. If the service is materially unavailable or a duplicate charge occurs, contact us and we will review a refund promptly."],
      ["How to ask", `Email ${brand.supportEmail} from the purchasing address with the transaction date. Product-support inquiries relayed by Stripe are handled within 48 hours.`],
    ],
  },
} as const;

function LegalPage({ kind }: { kind: keyof typeof legalCopy }) {
  const copy = legalCopy[kind];
  return (
    <div className="marketing">
      <MarketingHeader />
      <main className="legal-page">
        <span className="section-number">{copy.label}</span>
        <h1>{copy.title}</h1>
        <p className="legal-updated">{copy.updated}</p>
        <div className="legal-sections">
          {copy.sections.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}

export function App() {
  const location = useLocation();
  useEffect(() => {
    if (!location.pathname.startsWith("/r/") && !location.pathname.startsWith("/app")) {
      document.documentElement.lang = location.pathname.startsWith("/ja") ? "ja" : "en";
    }
  }, [location.pathname]);
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/sample" element={<SampleReport />} />
      <Route path="/login" element={<Login />} />
      <Route path="/ja" element={<Landing locale="ja" />} />
      <Route path="/ja/pricing" element={<Pricing locale="ja" />} />
      <Route path="/ja/sample" element={<SampleReport locale="ja" />} />
      <Route path="/ja/login" element={<Login locale="ja" />} />
      <Route path="/terms" element={<LegalPage kind="terms" />} />
      <Route path="/privacy" element={<LegalPage kind="privacy" />} />
      <Route path="/refunds" element={<LegalPage kind="refunds" />} />
      <Route path="/r/:token" element={<PublicReportPage />} />
      <Route path="/app/*" element={<RequireAuth><AppShell /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
