ALTER TABLE `playlists` ADD COLUMN `collaborative` integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE TABLE `playlist_editors` (
  `playlist_id` text NOT NULL REFERENCES `playlists`(`id`) ON DELETE CASCADE,
  `creator_id` text NOT NULL,
  `editor_id` text NOT NULL,
  PRIMARY KEY (`playlist_id`, `editor_id`)
);--> statement-breakpoint
CREATE INDEX `playlist_editors_by_editor` ON `playlist_editors` (`editor_id`, `playlist_id`);
