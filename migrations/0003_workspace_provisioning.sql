CREATE TABLE workspace_provisioning (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
