-- ================================================================
-- WORLDBUILDING PIPELINE (existing)
-- ================================================================
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('room','weapon','armor','clothing','consumable','tool','furniture')),
  creator_name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  image_prompt TEXT,
  attributes TEXT NOT NULL,
  lore_notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','revision')),
  admin_notes TEXT,
  admin_id TEXT,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS committed_assets (
  id TEXT PRIMARY KEY,
  submission_id TEXT REFERENCES submissions(id),
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  attributes TEXT NOT NULL,
  region TEXT,
  committed_at INTEGER NOT NULL,
  committed_by TEXT NOT NULL
);

-- ================================================================
-- WORLD GEOGRAPHY
-- ================================================================
CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  city_state TEXT,
  parent_region_id TEXT REFERENCES regions(id),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_desc TEXT NOT NULL,
  long_desc TEXT,
  terrain_type TEXT NOT NULL DEFAULT 'plains'
    CHECK(terrain_type IN ('city','forest','dungeon','cave','ocean','river','plains',
                           'mountain','desert','tundra','ethereal','divine','void')),
  indoor INTEGER NOT NULL DEFAULT 0,
  safe_zone INTEGER NOT NULL DEFAULT 0,
  light_level TEXT NOT NULL DEFAULT 'normal'
    CHECK(light_level IN ('bright','normal','dim','dark','pitch_black')),
  item_cap INTEGER NOT NULL DEFAULT 50,
  region_id TEXT REFERENCES regions(id),
  asset_id TEXT REFERENCES committed_assets(id),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Directional exits between rooms (one row per direction per room)
CREATE TABLE IF NOT EXISTS room_exits (
  id TEXT PRIMARY KEY,
  from_room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  direction TEXT NOT NULL
    CHECK(direction IN ('n','s','e','w','ne','nw','se','sw','u','d','in','out')),
  to_room_id TEXT NOT NULL REFERENCES rooms(id),
  is_door INTEGER NOT NULL DEFAULT 0,
  is_locked INTEGER NOT NULL DEFAULT 0,
  door_name TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(from_room_id, direction)
);

-- ================================================================
-- ITEMS
-- ================================================================
CREATE TABLE IF NOT EXISTS item_templates (
  id TEXT PRIMARY KEY,
  asset_id TEXT REFERENCES committed_assets(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('weapon','armor','clothing','consumable','tool','furniture','misc')),
  description TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  is_stackable INTEGER NOT NULL DEFAULT 0,
  max_stack INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Items placed in rooms (ground layer)
CREATE TABLE IF NOT EXISTS room_items (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES item_templates(id),
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  is_persistent INTEGER NOT NULL DEFAULT 0,
  spawned_at INTEGER NOT NULL,
  despawn_at INTEGER,            -- NULL = persistent or no expiry
  stack_count INTEGER NOT NULL DEFAULT 1,
  overrides TEXT,                -- JSON attribute overrides per instance
  placed_by TEXT                 -- admin id if manually placed
);

-- Items in character inventories
CREATE TABLE IF NOT EXISTS character_items (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES item_templates(id),
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  equipped_slot TEXT,            -- NULL = in bag; slot name if equipped
  stack_count INTEGER NOT NULL DEFAULT 1,
  acquired_at INTEGER NOT NULL
);

-- ================================================================
-- PLAYERS & CHARACTERS
-- ================================================================
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'player' CHECK(role IN ('player','admin','developer')),
  created_at INTEGER NOT NULL,
  last_login INTEGER
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  race TEXT NOT NULL DEFAULT 'human'
    CHECK(race IN ('human','dwarf','atavian','rajamalan','xoran','grook','mhun','troll','horkval','siren')),
  class TEXT NOT NULL DEFAULT 'adventurer',
  level INTEGER NOT NULL DEFAULT 1,
  experience INTEGER NOT NULL DEFAULT 0,
  health INTEGER NOT NULL DEFAULT 100,
  max_health INTEGER NOT NULL DEFAULT 100,
  mana INTEGER NOT NULL DEFAULT 100,
  max_mana INTEGER NOT NULL DEFAULT 100,
  endurance INTEGER NOT NULL DEFAULT 100,
  max_endurance INTEGER NOT NULL DEFAULT 100,
  current_room_id TEXT REFERENCES rooms(id),
  gold INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active INTEGER
);

-- ================================================================
-- NPCs
-- ================================================================
CREATE TABLE IF NOT EXISTS npcs (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  description TEXT,
  race TEXT NOT NULL DEFAULT 'human',
  role TEXT NOT NULL DEFAULT 'citizen',
  dialogue TEXT NOT NULL DEFAULT '[]',  -- JSON array of {keywords[], response}
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_npcs_room ON npcs(room_id, is_active);

-- ================================================================
-- ADMIN AUDIT LOG
-- ================================================================
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  data TEXT,
  created_at INTEGER NOT NULL
);

-- ================================================================
-- INDEXES
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_submissions_status    ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_type      ON submissions(type);
CREATE INDEX IF NOT EXISTS idx_committed_type        ON committed_assets(type);
CREATE INDEX IF NOT EXISTS idx_room_exits_from       ON room_exits(from_room_id);
CREATE INDEX IF NOT EXISTS idx_room_exits_to         ON room_exits(to_room_id);
CREATE INDEX IF NOT EXISTS idx_room_items_room       ON room_items(room_id);
CREATE INDEX IF NOT EXISTS idx_room_items_despawn    ON room_items(despawn_at);
CREATE INDEX IF NOT EXISTS idx_characters_room       ON characters(current_room_id);
CREATE INDEX IF NOT EXISTS idx_characters_account    ON characters(account_id);
CREATE INDEX IF NOT EXISTS idx_char_items_character  ON character_items(character_id);
