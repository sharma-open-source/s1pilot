CREATE TABLE `auth_setups` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`flow_id` text,
	`state_ciphertext` text,
	`last_refreshed_at` text,
	`status` text NOT NULL,
	`validation` text,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_setups_env_name_unq` ON `auth_setups` (`environment_id`,`name`);