CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('room','weapon','armor','clothing','consumable','tool','furniture')),
  creator_name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  image_prompt TEXT,
  attributes TEXT NOT NULL, -- JSON
  lore_notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','revision')),
  admin_notes TEXT,
  admin_id TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS committed_assets (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  attributes TEXT NOT NULL, -- JSON
  region TEXT,
  committed_at INTEGER NOT NULL,
  committed_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_type ON submissions(type);
CREATE INDEX IF NOT EXISTS idx_committed_type ON committed_assets(type);
