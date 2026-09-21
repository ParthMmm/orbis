CREATE TABLE `queue_entries` (
	`is_active` integer DEFAULT false NOT NULL,
	`position` integer NOT NULL,
	`set_id` text PRIMARY KEY,
	CONSTRAINT `fk_queue_entries_set_id_sets_id_fk` FOREIGN KEY (`set_id`) REFERENCES `sets`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `queue_entries_position_unique` ON `queue_entries` (`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `queue_entries_active_unique` ON `queue_entries` (`is_active`) WHERE "queue_entries"."is_active" = 1;