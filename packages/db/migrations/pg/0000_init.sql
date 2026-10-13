CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"last_used_at" text,
	"revoked_at" text,
	CONSTRAINT "api_tokens_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "auth_setups" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"flow_id" text,
	"state_ciphertext" text,
	"last_refreshed_at" text,
	"status" text NOT NULL,
	"validation" jsonb,
	CONSTRAINT "auth_setups_env_name_unq" UNIQUE("environment_id","name")
);
--> statement-breakpoint
CREATE TABLE "case_requirements" (
	"case_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	CONSTRAINT "case_requirements_case_id_requirement_id_pk" PRIMARY KEY("case_id","requirement_id")
);
--> statement-breakpoint
CREATE TABLE "heal_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"run_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"s2_agreed" boolean,
	"approved_live" text,
	"shared_step_id" text,
	"impact_case_ids" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" text
);
--> statement-breakpoint
CREATE TABLE "learned_scripts" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"case_version" integer NOT NULL,
	"environment_id" text NOT NULL,
	"actions" jsonb NOT NULL,
	"created_from_run_id" text NOT NULL,
	"health" jsonb NOT NULL,
	"created_at" text,
	CONSTRAINT "learned_scripts_case_env_unq" UNIQUE("case_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"created_at" text,
	"updated_at" text,
	CONSTRAINT "requirements_project_key_unq" UNIQUE("project_id","key")
);
--> statement-breakpoint
CREATE TABLE "shared_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"params" jsonb NOT NULL,
	"steps" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_case_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "test_case_versions_unq" UNIQUE("case_id","version")
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"suite_id" text,
	"key" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"priority" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"tags" jsonb NOT NULL,
	"requirements" jsonb NOT NULL,
	"preconditions" jsonb NOT NULL,
	"parameters" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"owner" text,
	"external_ref" text,
	"quarantined" boolean DEFAULT false NOT NULL,
	"quarantine_reason" text,
	"quarantined_at" text,
	"flakiness" double precision DEFAULT 0 NOT NULL,
	"version" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "test_cases_key_unique" UNIQUE("key"),
	CONSTRAINT "test_cases_project_number_unq" UNIQUE("project_id","number")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"allow_domains" jsonb NOT NULL,
	"auth_setup_flow_id" text,
	"browsers" jsonb NOT NULL,
	"read_only" boolean NOT NULL,
	"require_approval_for" jsonb NOT NULL,
	"locale" text NOT NULL,
	"timezone" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"default_environment_id" text,
	"model_settings" jsonb,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"auto_apply_heals" boolean DEFAULT false NOT NULL,
	"data_policy" jsonb NOT NULL,
	"next_case_number" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "projects_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "suites" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_data_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text,
	"name" text NOT NULL,
	"rows" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variables" (
	"id" text PRIMARY KEY NOT NULL,
	"environment_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"secret" boolean NOT NULL,
	"secret_ciphertext" text,
	"source" text NOT NULL,
	"env_var" text,
	CONSTRAINT "variables_env_key_unq" UNIQUE("environment_id","key")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_daily" (
	"project_id" text NOT NULL,
	"day" text NOT NULL,
	"environment_id" text NOT NULL,
	"suite_id" text NOT NULL,
	"passed" integer NOT NULL,
	"review" integer NOT NULL,
	"failed" integer NOT NULL,
	"flaky" integer NOT NULL,
	"skipped" integer NOT NULL,
	"steps_replay" integer NOT NULL,
	"steps_heal" integer NOT NULL,
	"steps_explore" integer NOT NULL,
	"decisions" integer NOT NULL,
	"escalated" integer NOT NULL,
	"latency_hist" jsonb NOT NULL,
	CONSTRAINT "analytics_daily_project_id_day_environment_id_suite_id_pk" PRIMARY KEY("project_id","day","environment_id","suite_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"case_result_id" text NOT NULL,
	"step_index" integer,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"path" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"case_version" integer NOT NULL,
	"environment_id" text,
	"browser" text,
	"attempt" integer NOT NULL,
	"verdict" text NOT NULL,
	"confidence" double precision,
	"duration_ms" double precision NOT NULL,
	"mode" text NOT NULL,
	"escalations" integer NOT NULL,
	"reason" text,
	"checks" jsonb
);
--> statement-breakpoint
CREATE TABLE "decision_records" (
	"id" text PRIMARY KEY NOT NULL,
	"step_result_id" text NOT NULL,
	"position" integer NOT NULL,
	"question_id" text NOT NULL,
	"options" jsonb NOT NULL,
	"probabilities" jsonb NOT NULL,
	"chosen" text,
	"confidence" double precision NOT NULL,
	"model" text NOT NULL,
	"latency_ms" double precision NOT NULL,
	"escalated_to" text,
	"decided_by" text,
	"via" text
);
--> statement-breakpoint
CREATE TABLE "defect_results" (
	"defect_id" text NOT NULL,
	"case_result_id" text NOT NULL,
	CONSTRAINT "defect_results_defect_id_case_result_id_pk" PRIMARY KEY("defect_id","case_result_id")
);
--> statement-breakpoint
CREATE TABLE "defects" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"seq" integer,
	"description" text,
	"details" jsonb,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"external_provider" text,
	"external_id" text,
	"external_url" text,
	"created_at" text,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"step_result_id" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"artifact_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"run_id" text,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"worker_id" text,
	"lease_expires_at" text,
	"result" jsonb,
	"error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"case_id" text NOT NULL,
	"environment_id" text,
	"browser" text,
	"device" text,
	"assignee" text NOT NULL,
	"hybrid" boolean NOT NULL,
	"position" integer NOT NULL,
	"status" text NOT NULL,
	"steps" jsonb NOT NULL,
	"confirmed_steps" jsonb NOT NULL,
	"notes" text NOT NULL,
	"elapsed_ms" double precision NOT NULL,
	"timer_started_at" text,
	"started_at" text,
	"finished_at" text,
	"case_result_id" text
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"status" text NOT NULL,
	"note" text,
	"outcome" jsonb,
	"created_at" text,
	"resolved_at" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_results" (
	"id" text PRIMARY KEY NOT NULL,
	"case_result_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"status" text NOT NULL,
	"action_taken" text,
	"assertions" jsonb NOT NULL,
	"latency_ms" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"release" text,
	"selection" jsonb NOT NULL,
	"matrix" jsonb NOT NULL,
	"retries" integer NOT NULL,
	"parallelism" integer NOT NULL,
	"mode" text NOT NULL,
	"unattended" text NOT NULL,
	"schedule" text,
	"exit_criteria" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"assignments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text,
	"updated_at" text
);
--> statement-breakpoint
CREATE TABLE "test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"plan_id" text,
	"trigger" text NOT NULL,
	"build_ref" text,
	"status" text NOT NULL,
	"started_at" text,
	"finished_at" text,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_setups" ADD CONSTRAINT "auth_setups_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_requirements" ADD CONSTRAINT "case_requirements_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_requirements" ADD CONSTRAINT "case_requirements_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heal_proposals" ADD CONSTRAINT "heal_proposals_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heal_proposals" ADD CONSTRAINT "heal_proposals_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_scripts" ADD CONSTRAINT "learned_scripts_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learned_scripts" ADD CONSTRAINT "learned_scripts_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_steps" ADD CONSTRAINT "shared_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_case_versions" ADD CONSTRAINT "test_case_versions_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_suite_id_suites_id_fk" FOREIGN KEY ("suite_id") REFERENCES "public"."suites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suites" ADD CONSTRAINT "suites_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suites" ADD CONSTRAINT "suites_parent_id_suites_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."suites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_data_sets" ADD CONSTRAINT "test_data_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_data_sets" ADD CONSTRAINT "test_data_sets_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variables" ADD CONSTRAINT "variables_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_results" ADD CONSTRAINT "case_results_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_results" ADD CONSTRAINT "case_results_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_step_result_id_step_results_id_fk" FOREIGN KEY ("step_result_id") REFERENCES "public"."step_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_results" ADD CONSTRAINT "defect_results_defect_id_defects_id_fk" FOREIGN KEY ("defect_id") REFERENCES "public"."defects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defect_results" ADD CONSTRAINT "defect_results_case_result_id_case_results_id_fk" FOREIGN KEY ("case_result_id") REFERENCES "public"."case_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_step_result_id_step_results_id_fk" FOREIGN KEY ("step_result_id") REFERENCES "public"."step_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_items" ADD CONSTRAINT "manual_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_items" ADD CONSTRAINT "manual_items_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_items" ADD CONSTRAINT "manual_items_case_id_test_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."test_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_results" ADD CONSTRAINT "step_results_case_result_id_case_results_id_fk" FOREIGN KEY ("case_result_id") REFERENCES "public"."case_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_plan_id_test_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."test_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_cases_suite_idx" ON "test_cases" USING btree ("suite_id");--> statement-breakpoint
CREATE INDEX "test_cases_external_ref_idx" ON "test_cases" USING btree ("project_id","external_ref");--> statement-breakpoint
CREATE INDEX "environments_project_idx" ON "environments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "suites_project_idx" ON "suites" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "artifacts_project_idx" ON "artifacts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "artifacts_result_idx" ON "artifacts" USING btree ("case_result_id");--> statement-breakpoint
CREATE INDEX "case_results_run_idx" ON "case_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "case_results_case_idx" ON "case_results" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "case_results_run_case_idx" ON "case_results" USING btree ("run_id","case_id","attempt");--> statement-breakpoint
CREATE INDEX "decision_records_step_idx" ON "decision_records" USING btree ("step_result_id");--> statement-breakpoint
CREATE INDEX "evidence_step_idx" ON "evidence" USING btree ("step_result_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","type");--> statement-breakpoint
CREATE INDEX "jobs_run_idx" ON "jobs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "manual_items_assignee_idx" ON "manual_items" USING btree ("assignee","status");--> statement-breakpoint
CREATE INDEX "manual_items_run_idx" ON "manual_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "review_items_project_status_idx" ON "review_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "step_results_case_idx" ON "step_results" USING btree ("case_result_id");--> statement-breakpoint
CREATE INDEX "test_runs_project_idx" ON "test_runs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "test_runs_project_started_idx" ON "test_runs" USING btree ("project_id","started_at");