CREATE TABLE "calendar_event_snapshots" (
	"connection_id" text,
	"provider_id" text,
	"snapshot" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_snapshots_pkey" PRIMARY KEY("connection_id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_event_snapshots" ADD CONSTRAINT "calendar_event_snapshots_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;