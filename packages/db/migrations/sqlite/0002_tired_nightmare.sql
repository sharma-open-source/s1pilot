CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`run_id` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer NOT NULL,
	`max_attempts` integer NOT NULL,
	`worker_id` text,
	`lease_expires_at` text,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`type`);--> statement-breakpoint
CREATE INDEX `jobs_run_idx` ON `jobs` (`run_id`);