CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  blob_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  captured_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX photos_folder_id_idx ON photos(folder_id);
--> statement-breakpoint
CREATE INDEX photos_captured_at_idx ON photos(captured_at);