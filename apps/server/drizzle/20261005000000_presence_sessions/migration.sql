CREATE TABLE `presence_sessions` (
  `key_id` text NOT NULL,
  `session_id` text NOT NULL,
  `person_id` text NOT NULL,
  `set_id` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('playing', 'paused', 'stopped', 'superseded')),
  `owner_generation` integer NOT NULL,
  `action_number` integer NOT NULL,
  `lease_expires_at` integer,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`key_id`, `session_id`)
);--> statement-breakpoint
CREATE INDEX `presence_sessions_by_person` ON `presence_sessions` (`person_id`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `presence_sessions_owner_unique` ON `presence_sessions` (`person_id`) WHERE `state` IN ('playing', 'paused');--> statement-breakpoint
CREATE TABLE `presence_action_results` (
  `key_id` text NOT NULL,
  `session_id` text NOT NULL,
  `action_id` text NOT NULL,
  `input` text NOT NULL,
  `result` text NOT NULL,
  `recorded_at` integer NOT NULL,
  PRIMARY KEY(`key_id`, `session_id`, `action_id`)
);--> statement-breakpoint
CREATE INDEX `presence_action_results_by_age` ON `presence_action_results` (`key_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `presence_keys` (
  `key_id` text PRIMARY KEY,
  `person_id` text NOT NULL,
  `opted_in_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `presence_legacy_reports` (
  `key_id` text PRIMARY KEY,
  `person_id` text NOT NULL,
  `set_id` text NOT NULL,
  `reported_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `presence_legacy_reports_by_person` ON `presence_legacy_reports` (`person_id`,`reported_at`);
