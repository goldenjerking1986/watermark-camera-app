ALTER TABLE folders ADD COLUMN owner_key TEXT;
--> statement-breakpoint
CREATE INDEX folders_owner_key_idx ON folders(owner_key);
--> statement-breakpoint
CREATE TABLE device_links (
  viewer_key TEXT PRIMARY KEY NOT NULL,
  account_key TEXT NOT NULL,
  linked_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE pairing_sessions (
  token TEXT PRIMARY KEY NOT NULL,
  account_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
--> statement-breakpoint
CREATE INDEX pairing_sessions_expires_at_idx ON pairing_sessions(expires_at);
