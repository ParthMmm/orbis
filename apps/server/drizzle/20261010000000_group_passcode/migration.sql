DROP TABLE IF EXISTS invites;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS group_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), passcode TEXT
);
