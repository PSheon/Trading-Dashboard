CREATE TABLE "user_favorite_group_members" (
	"group_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"chain" text DEFAULT 'hyperliquid' NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorite_group_members_group_id_address_pk" PRIMARY KEY("group_id","address")
);
--> statement-breakpoint
CREATE TABLE "user_favorite_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_favorite_group_members" ADD CONSTRAINT "user_favorite_group_members_group_id_user_favorite_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_favorite_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorite_group_members" ADD CONSTRAINT "user_favorite_group_members_favorite_fk" FOREIGN KEY ("user_id","chain","address") REFERENCES "public"."user_favorites"("user_id","chain","address") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorite_groups" ADD CONSTRAINT "user_favorite_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_favorite_group_members_user_idx" ON "user_favorite_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_favorite_groups_user_name_idx" ON "user_favorite_groups" USING btree ("user_id","name");