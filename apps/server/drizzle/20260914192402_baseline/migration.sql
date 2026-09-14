CREATE TABLE `playlist_sets` (
	`playlist_id` text NOT NULL,
	`set_id` text NOT NULL,
	`position` integer NOT NULL,
	CONSTRAINT `playlist_sets_pk` PRIMARY KEY(`playlist_id`, `set_id`),
	CONSTRAINT `fk_playlist_sets_playlist_id_playlists_id_fk` FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`),
	CONSTRAINT `fk_playlist_sets_set_id_sets_id_fk` FOREIGN KEY (`set_id`) REFERENCES `sets`(`id`)
);
--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sets` (
	`id` text PRIMARY KEY,
	`url` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`source` text NOT NULL,
	`tags` text NOT NULL,
	`created_at` text NOT NULL,
	`creator` text,
	`artwork_url` text,
	`duration_seconds` integer,
	`metadata_state` text DEFAULT 'pending' NOT NULL,
	`title_edited_by_user` integer DEFAULT true NOT NULL,
	`download_state` text DEFAULT 'none' NOT NULL,
	`retained_audio_bytes` integer,
	`retained_audio_format` text,
	`playback_position_seconds` integer DEFAULT 0 NOT NULL,
	`listen_count` integer DEFAULT 0 NOT NULL,
	`finish_count` integer DEFAULT 0 NOT NULL,
	`last_listened_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_sets_position_unique` ON `playlist_sets` (`playlist_id`,`position`);--> statement-breakpoint
CREATE INDEX `playlist_sets_by_set` ON `playlist_sets` (`set_id`,`playlist_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `playlists_name_unique` ON `playlists` ("name" COLLATE NOCASE);