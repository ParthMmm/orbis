CREATE TABLE `listens` (
  `id` integer PRIMARY KEY AUTOINCREMENT,
  `person_id` text NOT NULL,
  `set_id` text NOT NULL REFERENCES `sets`(`id`),
  `started_at` text NOT NULL,
  `finished_at` text,
  `start_known` integer NOT NULL DEFAULT 1
);--> statement-breakpoint
CREATE INDEX `listens_by_person_set` ON `listens` (`person_id`, `set_id`, `id`);--> statement-breakpoint
CREATE INDEX `listens_by_set` ON `listens` (`set_id`);--> statement-breakpoint
INSERT INTO `listens` (`person_id`, `set_id`, `started_at`, `finished_at`, `start_known`)
WITH RECURSIVE historical (`set_id`, `ordinal`, `total`, `finished`, `created_at`, `last_at`) AS (
  SELECT `id`, 1, `listen_count`, `finish_count`, `created_at`, `last_listened_at`
  FROM `sets` WHERE `listen_count` > 0
  UNION ALL
  SELECT `set_id`, `ordinal` + 1, `total`, `finished`, `created_at`, `last_at`
  FROM historical WHERE `ordinal` < `total`
)
SELECT 'host', `set_id`,
  CASE WHEN `ordinal` = `total` AND `last_at` IS NOT NULL THEN `last_at` ELSE `created_at` END,
  CASE WHEN `ordinal` <= `finished` THEN
    CASE WHEN `ordinal` = `total` AND `last_at` IS NOT NULL THEN `last_at` ELSE `created_at` END
  ELSE NULL END,
  CASE WHEN `ordinal` = `total` AND `last_at` IS NOT NULL THEN 1 ELSE 0 END
FROM historical;
