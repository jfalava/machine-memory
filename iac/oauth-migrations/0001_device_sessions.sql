CREATE TABLE device_sessions (
  id TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  device_code_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  request TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approving', 'approved', 'denied', 'failed')),
  authorization_code TEXT
);
CREATE INDEX device_sessions_expiry ON device_sessions(expires_at);
