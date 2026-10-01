CREATE TABLE "calendar_channels" (
	"id" text PRIMARY KEY,
	"connection_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "calendar_channels_connection_id_index" ON "calendar_channels" ("connection_id");--> statement-breakpoint
ALTER TABLE "calendar_channels" ADD CONSTRAINT "calendar_channels_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;