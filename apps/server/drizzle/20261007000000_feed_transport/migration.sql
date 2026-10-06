CREATE TABLE `feed_tickets` (
  `digest` text PRIMARY KEY,
  `key_id` text NOT NULL,
  `person_id` text NOT NULL,
  `authorization_epoch` integer NOT NULL,
  `protocol` text NOT NULL,
  `expires_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `feed_tickets_by_expiry` ON `feed_tickets` (`expires_at`);--> statement-breakpoint
CREATE TABLE `feed_connections` (
  `id` text PRIMARY KEY,
  `key_id` text NOT NULL,
  `person_id` text NOT NULL,
  `greeted` integer NOT NULL DEFAULT 0,
  `sent_cursor` text,
  `acked_cursor` text,
  `unacked_sequences` text NOT NULL DEFAULT '[]',
  `opened_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `feed_connections_by_key` ON `feed_connections` (`key_id`);
