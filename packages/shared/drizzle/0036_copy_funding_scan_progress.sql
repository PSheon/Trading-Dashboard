ALTER TABLE "copy_funding_operations" ADD COLUMN "scan_state" jsonb;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD COLUMN "scan_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_funding_operations" ADD CONSTRAINT "copy_funding_scan_revision_check" CHECK ("copy_funding_operations"."scan_revision" >= 0);