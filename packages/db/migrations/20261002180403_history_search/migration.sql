ALTER TABLE "audit_log" ADD COLUMN "history_id" text;--> statement-breakpoint
-- Rows written before history search get an id in the TypeID shape (hist_ and 26 base32 characters, the first at most 7); new rows get real ones from the app.
UPDATE "audit_log" SET "history_id" = 'hist_0' || substr(md5('audit_log:' || "id"::text), 1, 25) WHERE "history_id" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "history_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, action || ' ' || summary || ' ' || coalesce(target_ref, '') || ' ' || coalesce(error, '')) || to_tsvector('simple'::regconfig, action || ' ' || summary || ' ' || coalesce(target_ref, '') || ' ' || coalesce(error, ''))) STORED;--> statement-breakpoint
ALTER TABLE "inbound_items" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (jsonb_to_tsvector('english'::regconfig, payload, '["string"]') || jsonb_to_tsvector('simple'::regconfig, payload, '["string"]')) STORED;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, text) || to_tsvector('simple'::regconfig, text)) STORED;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_history_id_key" UNIQUE("history_id");--> statement-breakpoint
CREATE INDEX "audit_log_tsv_index" ON "audit_log" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "inbound_items_user_id_occurred_at_index" ON "inbound_items" ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "inbound_items_tsv_index" ON "inbound_items" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "outbound_messages_user_id_sent_at_index" ON "outbound_messages" ("user_id","sent_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_tsv_index" ON "outbound_messages" USING gin ("tsv");