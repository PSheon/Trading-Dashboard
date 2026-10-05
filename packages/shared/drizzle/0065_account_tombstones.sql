ALTER TABLE "copy_execution_accounts" ADD COLUMN "signer_detached_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "users_tombstone_idx" ON "users" USING btree ("deleted_at") WHERE "users"."deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "copy_execution_accounts" ADD CONSTRAINT "copy_execution_accounts_signer_detached_check" CHECK ("copy_execution_accounts"."signer_detached_at" is null or ("copy_execution_accounts"."signer_attached_at" is not null and "copy_execution_accounts"."signer_detached_at" >= "copy_execution_accounts"."signer_attached_at"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tombstone_check" CHECK ("users"."deleted_at" is null or ("users"."privy_user_id" ~ '^deleted:[0-9a-f-]{36}$' and "users"."email" is null
    and "users"."wallet_address" is null and "users"."embedded_wallet_address" is null and "users"."display_name" is null and "users"."role" = 'user'
    and "users"."disabled_at" is not null));