CREATE TABLE `feed_recipients` (
  `person_id` text PRIMARY KEY,
  `sequence` integer NOT NULL,
  `authorization_epoch` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `feed_deliveries` (
  `person_id` text NOT NULL,
  `sequence` integer NOT NULL,
  `tag` text NOT NULL,
  `topic` text NOT NULL CHECK (`topic` IN ('queue', 'presence', 'library', 'playlist', 'listen-history', 'set')),
  `resource_id` text,
  `recorded_at` integer NOT NULL,
  PRIMARY KEY(`person_id`, `sequence`)
);--> statement-breakpoint
CREATE INDEX `feed_deliveries_by_age` ON `feed_deliveries` (`person_id`,`recorded_at`);
