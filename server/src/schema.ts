import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const folders = sqliteTable("folders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

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
