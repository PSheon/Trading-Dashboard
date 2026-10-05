CREATE TABLE "account_deletion_markers" (
	"digest" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_deletion_markers_digest_check" CHECK ("account_deletion_markers"."digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "account_deletion_markers_deleted_idx" ON "account_deletion_markers" USING btree ("deleted_at");