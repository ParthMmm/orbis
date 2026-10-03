CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, removed INTEGER NOT NULL,
  social INTEGER NOT NULL DEFAULT 0, auto_download INTEGER NOT NULL DEFAULT 1,
  filters TEXT NOT NULL DEFAULT '[]'
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('daily', 'admin')),
  person_id TEXT NOT NULL REFERENCES people(id), added_at TEXT NOT NULL, last_used_at TEXT
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS invites (
  digest TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL REFERENCES people(id),
  expires_at TEXT NOT NULL, used INTEGER NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS trust_migrations (id INTEGER PRIMARY KEY CHECK (id = 1));
