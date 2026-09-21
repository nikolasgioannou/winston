import { boolean, index, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const schema = pgSchema("winston_auth");
const date = (name: string) => timestamp(name, { withTimezone: true }).notNull();

export const user = schema.table("users", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: date("created_at"),
  updatedAt: date("updated_at"),
});

export const session = schema.table(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: date("expires_at"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: date("created_at"),
    updatedAt: date("updated_at"),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export const account = schema.table(
  "accounts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: date("created_at"),
    updatedAt: date("updated_at"),
  },
  (table) => [
    index("accounts_user_idx").on(table.userId),
    uniqueIndex("accounts_provider_identity_idx").on(table.providerId, table.accountId),
  ],
);

export const verification = schema.table(
  "verifications",
  {
    id: uuid("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: date("expires_at"),
    createdAt: date("created_at"),
    updatedAt: date("updated_at"),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);
