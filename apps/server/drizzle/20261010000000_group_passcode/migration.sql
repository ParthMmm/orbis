DROP TABLE IF EXISTS invites;--> statement-breakpoint
UPDATE api_keys SET scope = 'daily' WHERE scope = 'admin';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS group_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), passcode TEXT
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sign_in_codes (
  code TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL REFERENCES people(id),
  expires_at TEXT NOT NULL
);
