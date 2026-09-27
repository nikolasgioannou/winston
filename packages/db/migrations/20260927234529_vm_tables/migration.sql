CREATE TYPE "vm_provider" AS ENUM('docker', 'ec2');--> statement-breakpoint
CREATE TYPE "vm_state" AS ENUM('requested', 'provisioning', 'registering', 'ready', 'unhealthy', 'updating', 'failed', 'terminating', 'terminated');--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"vm_path" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"telegram_file_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vms" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL UNIQUE,
	"provider" "vm_provider" NOT NULL,
	"instance_id" text,
	"data_volume_id" text,
	"state" "vm_state" DEFAULT 'requested'::"vm_state" NOT NULL,
	"token_hash" text,
	"registration_token_hash" text,
	"cli_version" text,
	"winstond_version" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "files_user_id_index" ON "files" ("user_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "vms" ADD CONSTRAINT "vms_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;