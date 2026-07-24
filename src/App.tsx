import {
  FormEvent,
  ReactNode,
  useCallback,
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
import { brand } from "./config";

type Client = {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  createdAt: string;
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
  internalNote: string | null;
  clientDescription: string | null;
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
};

type EditableReportSnapshot = {
  executiveSummary: string;
  currentHealth: {
    passed: number;
    total: number;
    averageResponseMs: number | null;
    status: string;
  };
  workCompleted: Array<{ category: string; summary: string; occurredAt: string }>;
  problemsPrevented: Array<{ summary: string; occurredAt: string }>;
  recommendations: Array<{ summary: string; occurredAt: string }>;
  closingMessage: string;
};

type SessionData = {
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string };
  subscription: {
    plan: "founding" | "starter" | "freelancer";
    status: string;
    clientLimit: number;
    providerSubscriptionId?: string | null;
  };
};

type PublicReport = {
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
    };
    workCompleted: Array<{ category: string; description: string; date: string }>;
    problemsPrevented: string[];
    recommendations: string[];
    closingMessage: string;
  };
};

const categories = [
  ["updates", "Updates"],
  ["backups", "Backups"],
  ["security", "Security"],
  ["fixes", "Fixes"],
  ["content", "Content"],
  ["performance", "Performance"],
  ["forms", "Forms"],
  ["support", "Support"],
] as const;

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

function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <Link className={`logo ${dark ? "logo-dark" : ""}`} to="/">
      <span className="logo-mark">
        <span />
        <span />
        <span />
      </span>
      <span>{brand.name}</span>
    </Link>
  );
}

function MarketingHeader() {
  return (
    <header className="marketing-header">
      <Logo />
      <nav aria-label="Main navigation">
        <Link to="/#how">How it works</Link>
        <Link to="/sample">Sample report</Link>
        <Link to="/pricing">Pricing</Link>
      </nav>
      <div className="header-actions">
        <Link className="text-link" to="/login">
          Log in
        </Link>
        <Link className="button button-small" to="/login">
          Start for $5 <Icon name="arrow" />
        </Link>
      </div>
    </header>
  );
}

function Landing() {
  return (
    <div className="marketing">
      <MarketingHeader />
      <main>
        <section className="hero">
          <div className="eyebrow">
            <span className="live-dot" />
            Built for independent web care professionals
          </div>
          <h1>
            Make invisible maintenance
            <br />
            <em>visible to clients.</em>
          </h1>
          <p>
            Log your work in seconds. {brand.name} watches every client site and
            turns the month into a polished, client-ready report.
          </p>
          <div className="hero-actions">
            <Link className="button" to="/login">
              Become a founding customer <Icon name="arrow" />
            </Link>
            <Link className="button button-ghost" to="/sample">
              View a sample report
            </Link>
          </div>
          <div className="trust-line">
            <span>
              <Icon name="check" /> No client login
            </span>
            <span>
              <Icon name="check" /> Works with any website
            </span>
            <span>
              <Icon name="check" /> Cancel anytime
            </span>
          </div>
        </section>

        <section className="report-stage" aria-label="Product preview">
          <div className="float-note float-note-left">
            <span className="note-icon"><Icon name="pulse" /></span>
            <div><b>30 of 30</b><small>scheduled checks passed</small></div>
          </div>
          <div className="report-paper">
            <div className="paper-head">
              <Logo dark />
              <span>MONTHLY CARE REPORT</span>
            </div>
            <div className="paper-client">
              <small>PREPARED FOR</small>
              <h3>North &amp; Pine Studio</h3>
              <p>June 1–30, 2026</p>
            </div>
            <div className="paper-summary">
              <small>EXECUTIVE SUMMARY</small>
              <h4>Your website stayed healthy, secure, and up to date.</h4>
              <p>
                This month we completed routine maintenance, resolved two
                content issues, and verified every scheduled availability check.
              </p>
            </div>
            <div className="paper-grid">
              <div>
                <span className="metric green">100%</span>
                <small>SCHEDULED CHECKS</small>
              </div>
              <div>
                <span className="metric">7</span>
                <small>CARE ACTIVITIES</small>
              </div>
              <div>
                <span className="metric">184ms</span>
                <small>MEDIAN RESPONSE</small>
              </div>
            </div>
            <div className="paper-work">
              <small>WORK COMPLETED</small>
              {[
                ["Security", "Applied security updates and verified the site"],
                ["Performance", "Optimized large homepage images"],
                ["Content", "Updated the summer services page"],
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
            <div><b>Report ready</b><small>Review and share in one click</small></div>
          </div>
        </section>

        <section className="problem-section">
          <div>
            <span className="section-number">01 — THE PROBLEM</span>
            <h2>Your best work is the work clients never notice.</h2>
          </div>
          <div>
            <p>
              Updates run smoothly. Problems get prevented. Sites stay online.
              That is exactly what good maintenance looks like—but it can leave
              clients wondering what they are paying for.
            </p>
            <p>
              {brand.name} gives the quiet work a clear, professional story every
              month.
            </p>
          </div>
        </section>

        <section className="how-section" id="how">
          <div className="section-heading">
            <span className="section-number">02 — HOW IT WORKS</span>
            <h2>From ten-second notes to a report clients understand.</h2>
          </div>
          <div className="step-grid">
            <article>
              <span className="step-no">1</span>
              <div className="step-icon"><Icon name="plus" /></div>
              <h3>Record the work</h3>
              <p>Pick a client and a care activity. Add context only when it helps.</p>
            </article>
            <article>
              <span className="step-no">2</span>
              <div className="step-icon"><Icon name="pulse" /></div>
              <h3>Let {brand.name} watch</h3>
              <p>Daily checks capture website reachability and response evidence.</p>
            </article>
            <article>
              <span className="step-no">3</span>
              <div className="step-icon"><Icon name="report" /></div>
              <h3>Review and share</h3>
              <p>Approve the monthly story, then send a private link or PDF.</p>
            </article>
          </div>
        </section>

        <section className="founder-cta">
          <span className="section-number">FOUNDING CUSTOMER OFFER</span>
          <h2>Start proving your value for $5.</h2>
          <p>
            Reserve early access. Your refundable $5 reservation becomes your
            first month when {brand.name} opens.
          </p>
          <Link className="button button-light" to="/pricing">
            See founding pricing <Icon name="arrow" />
          </Link>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}

function Pricing() {
  return (
    <div className="marketing">
      <MarketingHeader />
      <main className="pricing-page">
        <span className="section-number">SIMPLE, HONEST PRICING</span>
        <h1>Charge for care. Not report-writing hours.</h1>
        <p className="pricing-lead">
          All plans include activity logging, daily checks, client-ready
          reports, private sharing, PDF, and optional AI rewriting.
        </p>
        <div className="pricing-grid">
          <article className="price-card featured">
            <div className="popular">FOUNDING FAVORITE</div>
            <h2>Starter</h2>
            <p>For a focused care practice.</p>
            <div className="price"><sup>$</sup>5<small>/ month</small></div>
            <p className="annual">$50 billed yearly — two months free</p>
            <ul>
              <li><Icon name="check" /> Up to 3 clients</li>
              <li><Icon name="check" /> 1 website per client</li>
              <li><Icon name="check" /> 3 important URLs per site</li>
              <li><Icon name="check" /> Unlimited care activities</li>
              <li><Icon name="check" /> Share link and PDF reports</li>
            </ul>
            <Link className="button" to="/login">
              Reserve for $5 <Icon name="arrow" />
            </Link>
          </article>
          <article className="price-card">
            <h2>Freelancer</h2>
            <p>For a growing client roster.</p>
            <div className="price"><sup>$</sup>12<small>/ month</small></div>
            <p className="annual">$120 billed yearly — two months free</p>
            <ul>
              <li><Icon name="check" /> Up to 15 clients</li>
              <li><Icon name="check" /> Everything in Starter</li>
              <li><Icon name="check" /> Priority product feedback</li>
              <li><Icon name="check" /> Founding price for first 10</li>
            </ul>
            <Link className="button button-dark" to="/login">
              Choose Freelancer <Icon name="arrow" />
            </Link>
          </article>
        </div>
        <p className="payment-note">
          Payments are processed by Link as merchant of record through Stripe
          Managed Payments. Reservations are refundable before launch. No custom
          checkout domain is used.
        </p>
      </main>
      <MarketingFooter />
    </div>
  );
}

function SampleReport() {
  const sample: PublicReport = {
    appName: brand.name,
    clientName: "North & Pine Studio",
    periodLabel: "June 1–30, 2026",
    generatedAt: "2026-07-01T09:00:00Z",
    pdfUrl: null,
    snapshot: {
      executiveSummary:
        "Your website stayed healthy, secure, and up to date. This month we completed routine maintenance, resolved two content issues, and verified every scheduled availability check.",
      currentHealth: {
        scheduled: 30,
        passed: 30,
        failed: 0,
        message: "30 of 30 scheduled checks passed",
      },
      workCompleted: [
        { category: "Security", description: "Applied routine security updates and verified the public site.", date: "2026-06-04" },
        { category: "Performance", description: "Optimized large homepage images for faster delivery.", date: "2026-06-12" },
        { category: "Content", description: "Published the revised summer services page.", date: "2026-06-18" },
        { category: "Support", description: "Resolved an issue affecting the contact details in the footer.", date: "2026-06-25" },
      ],
      problemsPrevented: [
        "Verified updates on the public site before closing the maintenance task.",
        "Confirmed important pages remained reachable throughout the month.",
      ],
      recommendations: [
        "Review and refresh the portfolio photography next month.",
      ],
      closingMessage:
        "Your website is in good shape. We will continue monitoring it and taking care of routine maintenance next month.",
    },
  };
  return (
    <div className="public-page">
      <PublicReportView report={sample} sample />
    </div>
  );
}

function Login() {
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
      setError(result.error.message ?? "We could not send that link.");
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
        <Logo />
        <div>
          <span className="section-number">YOUR CARE, MADE VISIBLE</span>
          <h1>Clients keep trusting the work they can understand.</h1>
          <p>
            Record care in seconds, collect real monitoring evidence, and send
            a report worth renewing.
          </p>
        </div>
        <blockquote>
          “I finally have something useful to send at the end of every month.”
          <small>— Sample beta feedback</small>
        </blockquote>
      </div>
      <main className="login-panel">
        <div className="login-box">
          <Link className="back-link" to="/">← Back to {brand.name}</Link>
          {sent ? (
            <div className="sent-state">
              <span className="big-check"><Icon name="check" /></span>
              <h2>Check your inbox</h2>
              <p>
                We sent a secure sign-in link to <b>{email}</b>. It expires in
                15 minutes and works once.
              </p>
              <button className="text-button" onClick={() => setSent(false)}>
                Use a different email
              </button>
            </div>
          ) : (
            <>
              <span className="section-number">WELCOME</span>
              <h2>Sign in to your workspace</h2>
              <p>No password to remember. We will email you a secure link.</p>
              <form onSubmit={submit}>
                <label>
                  Work email
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
                  {loading ? "Sending…" : "Email me a sign-in link"}
                  {!loading && <Icon name="arrow" />}
                </button>
              </form>
              <small className="login-terms">
                By continuing, you agree to the Terms and acknowledge the
                Privacy Policy.
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

  async function signOut() {
    await authClient.signOut();
    void navigate("/");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <nav>
          <NavLink end to="/app"><Icon name="pulse" /> Overview</NavLink>
          <NavLink to="/app/clients"><Icon name="client" /> Clients</NavLink>
          <NavLink to="/app/activity"><Icon name="activity" /> Activity</NavLink>
          <NavLink to="/app/reports"><Icon name="report" /> Reports</NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="plan-pill">
            <span>{me?.subscription.plan ?? "Starter"}</span>
            <small>Up to {me?.subscription.clientLimit ?? 3} clients</small>
          </div>
          <button onClick={signOut}>
            <span className="avatar">{me?.user.name?.slice(0, 1) || "C"}</span>
            <span><b>{me?.user.name || "Care professional"}</b><small>{me?.user.email}</small></span>
          </button>
        </div>
      </aside>
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
  const month = now.toLocaleString("en", { month: "long" });
  const drafted = reports.filter((report) => report.status === "draft").length;
  return (
    <>
      <PageHeader
        kicker={`${month.toUpperCase()} CARE WORKSPACE`}
        title={`Good ${now.getHours() < 12 ? "morning" : "afternoon"}, ${me?.user.name?.split(" ")[0] || "there"}.`}
      >
        <Link className="button button-small" to="/app/activity">
          <Icon name="plus" /> Quick add
        </Link>
      </PageHeader>
      <section className="dashboard-intro">
        <div>
          <span className="live-dot" /> YOUR MONTH AT A GLANCE
          <h2>Your client care is taking shape.</h2>
          <p>Keep the record current now, and the report writes itself later.</p>
        </div>
        <div className="month-ring"><b>{activities.length}</b><small>recent<br />activities</small></div>
      </section>
      <section className="stat-grid">
        <article><span>ACTIVE CLIENTS</span><b>{clients.length}</b><small>of {me?.subscription.clientLimit ?? 3} plan slots</small></article>
        <article><span>DRAFT REPORTS</span><b>{drafted}</b><small>ready for your review</small></article>
        <article><span>REPORTS SENT</span><b>{reports.filter((r) => r.status === "finalized").length}</b><small>all time</small></article>
      </section>
      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-head"><h3>Recent care activity</h3><Link to="/app/activity">View all →</Link></div>
          {activities.length ? (
            <div className="activity-list compact">
              {activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}
            </div>
          ) : (
            <EmptyState icon="activity" title="No activity yet" text="Record your first care task. It takes about ten seconds.">
              <Link className="button button-small" to="/app/activity">Add activity</Link>
            </EmptyState>
          )}
        </article>
        <article className="panel">
          <div className="panel-head"><h3>Client coverage</h3><Link to="/app/clients">Manage →</Link></div>
          {clients.length ? (
            <div className="client-mini-list">
              {clients.slice(0, 5).map((client) => (
                <div key={client.id}>
                  <span className="client-initial">{client.name.slice(0, 2).toUpperCase()}</span>
                  <div><b>{client.name}</b><small>{client.asset?.url ?? "No website added"}</small></div>
                  <span className={client.asset ? "status-good" : "status-muted"}>{client.asset ? "Watching" : "Setup"}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon="client" title="Add your first client" text="Their website and care history will live here.">
              <Link className="button button-small" to="/app/clients">Add client</Link>
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
  const [clients, setClients] = useState<Client[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void api<{ clients: Client[] }>("/api/clients")
      .then((data) => setClients(data.clients))
      .catch(() => setError("Could not load clients."));
  }, []);
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
          assetName: "Main website",
          url: data.get("url"),
          criticalUrls,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      setOpen(false);
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save client.");
    }
  }

  return (
    <>
      <PageHeader kicker="YOUR CARE ROSTER" title="Clients">
        <button className="button button-small" onClick={() => setOpen(true)}><Icon name="plus" /> Add client</button>
      </PageHeader>
      <div className="page-lead"><p>One clear record for every website you protect.</p><span>{clients.length} active</span></div>
      {clients.length ? (
        <div className="client-card-grid">
          {clients.map((client) => (
            <article className="client-card" key={client.id}>
              <div className="client-card-top">
                <span className="client-initial large">{client.name.slice(0, 2).toUpperCase()}</span>
                <span className={client.asset ? "status-good" : "status-muted"}>{client.asset ? "Watching daily" : "Needs setup"}</span>
              </div>
              <h2>{client.name}</h2>
              <p>{client.contactName || "No contact name"} · {client.contactEmail || "No report email"}</p>
              {client.asset && (
                <a href={client.asset.url} target="_blank" rel="noreferrer">
                  {new URL(client.asset.url).hostname} <Icon name="external" />
                </a>
              )}
              <div className="client-card-foot">
                <Link to={`/app/activity?client=${client.id}`}>Add activity</Link>
                <Link to={`/app/reports?client=${client.id}`}>Create report</Link>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="large-empty">
          <EmptyState icon="client" title="Your first client is one minute away" text={`Add a name, email, and public website. ${brand.name} will prepare the daily check schedule.`}>
            <button className="button" onClick={() => setOpen(true)}>Add your first client <Icon name="arrow" /></button>
          </EmptyState>
        </div>
      )}
      {open && (
        <Modal title="Add a client" onClose={() => setOpen(false)}>
          <form className="stack-form" onSubmit={create}>
            <div className="form-row">
              <label>Client or business name<input name="name" required placeholder="North & Pine Studio" /></label>
              <label>Contact name<input name="contactName" placeholder="Avery Morgan" /></label>
            </div>
            <label>Report email<input name="contactEmail" type="email" placeholder="avery@example.com" /></label>
            <label>Public website URL<input name="url" type="url" required placeholder="https://example.com" /></label>
            <div className="field-help">Only public HTTP/HTTPS sites are accepted. Private networks, credentials, and unsafe redirects are blocked.</div>
            <details>
              <summary>Add important URLs (optional, up to 3)</summary>
              <label>Important URL 1<input name="critical1" type="url" placeholder="https://example.com/contact" /></label>
              <label>Important URL 2<input name="critical2" type="url" placeholder="https://example.com/services" /></label>
              <label>Important URL 3<input name="critical3" type="url" placeholder="https://example.com/shop" /></label>
            </details>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="button">Save client <Icon name="arrow" /></button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ActivityRow({ activity }: { activity: Activity }) {
  const category = categories.find(([value]) => value === activity.category)?.[1] ?? activity.category;
  return (
    <div className="activity-row">
      <span className={`category-dot ${activity.category}`} />
      <div><b>{activity.clientDescription || activity.internalNote || category}</b><small>{activity.clientName} · {new Date(activity.occurredAt).toLocaleDateString()}</small></div>
      <span className={`visibility ${activity.visibility}`}>{activity.visibility.replace("_", " ")}</span>
    </div>
  );
}

function ActivityPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [category, setCategory] = useState("updates");
  const [visibility, setVisibility] = useState("client_visible");
  const [description, setDescription] = useState("");
  const [aiRewriteId, setAiRewriteId] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const load = useCallback(() => {
    void Promise.all([
      api<{ clients: Client[] }>("/api/clients"),
      api<{ activities: Activity[] }>("/api/activities?limit=100"),
    ]).then(([c, a]) => { setClients(c.clients); setActivities(a.activities); })
      .catch(() => setError("Could not load care activity."));
  }, []);
  useEffect(load, [load]);

  async function rewrite() {
    if (!description.trim()) return;
    setRewriting(true);
    setError("");
    try {
      const result = await api<{ rewriteId: string; rewrittenText: string; category: string }>("/api/ai/rewrite", {
        method: "POST",
        body: JSON.stringify({ text: description, category }),
      });
      setDescription(result.rewrittenText);
      setCategory(result.category);
      setAiRewriteId(result.rewriteId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI rewrite was unavailable. Your original text is unchanged.");
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
          category,
          internalNote: data.get("internalNote") || undefined,
          clientDescription: description || undefined,
          aiRewriteId: aiRewriteId || undefined,
          visibility,
          occurredAt: new Date(`${data.get("date")}T12:00:00`).toISOString(),
        }),
      });
      setOpen(false);
      setDescription("");
      setAiRewriteId("");
      setCategory("updates");
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save activity.");
    }
  }

  return (
    <>
      <PageHeader kicker="THE WORK BEHIND THE WORK" title="Care activity">
        <button className="button button-small" disabled={!clients.length} onClick={() => setOpen(true)}><Icon name="plus" /> Quick add</button>
      </PageHeader>
      <div className="page-lead"><p>Short, factual notes now become a strong client story later.</p><span>{activities.length} recorded</span></div>
      <section className="panel full-panel">
        {activities.length ? <div className="activity-list">{activities.map((activity) => <ActivityRow activity={activity} key={activity.id} />)}</div> : (
          <EmptyState icon="activity" title={clients.length ? "Record your first care activity" : "Add a client first"} text={clients.length ? `Choose a common task and ${brand.name} will suggest client-ready language.` : "Activities always belong to a client, so start by creating one."}>
            <Link className="button button-small" to={clients.length ? "#" : "/app/clients"} onClick={() => clients.length && setOpen(true)}>{clients.length ? "Quick add" : "Add a client"}</Link>
          </EmptyState>
        )}
      </section>
      {open && (
        <Modal title="Quick add care activity" onClose={() => setOpen(false)}>
          <form className="stack-form" onSubmit={create}>
            <div className="form-row">
              <label>Client<select name="clientId" required>{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label>
              <label>Date<input name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label>
            </div>
            <fieldset className="category-picker">
              <legend>What kind of work?</legend>
              <div>{categories.map(([value, label]) => <button type="button" className={category === value ? "active" : ""} onClick={() => setCategory(value)} key={value}>{label}</button>)}</div>
            </fieldset>
            <label>Client-facing description<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Example: Updated the site software and checked the public pages." rows={3} /></label>
            <button type="button" className="rewrite-button" onClick={rewrite} disabled={rewriting || !description.trim()}>
              ✦ {rewriting ? "Rewriting…" : "Rewrite for client"} <small>Only this description is sent to AI</small>
            </button>
            <label>Internal note <span className="optional">never shown to the client</span><textarea name="internalNote" placeholder="Technical details, ticket number, credentials reminder…" rows={2} /></label>
            <fieldset className="visibility-picker">
              <legend>Where should this appear?</legend>
              {[
                ["client_visible", "Client-visible", "Work completed"],
                ["internal_only", "Internal only", "Private record"],
                ["recommendation", "Recommendation", "Next-step section"],
              ].map(([value, title, help]) => <label className={visibility === value ? "active" : ""} key={value}><input type="radio" checked={visibility === value} onChange={() => setVisibility(value)} /><span><b>{title}</b><small>{help}</small></span></label>)}
            </fieldset>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="button">Save activity <Icon name="check" /></button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ReportsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState<{ report: Report; snapshot: EditableReportSnapshot } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    void Promise.all([
      api<{ clients: Client[] }>("/api/clients"),
      api<{ reports: Report[] }>("/api/reports"),
    ]).then(([c, r]) => { setClients(c.clients); setReports(r.reports); })
      .catch(() => setError("Could not load reports."));
  }, []);
  useEffect(load, [load]);

  const defaultDates = useMemo(() => {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10),
      end: new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10),
    };
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/reports/draft", {
        method: "POST",
        body: JSON.stringify({ clientId: data.get("clientId"), periodStart: data.get("periodStart"), periodEnd: data.get("periodEnd") }),
      });
      setOpen(false);
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not build report.");
    }
  }

  async function review(report: Report) {
    try {
      const detail = await api<{ snapshot: EditableReportSnapshot }>(`/api/reports/${report.id}`);
      setReviewing({ report, snapshot: detail.snapshot });
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Could not open report.");
    }
  }

  async function saveAndFinalize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewing) return;
    const email = window.prompt("Send the private report link to:", "");
    if (email === null) return;
    setSaving(true);
    const data = new FormData(event.currentTarget);
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
          })),
          closingMessage: data.get("closingMessage"),
        }),
      });
      await finalize(reviewing.report, email);
      setReviewing(null);
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Could not save report revision.");
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
      window.alert(`Report finalized. The private URL is copied:\n${result.shareUrl}`);
      load();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Could not finalize report.");
      throw caught;
    }
  }

  async function correct(report: Report) {
    const confirmed = window.confirm("Revoke the current share link and create a new draft Revision? The finalized snapshot remains in history.");
    if (!confirmed) return;
    try {
      await api(`/api/reports/${report.id}/revoke`, { method: "POST" });
      await api("/api/reports/draft", {
        method: "POST",
        body: JSON.stringify({
          clientId: report.clientId,
          periodStart: report.periodStart.slice(0, 10),
          periodEnd: report.periodEnd.slice(0, 10),
        }),
      });
      load();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Could not create a correction revision.");
    }
  }

  return (
    <>
      <PageHeader kicker="CLIENT-VISIBLE VALUE" title="Reports">
        <button className="button button-small" disabled={!clients.length} onClick={() => setOpen(true)}><Icon name="plus" /> Create report</button>
      </PageHeader>
      <div className="page-lead"><p>Draft from evidence, review every word, then share privately.</p><span>{reports.length} total</span></div>
      <section className="panel full-panel">
        {reports.length ? (
          <div className="report-list">
            {reports.map((report) => (
              <article key={report.id}>
                <span className="report-doc"><Icon name="report" /></span>
                <div><h3>{report.clientName}</h3><p>{report.periodStart} — {report.periodEnd} · Revision {report.latestRevisionNumber}</p></div>
                <span className={`report-status ${report.status}`}>{report.status}</span>
                {report.status === "draft" ? <button className="button button-small" onClick={() => review(report)}>Review &amp; finalize</button> : <div className="report-final-actions"><span className="view-status">{report.firstViewedAt ? "Viewed" : "Not viewed yet"}</span><button className="text-button" onClick={() => correct(report)}>Correct</button></div>}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState icon="report" title="No reports yet" text="Once you have activity, build a monthly draft and see the story come together.">
            {clients.length ? <button className="button button-small" onClick={() => setOpen(true)}>Create report</button> : <Link className="button button-small" to="/app/clients">Add a client</Link>}
          </EmptyState>
        )}
      </section>
      {open && (
        <Modal title="Create monthly report" onClose={() => setOpen(false)}>
          <form className="stack-form" onSubmit={create}>
            <label>Client<select name="clientId">{clients.map((client) => <option value={client.id} key={client.id}>{client.name}</option>)}</select></label>
            <div className="form-row"><label>Period starts<input name="periodStart" type="date" required defaultValue={defaultDates.start} /></label><label>Period ends<input name="periodEnd" type="date" required defaultValue={defaultDates.end} /></label></div>
            <div className="info-box"><Icon name="lock" /><p>{brand.name} will use only client-visible activities, recommendations, and scheduled check results from this period. You review before anything is shared.</p></div>
            {error && <div className="form-error">{error}</div>}
            <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="button">Build draft <Icon name="arrow" /></button></div>
          </form>
        </Modal>
      )}
      {reviewing && (
        <Modal title={`${reviewing.report.clientName} — review report`} onClose={() => !saving && setReviewing(null)}>
          <form className="stack-form report-review-form" onSubmit={saveAndFinalize}>
            <div className="info-box"><Icon name="lock" /><p>Nothing is shared until you finalize. Saving this review creates a new immutable Revision; older revisions are retained.</p></div>
            <label>Executive summary<textarea name="executiveSummary" required rows={4} defaultValue={reviewing.snapshot.executiveSummary} /></label>
            <div className="review-health"><span className={reviewing.snapshot.currentHealth.status === "Healthy" ? "status-good" : "status-muted"}>{reviewing.snapshot.currentHealth.status}</span><b>{reviewing.snapshot.currentHealth.passed} of {reviewing.snapshot.currentHealth.total} scheduled checks passed</b><small>{reviewing.snapshot.currentHealth.averageResponseMs ? `${reviewing.snapshot.currentHealth.averageResponseMs} ms average response` : "No response-time evidence"}</small></div>
            <fieldset className="review-group">
              <legend>Work completed</legend>
              {reviewing.snapshot.workCompleted.length ? reviewing.snapshot.workCompleted.map((item, index) => (
                <label key={`${item.occurredAt}-${index}`}><span>{item.category} · {new Date(item.occurredAt).toLocaleDateString()}</span><input name={`work-${index}`} required defaultValue={item.summary} /></label>
              )) : <p>No client-visible work was recorded.</p>}
            </fieldset>
            <fieldset className="review-group">
              <legend>Problems prevented</legend>
              {reviewing.snapshot.problemsPrevented.length ? reviewing.snapshot.problemsPrevented.map((item, index) => (
                <label key={`${item.occurredAt}-${index}`}><input name={`problem-${index}`} required defaultValue={item.summary} /></label>
              )) : <p>No prevention items were recorded.</p>}
            </fieldset>
            <fieldset className="review-group">
              <legend>Recommendations</legend>
              {reviewing.snapshot.recommendations.length ? reviewing.snapshot.recommendations.map((item, index) => (
                <label key={`${item.occurredAt}-${index}`}><input name={`recommendation-${index}`} required defaultValue={item.summary} /></label>
              )) : <p>No recommendations this month.</p>}
            </fieldset>
            <label>Closing message<textarea name="closingMessage" required rows={3} defaultValue={reviewing.snapshot.closingMessage} /></label>
            <div className="modal-actions"><button type="button" className="button button-ghost" onClick={() => setReviewing(null)} disabled={saving}>Keep as draft</button><button className="button" disabled={saving}>{saving ? "Finalizing…" : "Approve & finalize"} <Icon name="check" /></button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function BillingPage({ me }: { me: SessionData | null }) {
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
      window.alert(caught instanceof Error ? caught.message : "Checkout is unavailable.");
      setLoading("");
    }
  }
  async function reserve() {
    setLoading("reservation");
    try {
      const result = await api<{ url: string }>("/api/billing/reservation", { method: "POST" });
      window.location.href = result.url;
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Reservation checkout is unavailable.");
      setLoading("");
    }
  }
  async function cancelSubscription() {
    const confirmed = window.confirm("Cancel the recurring subscription now? Access will stop and existing data will not be deleted immediately.");
    if (!confirmed) return;
    setLoading("cancel");
    try {
      await api("/api/billing/cancel", { method: "POST" });
      window.alert("Subscription canceled. Contact support if you also want your account data deleted.");
      window.location.reload();
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Cancellation failed.");
      setLoading("");
    }
  }
  async function requestDeletion() {
    const confirmed = window.confirm("Schedule deletion of client records, reports, AI rewrites, and this login after 30 days? Cancel this request through support before the deadline.");
    if (!confirmed) return;
    setLoading("deletion");
    try {
      const result = await api<{ deletionScheduledAt: string }>("/api/account/request-deletion", { method: "POST" });
      await authClient.signOut();
      window.alert(`Deletion is scheduled for ${new Date(result.deletionScheduledAt).toLocaleDateString()}.`);
      window.location.href = "/";
    } catch (caught) {
      window.alert(caught instanceof Error ? caught.message : "Deletion request failed.");
      setLoading("");
    }
  }
  return (
    <>
      <PageHeader kicker="PLAN & BILLING" title="A plan that pays for itself" />
      <div className="page-lead"><p>One retained maintenance client can cover {brand.name} many times over.</p><span>Current: {me?.subscription.plan ?? "starter"}</span></div>
      {me?.subscription.status === "unpaid" && (
        <section className="reservation-card">
          <div><span className="section-number">FOUNDING RESERVATION</span><h2>Reserve beta access for $5</h2><p>Refundable before launch. At launch, the reservation becomes your first Starter month.</p></div>
          <button className="button" disabled={!!loading} onClick={reserve}>{loading === "reservation" ? "Opening…" : "Reserve with Link"} <Icon name="arrow" /></button>
        </section>
      )}
      <div className="app-price-grid">
        {(["starter", "freelancer"] as const).map((plan) => (
          <article key={plan} className={me?.subscription.plan === plan ? "current" : ""}>
            {me?.subscription.plan === plan && <span className="current-label">CURRENT PLAN</span>}
            <h2>{plan === "starter" ? "Starter" : "Freelancer"}</h2>
            <div className="price"><sup>$</sup>{plan === "starter" ? 5 : 12}<small>/ month</small></div>
            <p>Up to {plan === "starter" ? 3 : 15} active clients</p>
            <button className="button" disabled={!!loading} onClick={() => checkout(plan, "monthly")}>{loading === `${plan}-monthly` ? "Opening…" : "Choose monthly"}</button>
            <button className="button button-ghost" disabled={!!loading} onClick={() => checkout(plan, "yearly")}>{loading === `${plan}-yearly` ? "Opening…" : `Pay yearly — $${plan === "starter" ? 50 : 120}`}</button>
          </article>
        ))}
      </div>
      {me?.subscription.providerSubscriptionId && me.subscription.status !== "canceled" && (
        <div className="cancel-panel"><div><b>Cancel subscription</b><p>This stops recurring billing. Data deletion is a separate request so an accidental cancellation does not erase client records.</p></div><button className="text-button danger" disabled={!!loading} onClick={cancelSubscription}>{loading === "cancel" ? "Canceling…" : "Cancel recurring plan"}</button></div>
      )}
      {me?.subscription.plan === "founding" && (
        <div className="cancel-panel"><div><b>Founding reservation refund</b><p>Reservations are refundable before launch. Email {brand.supportEmail} from the purchasing address.</p></div></div>
      )}
      <div className="cancel-panel"><div><b>Delete account data</b><p>Schedules customer content and account data for deletion after 30 days. Legally required billing records are retained.</p></div><button className="text-button danger" disabled={!!loading} onClick={requestDeletion}>{loading === "deletion" ? "Scheduling…" : "Request deletion"}</button></div>
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
  return (
    <>
      <header className="public-header">
        <Logo dark />
        <div>
          {sample && <span className="sample-label">SAMPLE REPORT</span>}
          {report.pdfUrl && <a className="button button-small button-dark" href={report.pdfUrl}>Download PDF</a>}
          {!report.pdfUrl && sample && <Link className="button button-small button-dark" to="/pricing">Create reports like this</Link>}
        </div>
      </header>
      <main className="public-report">
        <section className="report-title">
          <span>MONTHLY WEBSITE CARE REPORT</span>
          <h1>{report.clientName}</h1>
          <p>{report.periodLabel}</p>
        </section>
        <section className="report-section report-executive">
          <span className="report-section-no">01</span><div><small>EXECUTIVE SUMMARY</small><h2>{report.snapshot.executiveSummary}</h2></div>
        </section>
        <section className="report-section">
          <span className="report-section-no">02</span>
          <div className="wide">
            <small>CURRENT HEALTH</small>
            <div className="health-card">
              <span className="health-check"><Icon name="check" /></span>
              <div><h2>{report.snapshot.currentHealth.message}</h2><p>Observed during scheduled public website checks in this reporting period.</p></div>
              <b>{report.snapshot.currentHealth.passed}/{report.snapshot.currentHealth.scheduled}</b>
            </div>
          </div>
        </section>
        <section className="report-section">
          <span className="report-section-no">03</span>
          <div className="wide">
            <small>WORK COMPLETED</small>
            <div className="public-work-list">
              {report.snapshot.workCompleted.length ? report.snapshot.workCompleted.map((work, index) => (
                <article key={`${work.date}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{work.category}</b><h3>{work.description}</h3></div><time>{new Date(work.date).toLocaleDateString("en", { month: "short", day: "numeric" })}</time></article>
              )) : <p>No client-visible maintenance activities were recorded in this period.</p>}
            </div>
          </div>
        </section>
        <section className="report-two-column">
          <div><small>PROBLEMS PREVENTED</small><ul>{report.snapshot.problemsPrevented.length ? report.snapshot.problemsPrevented.map((item) => <li key={item}><Icon name="check" /> {item}</li>) : <li>No preventable issues were recorded.</li>}</ul></div>
          <div><small>RECOMMENDATIONS</small><ul>{report.snapshot.recommendations.length ? report.snapshot.recommendations.map((item) => <li key={item}><Icon name="arrow" /> {item}</li>) : <li>No recommendations this month.</li>}</ul></div>
        </section>
        <section className="report-closing"><small>CLOSING MESSAGE</small><h2>{report.snapshot.closingMessage}</h2></section>
        <footer className="report-footer"><Logo dark /><p>Prepared with {report.appName} · Client-visible website care</p><small>Generated {new Date(report.generatedAt).toLocaleDateString()}</small></footer>
      </main>
    </>
  );
}

function MarketingFooter() {
  return (
    <footer className="marketing-footer">
      <Logo />
      <p>{brand.message}</p>
      <div><Link to="/sample">Sample</Link><Link to="/pricing">Pricing</Link><Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link></div>
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
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/sample" element={<SampleReport />} />
      <Route path="/login" element={<Login />} />
      <Route path="/terms" element={<LegalPage kind="terms" />} />
      <Route path="/privacy" element={<LegalPage kind="privacy" />} />
      <Route path="/refunds" element={<LegalPage kind="refunds" />} />
      <Route path="/r/:token" element={<PublicReportPage />} />
      <Route path="/app/*" element={<RequireAuth><AppShell /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
