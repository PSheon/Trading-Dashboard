CREATE TABLE "favorite_group_members" (
	"user_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	CONSTRAINT "favorite_group_members_group_id_chain_address_pk" PRIMARY KEY("group_id","chain","address")
);
--> statement-breakpoint
CREATE TABLE "favorite_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "favorite_groups_owner_id_uq" ON "favorite_groups" USING btree ("user_id","id");--> statement-breakpoint
ALTER TABLE "favorite_group_members" ADD CONSTRAINT "favorite_group_members_user_id_group_id_favorite_groups_user_id_id_fk" FOREIGN KEY ("user_id","group_id") REFERENCES "public"."favorite_groups"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite_group_members" ADD CONSTRAINT "favorite_group_members_user_id_chain_address_user_favorites_user_id_chain_address_fk" FOREIGN KEY ("user_id","chain","address") REFERENCES "public"."user_favorites"("user_id","chain","address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favorite_groups" ADD CONSTRAINT "favorite_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "favorite_group_members_owner_idx" ON "favorite_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "favorite_groups_owner_name_uq" ON "favorite_groups" USING btree ("user_id",lower("name"));