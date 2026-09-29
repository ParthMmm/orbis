CREATE TABLE `library_entries` (
  `person_id` text NOT NULL,
  `set_id` text NOT NULL REFERENCES `sets`(`id`),
  `saved_at` text NOT NULL,
  `title_override` text,
  `tags` text NOT NULL,
  PRIMARY KEY (`person_id`, `set_id`)
);--> statement-breakpoint
CREATE INDEX `library_entries_by_set` ON `library_entries` (`set_id`);--> statement-breakpoint
INSERT INTO `library_entries` (`person_id`, `set_id`, `saved_at`, `title_override`, `tags`)
SELECT 'host', `id`, `created_at`,
  CASE WHEN `title_edited_by_user` = 1 THEN `title` ELSE NULL END,
  `tags`
FROM `sets`;
--> statement-breakpoint
UPDATE `sets` SET `title` = CASE `source`
  WHEN 'youtube' THEN 'YouTube video'
  ELSE 'SoundCloud track'
END, `title_edited_by_user` = 0
WHERE `title_edited_by_user` = 1;
--> statement-breakpoint
UPDATE `sets` SET `tags` = '[]';
