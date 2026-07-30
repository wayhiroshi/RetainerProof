CREATE TABLE search_console_connections (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connected_by_user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  encrypted_refresh_token TEXT NOT NULL,
  scope TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX search_console_connections_workspace_unique
  ON search_console_connections(workspace_id);

CREATE TABLE search_console_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX search_console_oauth_states_expiry_idx
  ON search_console_oauth_states(expires_at);

CREATE TABLE search_console_properties (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES search_console_connections(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL,
  permission_level TEXT NOT NULL,
  last_synced_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX search_console_properties_workspace_client_unique
  ON search_console_properties(workspace_id, client_id);
CREATE INDEX search_console_properties_connection_idx
  ON search_console_properties(workspace_id, connection_id);

CREATE TABLE search_console_keywords (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES search_console_properties(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  normalized_keyword TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX search_console_keywords_property_keyword_unique
  ON search_console_keywords(property_id, normalized_keyword);
CREATE INDEX search_console_keywords_workspace_client_idx
  ON search_console_keywords(workspace_id, client_id, enabled);

CREATE TABLE search_console_daily_metrics (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  keyword_id TEXT NOT NULL REFERENCES search_console_keywords(id) ON DELETE CASCADE,
  metric_date TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0,
  impressions REAL NOT NULL DEFAULT 0,
  ctr REAL NOT NULL DEFAULT 0,
  position REAL,
  fetched_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX search_console_daily_metrics_keyword_date_unique
  ON search_console_daily_metrics(keyword_id, metric_date);
CREATE INDEX search_console_daily_metrics_workspace_date_idx
  ON search_console_daily_metrics(workspace_id, metric_date);
