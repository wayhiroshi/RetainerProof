CREATE TABLE form_monitors (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES managed_assets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  form_type TEXT NOT NULL,
  turnstile_widget_name TEXT,
  require_turnstile INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  next_presence_check_at INTEGER NOT NULL,
  next_submission_check_at INTEGER NOT NULL,
  last_presence_passed_at INTEGER,
  last_submission_passed_at INTEGER,
  incident_opened_at INTEGER,
  last_recovered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX form_monitors_due_idx
  ON form_monitors(enabled, next_presence_check_at);
CREATE INDEX form_monitors_workspace_client_idx
  ON form_monitors(workspace_id, client_id);

CREATE TABLE form_check_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES form_monitors(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  page_reachable INTEGER,
  form_present INTEGER,
  turnstile_script_present INTEGER,
  turnstile_widget_present INTEGER,
  submit_control_present INTEGER,
  required_fields_present INTEGER,
  website_submission_status TEXT NOT NULL DEFAULT 'not_checked',
  website_submitted_at INTEGER,
  wordpress_receipt_status TEXT NOT NULL DEFAULT 'not_checked',
  wordpress_received_at INTEGER,
  admin_notification_status TEXT NOT NULL DEFAULT 'not_checked',
  admin_notification_at INTEGER,
  auto_reply_status TEXT NOT NULL DEFAULT 'not_checked',
  auto_reply_at INTEGER,
  status_code INTEGER,
  duration_ms INTEGER,
  error_code TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX form_check_runs_workspace_monitor_date_idx
  ON form_check_runs(workspace_id, monitor_id, created_at);
CREATE INDEX form_check_runs_pending_idx
  ON form_check_runs(workspace_id, status, mode, created_at);
