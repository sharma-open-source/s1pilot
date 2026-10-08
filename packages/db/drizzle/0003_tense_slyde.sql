CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`case_result_id` text NOT NULL,
	`step_index` integer,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_project_idx` ON `artifacts` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `artifacts_result_idx` ON `artifacts` (`case_result_id`);