import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || join(__dir, 'worldbuilding.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const schema = readFileSync(join(__dir, 'schema.sql'), 'utf8');
    db.exec(schema);
    runMigrations(db);
  }
  return db;
}

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, ran_at INTEGER)`);

  const migrations = {
    'combat_v1': () => {
      const cols = [
        'ALTER TABLE npcs ADD COLUMN is_combatant INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE npcs ADD COLUMN max_health INTEGER NOT NULL DEFAULT 100',
        'ALTER TABLE npcs ADD COLUMN attack_power INTEGER NOT NULL DEFAULT 10',
        'ALTER TABLE npcs ADD COLUMN armor INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE npcs ADD COLUMN experience_reward INTEGER NOT NULL DEFAULT 25',
        'ALTER TABLE npcs ADD COLUMN respawn_seconds INTEGER NOT NULL DEFAULT 300',
        'ALTER TABLE npcs ADD COLUMN gold_reward INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE characters ADD COLUMN kills INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE characters ADD COLUMN deaths INTEGER NOT NULL DEFAULT 0',
      ];
      for (const sql of cols) { try { db.exec(sql); } catch { /* column exists */ } }
    },
    'item_type_expand_v1': () => {
      // item_templates CHECK constraint can't be easily altered — handled at app level
    },
    'room_image_v1': () => {
      try { db.exec('ALTER TABLE rooms ADD COLUMN image_url TEXT'); } catch { /* exists */ }
    },
    'npc_portrait_v1': () => {
      try { db.exec('ALTER TABLE npcs ADD COLUMN image_url TEXT'); } catch { /* exists */ }
    },
  };

  for (const [name, run] of Object.entries(migrations)) {
    if (!db.prepare('SELECT name FROM _migrations WHERE name = ?').get(name)) {
      run();
      db.prepare('INSERT INTO _migrations (name, ran_at) VALUES (?, ?)').run(name, Date.now());
    }
  }
}
