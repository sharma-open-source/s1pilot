PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_heal_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`run_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`confidence` real NOT NULL,
	`s2_agreed` integer,
	`approved_live` text,
	`shared_step_id` text,
	`impact_case_ids` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text,
	FOREIGN KEY (`case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP TABLE `heal_proposals`;--> statement-breakpoint
ALTER TABLE `__new_heal_proposals` RENAME TO `heal_proposals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_apply_heals` integer DEFAULT false NOT NULL;
