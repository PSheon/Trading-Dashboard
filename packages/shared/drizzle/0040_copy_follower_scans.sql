CREATE TABLE "copy_follower_scans" (
	"account_id" text PRIMARY KEY NOT NULL,
	"through" bigint,
	"scan_state" jsonb,
	"claim_token" text,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issue" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copy_follower_scans_through_check" CHECK ("copy_follower_scans"."through" is null or ("copy_follower_scans"."through" >= 0 and "copy_follower_scans"."through" <= 9007199254740991))
);
--> statement-breakpoint
ALTER TABLE "copy_follower_scans" ADD CONSTRAINT "copy_follower_scans_account_id_copy_execution_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."copy_execution_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copy_follower_scans_due_idx" ON "copy_follower_scans" USING btree ("next_run_at");