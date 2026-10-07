CREATE TABLE `case_requirements` (
	`case_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	PRIMARY KEY(`case_id`, `requirement_id`),
	FOREIGN KEY (`case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requirement_id`) REFERENCES `requirements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `heal_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`learned_script_id` text NOT NULL,
	`run_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`actions` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text,
	FOREIGN KEY (`learned_script_id`) REFERENCES `learned_scripts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `learned_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`case_version` integer NOT NULL,
	`environment_id` text NOT NULL,
	`actions` text NOT NULL,
	`created_from_run_id` text NOT NULL,
	`health` text NOT NULL,
	`created_at` text,
	FOREIGN KEY (`case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `learned_scripts_case_env_unq` ON `learned_scripts` (`case_id`,`environment_id`);--> statement-breakpoint
CREATE TABLE `requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requirements_project_key_unq` ON `requirements` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `shared_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`params` text NOT NULL,
	`steps` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `test_case_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_case_versions_unq` ON `test_case_versions` (`case_id`,`version`);--> statement-breakpoint
CREATE TABLE `test_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`suite_id` text,
	`key` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`priority` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`tags` text NOT NULL,
	`requirements` text NOT NULL,
	`preconditions` text NOT NULL,
	`parameters` text NOT NULL,
	`steps` text NOT NULL,
	`owner` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suite_id`) REFERENCES `suites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_cases_key_unique` ON `test_cases` (`key`);--> statement-breakpoint
CREATE INDEX `test_cases_suite_idx` ON `test_cases` (`suite_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `test_cases_project_number_unq` ON `test_cases` (`project_id`,`number`);--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`allow_domains` text NOT NULL,
	`auth_setup_flow_id` text,
	`browsers` text NOT NULL,
	`read_only` integer NOT NULL,
	`require_approval_for` text NOT NULL,
	`locale` text NOT NULL,
	`timezone` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `environments_project_idx` ON `environments` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`default_environment_id` text,
	`model_settings` text,
	`retention_days` integer DEFAULT 30 NOT NULL,
	`data_policy` text NOT NULL,
	`next_case_number` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_key_unique` ON `projects` (`key`);--> statement-breakpoint
CREATE TABLE `suites` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `suites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suites_project_idx` ON `suites` (`project_id`);--> statement-breakpoint
CREATE TABLE `test_data_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text,
	`name` text NOT NULL,
	`rows` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `variables` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`secret` integer NOT NULL,
	`secret_ciphertext` text,
	`source` text NOT NULL,
	`env_var` text,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variables_env_key_unq` ON `variables` (`environment_id`,`key`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `case_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`case_version` integer NOT NULL,
	`environment_id` text,
	`browser` text,
	`attempt` integer NOT NULL,
	`verdict` text NOT NULL,
	`confidence` real,
	`duration_ms` real NOT NULL,
	`mode` text NOT NULL,
	`escalations` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `case_results_run_idx` ON `case_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `case_results_case_idx` ON `case_results` (`case_id`);--> statement-breakpoint
CREATE TABLE `decision_records` (
	`id` text PRIMARY KEY NOT NULL,
	`step_result_id` text NOT NULL,
	`position` integer NOT NULL,
	`question_id` text NOT NULL,
	`options` text NOT NULL,
	`probabilities` text NOT NULL,
	`chosen` text,
	`confidence` real NOT NULL,
	`model` text NOT NULL,
	`latency_ms` real NOT NULL,
	`escalated_to` text,
	FOREIGN KEY (`step_result_id`) REFERENCES `step_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `decision_records_step_idx` ON `decision_records` (`step_result_id`);--> statement-breakpoint
CREATE TABLE `defect_results` (
	`defect_id` text NOT NULL,
	`case_result_id` text NOT NULL,
	PRIMARY KEY(`defect_id`, `case_result_id`),
	FOREIGN KEY (`defect_id`) REFERENCES `defects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_result_id`) REFERENCES `case_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `defects` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`external_provider` text,
	`external_id` text,
	`external_url` text,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`step_result_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`artifact_id` text NOT NULL,
	FOREIGN KEY (`step_result_id`) REFERENCES `step_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_step_idx` ON `evidence` (`step_result_id`);--> statement-breakpoint
CREATE TABLE `review_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`created_at` text,
	`resolved_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_items_project_status_idx` ON `review_items` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `step_results` (
	`id` text PRIMARY KEY NOT NULL,
	`case_result_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`status` text NOT NULL,
	`action_taken` text,
	`assertions` text NOT NULL,
	`latency_ms` real NOT NULL,
	FOREIGN KEY (`case_result_id`) REFERENCES `case_results`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `step_results_case_idx` ON `step_results` (`case_result_id`);--> statement-breakpoint
CREATE TABLE `test_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`release` text,
	`selection` text NOT NULL,
	`matrix` text NOT NULL,
	`retries` integer NOT NULL,
	`parallelism` integer NOT NULL,
	`mode` text NOT NULL,
	`unattended` text NOT NULL,
	`schedule` text,
	`exit_criteria` text NOT NULL,
	`checks` text NOT NULL,
	`created_at` text,
	`updated_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`plan_id` text,
	`trigger` text NOT NULL,
	`build_ref` text,
	`status` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`summary` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `test_plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `test_runs_project_idx` ON `test_runs` (`project_id`);