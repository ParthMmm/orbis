CREATE TABLE api_keys_node_scope (
  id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('daily', 'admin', 'node')),
  person_id TEXT NOT NULL REFERENCES people(id), added_at TEXT NOT NULL, last_used_at TEXT
);--> statement-breakpoint
INSERT INTO api_keys_node_scope SELECT * FROM api_keys;--> statement-breakpoint
DROP TABLE api_keys;--> statement-breakpoint
ALTER TABLE api_keys_node_scope RENAME TO api_keys;
