import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
};

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  ...timestamps,
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  plan: text("plan", { enum: ["founding", "starter", "freelancer"] }).notNull().default("starter"),
  deletionScheduledAt: integer("deletion_scheduled_at", { mode: "timestamp" }),
  ...timestamps,
});

export const workspaceProvisioning = sqliteTable("workspace_provisioning", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
});

export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner"] }).notNull().default("owner"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("workspace_member_unique").on(table.workspaceId, table.userId),
    index("workspace_member_user_idx").on(table.userId),
  ],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("stripe"),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    status: text("status", {
      enum: ["trialing", "active", "past_due", "canceled", "unpaid"],
    })
      .notNull()
      .default("unpaid"),
    plan: text("plan", { enum: ["founding", "starter", "freelancer"] }).notNull().default("starter"),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("subscription_workspace_unique").on(table.workspaceId),
    uniqueIndex("subscription_provider_id_unique").on(table.providerSubscriptionId),
  ],
);

export const clients = sqliteTable(
  "clients",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
    ...timestamps,
  },
  (table) => [index("clients_workspace_idx").on(table.workspaceId)],
);

export const services = sqliteTable(
  "services",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Website Care"),
    ...timestamps,
  },
  (table) => [index("services_workspace_client_idx").on(table.workspaceId, table.clientId)],
);

export const managedAssets = sqliteTable(
  "managed_assets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    criticalUrlsJson: text("critical_urls_json").notNull().default("[]"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextCheckAt: integer("next_check_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    ...timestamps,
  },
  (table) => [index("assets_workspace_client_idx").on(table.workspaceId, table.clientId)],
);

export const checkDefinitions = sqliteTable(
  "check_definitions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => managedAssets.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["http", "tls"] }).notNull(),
    target: text("target").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [index("check_definitions_due_idx").on(table.workspaceId, table.assetId)],
);

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    assetId: text("asset_id").references(() => managedAssets.id, { onDelete: "set null" }),
    occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
    category: text("category", {
      enum: ["updates", "backups", "security", "fixes", "content", "performance", "forms", "support", "other"],
    }).notNull(),
    visibility: text("visibility", {
      enum: ["client_visible", "internal_only", "recommendation"],
    }).notNull(),
    internalNote: text("internal_note").notNull(),
    clientSummary: text("client_summary").notNull(),
    ...timestamps,
  },
  (table) => [index("activities_workspace_client_date_idx").on(table.workspaceId, table.clientId, table.occurredAt)],
);

export const checkRuns = sqliteTable(
  "check_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => managedAssets.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
    status: text("status", { enum: ["passed", "failed"] }).notNull(),
    statusCode: integer("status_code"),
    responseMs: integer("response_ms"),
    tlsExpiresAt: integer("tls_expires_at", { mode: "timestamp" }),
    errorCode: text("error_code"),
    attempt: integer("attempt").notNull().default(1),
    checkedAt: integer("checked_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("check_runs_workspace_asset_date_idx").on(table.workspaceId, table.assetId, table.checkedAt)],
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    periodStart: integer("period_start", { mode: "timestamp" }).notNull(),
    periodEnd: integer("period_end", { mode: "timestamp" }).notNull(),
    status: text("status", { enum: ["draft", "finalized", "revoked"] }).notNull().default("draft"),
    currentRevision: integer("current_revision").notNull().default(1),
    shareTokenHash: text("share_token_hash"),
    firstViewedAt: integer("first_viewed_at", { mode: "timestamp" }),
    finalizedAt: integer("finalized_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [index("reports_workspace_client_period_idx").on(table.workspaceId, table.clientId, table.periodStart)],
);

export const reportRevisions = sqliteTable(
  "report_revisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    pdfKey: text("pdf_key"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("report_revision_unique").on(table.reportId, table.revision)],
);

export const reportDeliveries = sqliteTable(
  "report_deliveries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    recipientEmail: text("recipient_email").notNull(),
    status: text("status", { enum: ["queued", "sent", "failed", "bounced"] }).notNull(),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    sentAt: integer("sent_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("deliveries_workspace_report_idx").on(table.workspaceId, table.reportId)],
);

export const aiRewrites = sqliteTable(
  "ai_rewrites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    sourceText: text("source_text").notNull(),
    generatedJson: text("generated_json"),
    acceptedText: text("accepted_text"),
    status: text("status", { enum: ["generated", "accepted", "failed"] }).notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("ai_rewrites_workspace_idx").on(table.workspaceId)],
);

export const billingEvents = sqliteTable("billing_events", {
  id: text("id").primaryKey(),
  providerEventId: text("provider_event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  payloadHash: text("payload_hash").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp" }).notNull(),
});

export const schema = {
  user,
  session,
  account,
  verification,
  workspaces,
  workspaceProvisioning,
  workspaceMembers,
  subscriptions,
  clients,
  services,
  managedAssets,
  checkDefinitions,
  activities,
  checkRuns,
  reports,
  reportRevisions,
  reportDeliveries,
  aiRewrites,
  billingEvents,
};

export type ClientRow = typeof clients.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type ManagedAssetRow = typeof managedAssets.$inferSelect;
