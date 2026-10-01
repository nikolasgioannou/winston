CREATE TYPE "audit_outcome" AS ENUM('pending', 'ok', 'error');--> statement-breakpoint
CREATE TYPE "external_ref_kind" AS ENUM('message', 'thread', 'draft', 'attachment', 'calendarEvent');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"run_id" text,
	"connection_id" text,
	"action" text NOT NULL,
	"target_ref" text,
	"summary" text NOT NULL,
	"request" jsonb NOT NULL,
	"outcome" "audit_outcome" DEFAULT 'pending'::"audit_outcome" NOT NULL,
	"error" text,
	"result_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "external_refs" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"kind" "external_ref_kind" NOT NULL,
	"provider_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_refs_connection_id_kind_provider_id_unique" UNIQUE("connection_id","kind","provider_id")
);
--> statement-breakpoint
CREATE INDEX "audit_log_user_id_created_at_index" ON "audit_log" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_connection_id_created_at_index" ON "audit_log" ("connection_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "external_refs" ADD CONSTRAINT "external_refs_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "external_refs" ADD CONSTRAINT "external_refs_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;