ALTER TABLE `jobs` ADD `labels` text;--> statement-breakpoint
ALTER TABLE `test_plans` ADD `worker_labels` text DEFAULT '[]' NOT NULL;