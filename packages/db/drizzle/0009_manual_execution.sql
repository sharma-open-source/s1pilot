CREATE TABLE `manual_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`environment_id` text,
	`browser` text,
	`device` text,
	`assignee` text NOT NULL,
	`hybrid` integer NOT NULL,
	`position` integer NOT NULL,
	`status` text NOT NULL,
	`steps` text NOT NULL,
	`confirmed_steps` text NOT NULL,
	`notes` text NOT NULL,
	`elapsed_ms` real NOT NULL,
	`timer_started_at` text,
	`started_at` text,
	`finished_at` text,
	`case_result_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `manual_items_assignee_idx` ON `manual_items` (`assignee`,`status`);--> statement-breakpoint
CREATE INDEX `manual_items_run_idx` ON `manual_items` (`run_id`);--> statement-breakpoint
ALTER TABLE `test_plans` ADD `assignments` text DEFAULT '{}' NOT NULL;