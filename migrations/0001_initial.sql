PRAGMA foreign_keys = ON;

CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX session_user_id_idx ON session(user_id);
CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX account_user_id_idx ON account(user_id);
CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  plan TEXT NOT NULL DEFAULT 'starter',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE workspace_members (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX workspace_member_unique ON workspace_members(workspace_id, user_id);
CREATE INDEX workspace_member_user_idx ON workspace_members(user_id);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'stripe',
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid',
  plan TEXT NOT NULL DEFAULT 'starter',
  current_period_end INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX subscription_workspace_unique ON subscriptions(workspace_id);
CREATE UNIQUE INDEX subscription_provider_id_unique ON subscriptions(provider_subscription_id);
CREATE TABLE clients (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX clients_workspace_idx ON clients(workspace_id);
CREATE TABLE services (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Website Care',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX services_workspace_client_idx ON services(workspace_id, client_id);
CREATE TABLE managed_assets (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  critical_urls_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_check_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX assets_workspace_client_idx ON managed_assets(workspace_id, client_id);
CREATE TABLE check_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES managed_assets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX check_definitions_due_idx ON check_definitions(workspace_id, asset_id);
CREATE TABLE activities (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES managed_assets(id) ON DELETE SET NULL,
  occurred_at INTEGER NOT NULL,
  category TEXT NOT NULL,
  visibility TEXT NOT NULL,
  internal_note TEXT NOT NULL,
  client_summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX activities_workspace_client_date_idx ON activities(workspace_id, client_id, occurred_at);
CREATE TABLE check_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES managed_assets(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER,
  response_ms INTEGER,
  tls_expires_at INTEGER,
  error_code TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  checked_at INTEGER NOT NULL
);
CREATE INDEX check_runs_workspace_asset_date_idx ON check_runs(workspace_id, asset_id, checked_at);
CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  current_revision INTEGER NOT NULL DEFAULT 1,
  share_token_hash TEXT,
  first_viewed_at INTEGER,
  finalized_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX reports_workspace_client_period_idx ON reports(workspace_id, client_id, period_start);
CREATE TABLE report_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  pdf_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX report_revision_unique ON report_revisions(report_id, revision);
CREATE TABLE report_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX deliveries_workspace_report_idx ON report_deliveries(workspace_id, report_id);
CREATE TABLE ai_rewrites (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_text TEXT NOT NULL,
  generated_json TEXT,
  accepted_text TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_rewrites_workspace_idx ON ai_rewrites(workspace_id);
CREATE TABLE billing_events (
  id TEXT PRIMARY KEY NOT NULL,
  provider_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);
