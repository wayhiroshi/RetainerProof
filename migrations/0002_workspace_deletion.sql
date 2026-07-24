ALTER TABLE workspaces ADD COLUMN deletion_scheduled_at INTEGER;
CREATE INDEX workspaces_deletion_scheduled_idx ON workspaces(deletion_scheduled_at);
