ALTER TABLE `photos` ADD `unit_name` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `photos` ADD `location_text` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `photos` ADD `photographer` text NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE `capture_assignments` (
  `token` text PRIMARY KEY NOT NULL,
  `folder_id` integer NOT NULL,
  `account_key` text NOT NULL,
  `unit_name` text NOT NULL,
  `location_text` text NOT NULL,
  `photographer` text NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`folder_id`) REFERENCES `folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `capture_assignments_account_key_idx` ON `capture_assignments` (`account_key`);
--> statement-breakpoint
CREATE INDEX `capture_assignments_folder_id_idx` ON `capture_assignments` (`folder_id`);
