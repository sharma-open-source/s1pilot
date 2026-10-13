ALTER TABLE `test_cases` ADD `quarantined` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `test_cases` ADD `quarantine_reason` text;--> statement-breakpoint
ALTER TABLE `test_cases` ADD `quarantined_at` text;--> statement-breakpoint
ALTER TABLE `test_cases` ADD `flakiness` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `case_results` ADD `reason` text;