import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable(
  "folders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    ownerKey: text("owner_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("folders_owner_key_idx").on(table.ownerKey)],
);

export const photos = sqliteTable(
  "photos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    folderId: integer("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    blobKey: text("blob_key").notNull(),
    filename: text("filename").notNull(),
    note: text("note").notNull().default(""),
    unitName: text("unit_name").notNull().default(""),
    locationText: text("location_text").notNull().default(""),
    photographer: text("photographer").notNull().default(""),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("photos_folder_id_idx").on(table.folderId),
    index("photos_captured_at_idx").on(table.capturedAt),
  ],
);

export const deviceLinks = sqliteTable("device_links", {
  viewerKey: text("viewer_key").primaryKey(),
  accountKey: text("account_key").notNull(),
  linkedAt: integer("linked_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const pairingSessions = sqliteTable(
  "pairing_sessions",
  {
    token: text("token").primaryKey(),
    accountKey: text("account_key").notNull(),
    createdBy: text("created_by").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("pairing_sessions_expires_at_idx").on(table.expiresAt)],
);

export const captureAssignments = sqliteTable(
  "capture_assignments",
  {
    token: text("token").primaryKey(),
    folderId: integer("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    accountKey: text("account_key").notNull(),
    unitName: text("unit_name").notNull(),
    locationText: text("location_text").notNull(),
    photographer: text("photographer").notNull(),
    publicEntryUrl: text("public_entry_url").notNull().default(""),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("capture_assignments_account_key_idx").on(table.accountKey),
    index("capture_assignments_folder_id_idx").on(table.folderId),
  ],
);
