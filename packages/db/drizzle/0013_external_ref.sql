ALTER TABLE `test_cases` ADD `external_ref` text;--> statement-breakpoint
CREATE INDEX `test_cases_external_ref_idx` ON `test_cases` (`project_id`,`external_ref`);
