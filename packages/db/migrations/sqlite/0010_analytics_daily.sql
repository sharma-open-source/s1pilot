CREATE TABLE `analytics_daily` (
	`project_id` text NOT NULL,
	`day` text NOT NULL,
	`environment_id` text NOT NULL,
	`suite_id` text NOT NULL,
	`passed` integer NOT NULL,
	`review` integer NOT NULL,
	`failed` integer NOT NULL,
	`flaky` integer NOT NULL,
	`skipped` integer NOT NULL,
	`steps_replay` integer NOT NULL,
	`steps_heal` integer NOT NULL,
	`steps_explore` integer NOT NULL,
	`decisions` integer NOT NULL,
	`escalated` integer NOT NULL,
	`latency_hist` text NOT NULL,
	PRIMARY KEY(`project_id`, `day`, `environment_id`, `suite_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `case_results_run_case_idx` ON `case_results` (`run_id`,`case_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `test_runs_project_started_idx` ON `test_runs` (`project_id`,`started_at`);