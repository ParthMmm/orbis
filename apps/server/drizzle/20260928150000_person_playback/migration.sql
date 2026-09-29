CREATE TABLE `playback_positions` (
  `person_id` text NOT NULL,
  `set_id` text NOT NULL REFERENCES `sets`(`id`),
  `seconds` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`person_id`, `set_id`)
);--> statement-breakpoint
INSERT INTO `playback_positions` (`person_id`, `set_id`, `seconds`)
SELECT 'host', `id`, `playback_position_seconds` FROM `sets`
WHERE `playback_position_seconds` <> 0;--> statement-breakpoint
CREATE INDEX `playback_positions_by_set` ON `playback_positions` (`set_id`);--> statement-breakpoint
CREATE TABLE `person_queue_entries` (
  `person_id` text NOT NULL,
  `set_id` text NOT NULL REFERENCES `sets`(`id`),
  `position` integer NOT NULL,
  `is_active` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`person_id`, `set_id`)
);--> statement-breakpoint
INSERT INTO `person_queue_entries` (`person_id`, `set_id`, `position`, `is_active`)
SELECT 'host', `set_id`, `position`, `is_active` FROM `queue_entries`;--> statement-breakpoint
DROP TABLE `queue_entries`;--> statement-breakpoint
ALTER TABLE `person_queue_entries` RENAME TO `queue_entries`;--> statement-breakpoint
CREATE UNIQUE INDEX `queue_entries_position_unique` ON `queue_entries` (`person_id`, `position`);--> statement-breakpoint
CREATE UNIQUE INDEX `queue_entries_active_unique` ON `queue_entries` (`person_id`) WHERE `is_active` = 1;
--> statement-breakpoint
CREATE INDEX `queue_entries_by_set` ON `queue_entries` (`set_id`);
