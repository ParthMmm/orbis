CREATE TABLE `download_requesters` (
  `person_id` text PRIMARY KEY NOT NULL,
  `last_served` integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
CREATE TABLE `download_jobs` (
  `sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `set_id` text NOT NULL UNIQUE REFERENCES `sets`(`id`) ON DELETE CASCADE,
  `person_id` text NOT NULL REFERENCES `download_requesters`(`person_id`)
);
