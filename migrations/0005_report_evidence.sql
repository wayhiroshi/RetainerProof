CREATE TABLE maintenance_items (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX maintenance_items_workspace_client_idx
  ON maintenance_items(workspace_id, client_id, enabled, sort_order);

ALTER TABLE activities ADD COLUMN maintenance_item_id TEXT;
ALTER TABLE activities ADD COLUMN target TEXT NOT NULL DEFAULT '';
ALTER TABLE activities ADD COLUMN outcome_type TEXT NOT NULL DEFAULT 'work_completed';
ALTER TABLE activities ADD COLUMN result_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE activities ADD COLUMN verification_method TEXT NOT NULL DEFAULT '';
ALTER TABLE activities ADD COLUMN client_value TEXT NOT NULL DEFAULT '';
ALTER TABLE activities ADD COLUMN recommendation_priority TEXT;
ALTER TABLE activities ADD COLUMN next_action TEXT NOT NULL DEFAULT '';
