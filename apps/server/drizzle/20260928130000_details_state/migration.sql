ALTER TABLE `sets` ADD `details_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE `sets` SET `details_state` = 'filled' WHERE `source_tags` IS NOT NULL;
