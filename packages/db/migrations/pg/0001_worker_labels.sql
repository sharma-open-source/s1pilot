ALTER TABLE "jobs" ADD COLUMN "labels" jsonb;--> statement-breakpoint
ALTER TABLE "test_plans" ADD COLUMN "worker_labels" jsonb DEFAULT '[]'::jsonb NOT NULL;