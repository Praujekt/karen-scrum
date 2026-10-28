CREATE TABLE IF NOT EXISTS reminder_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  config_revision INTEGER NOT NULL DEFAULT 0,
  snapshot_revision INTEGER NOT NULL DEFAULT 0,
  snapshot_workspace_version INTEGER NOT NULL DEFAULT 0,
  snapshot_updated_at TEXT,
  last_run TEXT,
  last_error TEXT
);

INSERT OR IGNORE INTO reminder_state (id, config_json, snapshot_json)
VALUES (1, '{"enabled":false,"channels":[],"email":"","phone":"","daysAhead":3,"time":"09:00","includeOverdue":true}', '{"caseCount":0,"caseDueDates":[],"taskDueDates":[]}');

CREATE TABLE IF NOT EXISTS delivery_claims (
  day TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  status TEXT NOT NULL CHECK (status IN ('attempted', 'accepted', 'failed')),
  attempted_at TEXT NOT NULL,
  accepted_at TEXT,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  PRIMARY KEY (day, channel)
);

-- The opaque client-encrypted workspace envelope is stored in R2. D1 keeps a
-- small atomic version pointer, avoiding D1's 2 MB row/string limit. The Worker
-- never receives the encryption password or decryption key.
CREATE TABLE IF NOT EXISTS encrypted_workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  payload_key TEXT
);
INSERT OR IGNORE INTO encrypted_workspace (id, version) VALUES (1, 0);

-- Ciphertext identities/quota reservations are permanent until the owner
-- deliberately resets storage; orphan uploads are never deleted automatically.
CREATE TABLE IF NOT EXISTS encrypted_files (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 16),
  created_at TEXT NOT NULL
);
