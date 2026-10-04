CREATE TYPE "site_access" AS ENUM('private');--> statement-breakpoint
CREATE TABLE "site_versions" (
	"id" text PRIMARY KEY,
	"site_id" text NOT NULL,
	"number" integer NOT NULL,
	"bundle_key" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_versions_site_id_number_unique" UNIQUE("site_id","number")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"name" text NOT NULL UNIQUE,
	"access" "site_access" DEFAULT 'private'::"site_access" NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"database_id" text,
	"current_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_versions" ADD CONSTRAINT "site_versions_site_id_sites_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;