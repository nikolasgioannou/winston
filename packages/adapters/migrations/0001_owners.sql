CREATE TABLE "winston"."owners" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
