CREATE TABLE `playlists_new` (
  `id` text PRIMARY KEY NOT NULL,
  `creator_id` text NOT NULL DEFAULT 'host',
  `name` text NOT NULL,
  `created_at` text NOT NULL
);--> statement-breakpoint
INSERT INTO `playlists_new` (`id`, `creator_id`, `name`, `created_at`)
SELECT `id`, 'host', `name`, `created_at` FROM `playlists`;--> statement-breakpoint
CREATE TABLE `playlist_sets_new` (
  `playlist_id` text NOT NULL REFERENCES `playlists_new`(`id`),
  `set_id` text NOT NULL REFERENCES `sets`(`id`),
  `position` integer NOT NULL,
  PRIMARY KEY (`playlist_id`, `set_id`)
);--> statement-breakpoint
INSERT INTO `playlist_sets_new` (`playlist_id`, `set_id`, `position`)
SELECT `playlist_id`, `set_id`, `position` FROM `playlist_sets`;--> statement-breakpoint
DROP TABLE `playlist_sets`;--> statement-breakpoint
DROP TABLE `playlists`;--> statement-breakpoint
ALTER TABLE `playlists_new` RENAME TO `playlists`;--> statement-breakpoint
ALTER TABLE `playlist_sets_new` RENAME TO `playlist_sets`;--> statement-breakpoint
CREATE UNIQUE INDEX `playlists_creator_name_unique` ON `playlists` (`creator_id`, `name` COLLATE NOCASE);--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_sets_position_unique` ON `playlist_sets` (`playlist_id`, `position`);--> statement-breakpoint
CREATE INDEX `playlist_sets_by_set` ON `playlist_sets` (`set_id`, `playlist_id`);
