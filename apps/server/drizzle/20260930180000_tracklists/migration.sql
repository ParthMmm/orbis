ALTER TABLE `sets` ADD `tracklist_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `sets` ADD `tracklist_run_id` text;--> statement-breakpoint
ALTER TABLE `sets` ADD `tracklist_run_started_at` text;--> statement-breakpoint
CREATE TABLE `set_cues` (
  `set_id` text NOT NULL REFERENCES `sets`(`id`) ON DELETE CASCADE,
  `position` integer NOT NULL,
  `start_seconds` integer,
  `artist` text NOT NULL,
  `title` text NOT NULL,
  `apple_music_id` text,
  `artwork_url` text,
  PRIMARY KEY(`set_id`, `position`)
);
